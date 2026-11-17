import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  TERMS_DESCRIPTION,
  TERMS_PROMPT_SNIPPET,
  TermsSchema,
  cleanArgs,
  createTermsTool,
  localDate,
  runTerms,
  toToolResult,
  validate,
  type TermsDependencies,
  type TermsParams,
} from "../lib/tool.ts";
import { TermsError, type WorkspaceAccess } from "../lib/workspace.ts";

const SPEC = readFileSync(new URL("../specs/terms-tool.md", import.meta.url), "utf8");
const ROOT = "/repo";

/** A workspace with fixed contents that records its calls and its writes. */
function fakeWorkspace(
  options: {
    terms?: string;
    documents?: Record<string, string>;
    externalOwners?: Record<string, string>;
    gitFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const writes: { root: string; text: string }[] = [];
  const io: WorkspaceAccess = {
    async root() {
      calls.push("root");
      if (options.gitFails === true) throw new TermsError("git failed: boom");
      return ROOT;
    },
    async documents() {
      calls.push("documents");
      return new Map(Object.entries(options.documents ?? {}));
    },
    async document(_root, path) {
      calls.push("document");
      return (options.documents ?? {})[path];
    },
    async externalOwner(_root, path) {
      calls.push(`externalOwner:${path}`);
      return (options.externalOwners ?? {})[path];
    },
    async readTerms() {
      calls.push("readTerms");
      return options.terms === undefined ? undefined : new TextEncoder().encode(options.terms);
    },
    async writeTerms(root, text) {
      writes.push({ root, text });
    },
    async realpath(path) {
      return path;
    },
  };
  return { io, calls, writes };
}

function depsOver(io: WorkspaceAccess, today = "2026-11-14"): TermsDependencies {
  return { cwd: ROOT, io, today: () => today };
}

const RENDERED = `  - id: rendered-view
    label: rendered view
    meaning: How a document looks once rendered.
    owner: docs/view.md
    group: Rendering
    key: confusable
    status: active
    reject:
      - html preview
    history:
      - { date: 2026-01-02, op: add }
`;

const TERMS_FILE = `  - id: terms-file
    label: terms file
    meaning: The workspace thesaurus file.
    owner: docs/view.md
    group: Files
    key: confusable
    status: active
    history:
      - { date: 2026-01-02, op: add }
`;

const RELATED = `  - id: rendered-view
    label: rendered view
    meaning: How a terms file view looks once rendered.
    owner: docs/view.md
    group: Rendering
    key: confusable
    status: active
    reject:
      - html preview
    distinguish:
      - terms-file
      - ghost-id
    history:
      - { date: 2026-01-02, op: add }
`;

const BASE = `terms:\n${RENDERED}`;
const RELATED_FILE = `terms:\n${RELATED}${TERMS_FILE}`;
const BOTH = `terms:\n${RENDERED}${TERMS_FILE}`;

/** A deprecated entry whose id sorts before the other entries. */
const DEPRECATED_VIEW = `  - id: old-view
    label: old view
    meaning: An old way to view.
    owner: docs/view.md
    group: Rendering
    key: confusable
    status: deprecated
    reason: out-of-scope
    history:
      - { date: 2026-01-02, op: add }
      - { date: 2026-02-02, op: deprecate, reason: out-of-scope }
`;

const WITH_DEPRECATED_VIEW = `terms:\n${DEPRECATED_VIEW}${RENDERED}${TERMS_FILE}`;

/** An entry owned by another document, in a group whose name needs normalising. */
const OTHER_VIEW = `  - id: other-view
    label: other view
    meaning: A view described elsewhere.
    owner: docs/other.md
    group: Rendering  Views
    key: shared
    status: active
    history:
      - { date: 2026-01-02, op: add }
`;

/** Entries that differ in status, key, group, and owner, in ascending id order. */
const FILTERABLE = `terms:\n${DEPRECATED_VIEW}${OTHER_VIEW}${RENDERED}${TERMS_FILE}`;

const VIEW = "# View\n\nThe rendered view shows the page.\n";
const OTHER = "Use the html preview here.\n";
const DOCUMENTS = { "docs/view.md": VIEW, "docs/other.md": OTHER };

const P001_TEXT = '"html preview" is rejected: use "rendered view" (rendered-view)';

test("1.3 texts: the description, the prompt snippet, and the field descriptions are the specified texts", () => {
  const tool = createTermsTool(fakeWorkspace().io);
  assert.equal(tool.name, "Terms");
  assert.equal(tool.label, "Terms");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.description, TERMS_DESCRIPTION);
  assert.equal(tool.promptSnippet, TERMS_PROMPT_SNIPPET);
  assert.ok(SPEC.includes(TERMS_DESCRIPTION), "description is the text of terms-tool.md");
  assert.ok(SPEC.includes(TERMS_PROMPT_SNIPPET), "snippet is the text of terms-tool.md");
});

test("1.1 schema: object, additionalProperties false, action required, fields as specified", () => {
  const schema = JSON.parse(JSON.stringify(TermsSchema)) as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["action"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(properties), [
    "action",
    "query",
    "id",
    "label",
    "meaning",
    "owner",
    "group",
    "key",
    "status",
    "reject",
    "distinguish",
    "addReject",
    "removeReject",
    "addDistinguish",
    "removeDistinguish",
    "forms",
    "into",
    "reason",
    "replacedBy",
    "path",
    "changes",
  ]);
  assert.deepEqual(properties.action?.anyOf, [
    { const: "find", type: "string" },
    { const: "check", type: "string" },
    { const: "add", type: "string" },
    { const: "update", type: "string" },
    { const: "rename", type: "string" },
    { const: "merge", type: "string" },
    { const: "split", type: "string" },
    { const: "deprecate", type: "string" },
    { const: "reown", type: "string" },
    { const: "import", type: "string" },
  ]);
  for (const field of [
    "query",
    "id",
    "meaning",
    "path",
    "reject",
    "addReject",
    "into",
    "replacedBy",
  ]) {
    const admitted = properties[field]?.anyOf;
    assert.ok(Array.isArray(admitted), `${field} is a union`);
    assert.ok(
      admitted.some(
        (member) =>
          typeof member === "object" &&
          member !== null &&
          "type" in member &&
          member.type === "null",
      ),
      `${field} admits null`,
    );
  }
});

test("1.1 schema: each property carries its specified description, verbatim from the spec", () => {
  const schema = JSON.parse(JSON.stringify(TermsSchema)) as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const expected: Record<string, string> = {
    action:
      "find: look entries up. check: report findings. add, update, rename, merge, split, deprecate, reown, import: change the terms file.",
    query:
      "For find: text to look for in ids, labels, reject phrases, forms, and meanings, ignoring case; optional when a filter (status, key, group, owner) is given.",
    id: 'The entry\'s id, a lowercase slug such as "rendered-view"; for add, the new id.',
    label: "For add and rename: the one preferred term, in base form, lowercase unless a name.",
    meaning: "For add (required) or update (optional): one sentence saying what the concept is.",
    owner:
      "For add and reown: the owner path of the Markdown file that defines the term, relative to the workspace root; leading ../ is allowed. For find: list only entries with this owner.",
    group:
      "For add: the group the entry is listed under. For find: list only entries in this group.",
    key: "For add (required) or update (optional): shared for use by two or more documents, confusable for one or more, local for use only by the owner. For find: list only entries with this key.",
    status:
      "For find: list only active or only deprecated entries. For update: active returns a deprecated entry to active; the other update fields apply as well.",
    addReject: "For update: specific reject phrases to add; already-present phrases are refused.",
    removeReject: "For update: reject phrases to remove; missing phrases are refused.",
    addDistinguish:
      "For update: existing ids to distinguish from, on both entries; self and existing relations are refused.",
    removeDistinguish:
      "For update: ids to stop distinguishing from, on both entries; missing relations are refused.",
    reject:
      "For add: specific phrases that must not be used for this concept; never ordinary words.",
    distinguish: "For add: ids of neighbouring concepts a reader could confuse with this one.",
    forms:
      "For add and rename: irregular inflections of the label only; regular plurals are derived.",
    into: "For merge: the one id that absorbs the entry. For split: the two or more ids that replace it; add them first.",
    reason: "For deprecate: renamed (with one replacedBy) or out-of-scope (with none).",
    replacedBy: "For deprecate: the id of the entry that replaces it.",
    path: "For import: the workspace-relative path of the Markdown thesaurus.",
    changes:
      "For check: the changed files, each { path, before, from }: before is the text before the change, null for a new file; from is the old path of a moved file.",
  };
  for (const [field, description] of Object.entries(expected)) {
    assert.equal(properties[field]?.description, description, field);
    assert.ok(SPEC.includes(description), `${field} description is in terms-tool.md`);
  }
});

test("1.1 schema: status admits active or deprecated, and find accepts it", () => {
  const schema = JSON.parse(JSON.stringify(TermsSchema)) as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.status?.anyOf, [
    { const: "active", type: "string" },
    { const: "deprecated", type: "string" },
    { type: "null" },
  ]);
  assert.equal(validate(cleanArgs({ action: "update", id: "a", status: "active" })), undefined);
  assert.equal(validate(cleanArgs({ action: "find", status: "active" })), undefined);
  assert.equal(validate(cleanArgs({ action: "find", status: "deprecated" })), undefined);
  assert.equal(
    validate(
      cleanArgs({
        action: "add",
        id: "a",
        label: "l",
        meaning: "m",
        owner: "o.md",
        group: "g",
        key: "shared",
        status: "active",
      }),
    ),
    "status is not valid for action add",
  );
});

test("1.2 validation: the first failing check gives its text", async () => {
  const cases: [TermsParams, string][] = [
    [{ action: "find", query: "x", id: "a" }, "id is not valid for action find"],
    [{ action: "find" }, "action find requires query or a filter"],
    [{ action: "find", query: null }, "action find requires query or a filter"],
    [{ action: "check", query: "x" }, "query is not valid for action check"],
    [
      { action: "add", id: "a", label: "l", meaning: "m", owner: "o.md", group: "g" },
      "action add requires key",
    ],
    [
      { action: "add", label: "l", meaning: "m", owner: "o.md", group: "g", key: "shared" },
      "action add requires id",
    ],
    [{ action: "find", query: "   " }, "query must be a non-empty string"],
    [{ action: "rename", id: " ", label: "l" }, "id must be a non-empty string"],
    [
      {
        action: "add",
        id: "a",
        label: "l",
        meaning: "m",
        owner: "o.md",
        group: "g",
        key: "shared",
        reject: ["ok", " "],
      },
      "reject must hold non-empty strings",
    ],
    [{ action: "merge", id: "a", into: [] }, "merge takes exactly one id in into"],
    [{ action: "merge", id: "a", into: ["b", "c"] }, "merge takes exactly one id in into"],
    [
      { action: "import", path: "docs/t.md", id: "x", label: "y" },
      "id is not valid for action import",
    ],
    [{ action: "deprecate", id: "a" }, "action deprecate requires reason"],
    ...(["addReject", "removeReject", "addDistinguish", "removeDistinguish"] as const).map(
      (field) =>
        [
          {
            action: "add",
            id: "a",
            label: "l",
            meaning: "m",
            owner: "o.md",
            group: "g",
            key: "shared",
            [field]: ["x"],
          },
          `${field} is not valid for action add`,
        ] as [TermsParams, string],
    ),
    // The table order decides: `id` is checked before `into`.
    [{ action: "merge", into: ["b"] }, "action merge requires id"],
    // Check 1 comes before check 3: a non-accepted empty field is reported as not valid.
    [{ action: "find", query: "x", id: "" }, "id is not valid for action find"],
  ];
  for (const [params, message] of cases) {
    const { io, calls } = fakeWorkspace({ terms: BASE });
    const outcome = await runTerms(params, depsOver(io));
    assert.deepEqual(outcome, { isError: true, text: message }, JSON.stringify(params));
    assert.deepEqual(calls, [], "no file is read before validation");
  }
});

test("1.2 validation: a null field counts as absent and strings are trimmed", async () => {
  // `id` and `reject` are null, so they are absent and the find is accepted; the query is trimmed.
  const found = await runTerms(
    { action: "find", query: "  rendered   view ", id: null, reject: null },
    depsOver(fakeWorkspace({ terms: BASE }).io),
  );
  assert.ok(!found.isError && found.details.action === "find");
  assert.deepEqual(found.details.ids, ["rendered-view"]);
  assert.ok(found.text.startsWith('1 entries match "rendered view":'), found.text);

  // The one id of `into` is trimmed before it is used.
  const merged = await runTerms(
    { action: "merge", id: "terms-file", into: [" rendered-view "] },
    depsOver(fakeWorkspace({ terms: BOTH, documents: DOCUMENTS }).io),
  );
  assert.equal(merged.isError, false, merged.text);
  assert.ok(merged.text.startsWith("Merged terms-file into rendered-view"), merged.text);
});

test("1.2 validation: a rejected call reads no file and writes none", async () => {
  const { io, calls, writes } = fakeWorkspace({ terms: BASE });
  const outcome = await runTerms({ action: "find" }, depsOver(io));
  assert.equal(outcome.isError, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
});

test("3.1 find: the matching entries, related entries, and the text of a call", async () => {
  const { io } = fakeWorkspace({ terms: RELATED_FILE, documents: DOCUMENTS });
  const outcome = await runTerms({ action: "find", query: "  terms   file " }, depsOver(io));
  assert.deepEqual(outcome, {
    isError: false,
    text: [
      '2 entries match "terms file":',
      'terms-file "terms file" · active · confusable · Files · owner docs/view.md',
      "  meaning: The workspace thesaurus file.",
      '  distinguish: rendered-view "rendered view"',
      'rendered-view "rendered view" · active · confusable · Rendering · owner docs/view.md',
      "  meaning: How a terms file view looks once rendered.",
      '  reject: "html preview"',
      '  distinguish: ghost-id (not an entry), terms-file "terms file"',
    ].join("\n"),
    details: { action: "find", ids: ["terms-file", "rendered-view"] },
  });
});

test("3.1 find: a match by reject phrase, ignoring case", async () => {
  const { io } = fakeWorkspace({ terms: BASE });
  const outcome = await runTerms({ action: "find", query: "PREVIEW" }, depsOver(io));
  assert.deepEqual(outcome, {
    isError: false,
    text: [
      '1 entries match "PREVIEW":',
      'rendered-view "rendered view" · active · confusable · Rendering · owner docs/view.md',
      "  meaning: How a document looks once rendered.",
      '  reject: "html preview"',
    ].join("\n"),
    details: { action: "find", ids: ["rendered-view"] },
  });
});

test("3.1 find: no match, and the T001 line after it", async () => {
  const { io } = fakeWorkspace({ terms: BASE });
  assert.deepEqual(await runTerms({ action: "find", query: "zebra" }, depsOver(io)), {
    isError: false,
    text: 'No entry matches "zebra"',
    details: { action: "find", ids: [] },
  });

  const broken = `${BASE}  - id: zz-broken
    label: broken term
    owner: docs/view.md
    group: Rendering
    key: confusable
    status: active
    history:
      - { date: 2026-01-02, op: add }
`;
  const withT001 = await runTerms(
    { action: "find", query: "zebra" },
    depsOver(fakeWorkspace({ terms: broken }).io),
  );
  assert.deepEqual(withT001, {
    isError: false,
    text: 'No entry matches "zebra"\n.pi/pi-dent/terms.yaml has 1 T001 findings; run check',
    details: { action: "find", ids: [] },
  });

  const matchWithT001 = await runTerms(
    { action: "find", query: "rendered" },
    depsOver(fakeWorkspace({ terms: broken }).io),
  );
  assert.deepEqual(matchWithT001, {
    isError: false,
    text: [
      '1 entries match "rendered":',
      'rendered-view "rendered view" · active · confusable · Rendering · owner docs/view.md',
      "  meaning: How a document looks once rendered.",
      '  reject: "html preview"',
      ".pi/pi-dent/terms.yaml has 1 T001 findings; run check",
    ].join("\n"),
    details: { action: "find", ids: ["rendered-view"] },
  });
});

test("3.1 find: a call lists no document", async () => {
  const { io, calls } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  await runTerms({ action: "find", query: "preview" }, depsOver(io));
  assert.deepEqual(calls, ["root", "readTerms"]);
});

test("3.1 find: a status filter alone lists the entries it admits", async () => {
  const { io } = fakeWorkspace({ terms: FILTERABLE });
  assert.deepEqual(await runTerms({ action: "find", status: "deprecated" }, depsOver(io)), {
    isError: false,
    text: [
      "1 entries match status deprecated:",
      'old-view "old view" · deprecated · confusable · Rendering · owner docs/view.md',
      "  meaning: An old way to view.",
      "  reason: out-of-scope",
    ].join("\n"),
    details: { action: "find", ids: ["old-view"] },
  });

  // Without a query the entries come in plain ascending id order.
  assert.deepEqual(await runTerms({ action: "find", status: "active" }, depsOver(io)), {
    isError: false,
    text: [
      "3 entries match status active:",
      'other-view "other view" · active · shared · Rendering  Views · owner docs/other.md',
      "  meaning: A view described elsewhere.",
      'rendered-view "rendered view" · active · confusable · Rendering · owner docs/view.md',
      "  meaning: How a document looks once rendered.",
      '  reject: "html preview"',
      'terms-file "terms file" · active · confusable · Files · owner docs/view.md',
      "  meaning: The workspace thesaurus file.",
    ].join("\n"),
    details: { action: "find", ids: ["other-view", "rendered-view", "terms-file"] },
  });
});

test("3.1 find: a query and a filter hold together, label-equal first", async () => {
  // Both entries share the key; the label-equal one comes first though its id sorts later.
  const related = fakeWorkspace({ terms: RELATED_FILE });
  assert.deepEqual(
    await runTerms(
      { action: "find", query: "terms file", key: "confusable" },
      depsOver(related.io),
    ),
    {
      isError: false,
      text: [
        '2 entries match "terms file", key confusable:',
        'terms-file "terms file" · active · confusable · Files · owner docs/view.md',
        "  meaning: The workspace thesaurus file.",
        '  distinguish: rendered-view "rendered view"',
        'rendered-view "rendered view" · active · confusable · Rendering · owner docs/view.md',
        "  meaning: How a terms file view looks once rendered.",
        '  reject: "html preview"',
        '  distinguish: ghost-id (not an entry), terms-file "terms file"',
      ].join("\n"),
      details: { action: "find", ids: ["terms-file", "rendered-view"] },
    },
  );

  // A query that only the deprecated entry carries leaves one match.
  const { io } = fakeWorkspace({ terms: FILTERABLE });
  const deprecated = await runTerms(
    { action: "find", query: "view", status: "deprecated" },
    depsOver(io),
  );
  assert.deepEqual(deprecated, {
    isError: false,
    text: [
      '1 entries match "view", status deprecated:',
      'old-view "old view" · deprecated · confusable · Rendering · owner docs/view.md',
      "  meaning: An old way to view.",
      "  reason: out-of-scope",
    ].join("\n"),
    details: { action: "find", ids: ["old-view"] },
  });
});

test("3.1 find: a key filter alone lists the entries it admits", async () => {
  const { io } = fakeWorkspace({ terms: FILTERABLE });
  assert.deepEqual(await runTerms({ action: "find", key: "shared" }, depsOver(io)), {
    isError: false,
    text: [
      "1 entries match key shared:",
      'other-view "other view" · active · shared · Rendering  Views · owner docs/other.md',
      "  meaning: A view described elsewhere.",
    ].join("\n"),
    details: { action: "find", ids: ["other-view"] },
  });
});

test("3.1 find: a group filter compares the group normalised", async () => {
  const { io } = fakeWorkspace({ terms: FILTERABLE });
  assert.deepEqual(
    await runTerms({ action: "find", group: "  Rendering   Views " }, depsOver(io)),
    {
      isError: false,
      text: [
        '1 entries match group "Rendering Views":',
        'other-view "other view" · active · shared · Rendering  Views · owner docs/other.md',
        "  meaning: A view described elsewhere.",
      ].join("\n"),
      details: { action: "find", ids: ["other-view"] },
    },
  );

  const rendering = await runTerms({ action: "find", group: "Rendering" }, depsOver(io));
  assert.ok(!rendering.isError);
  assert.deepEqual(rendering.details, { action: "find", ids: ["old-view", "rendered-view"] });
  assert.ok(rendering.text.startsWith('2 entries match group "Rendering":'), rendering.text);
});

test("3.1 find: an owner filter alone lists the entries it admits", async () => {
  const { io } = fakeWorkspace({ terms: FILTERABLE });
  assert.deepEqual(await runTerms({ action: "find", owner: " docs/other.md " }, depsOver(io)), {
    isError: false,
    text: [
      "1 entries match owner docs/other.md:",
      'other-view "other view" · active · shared · Rendering  Views · owner docs/other.md',
      "  meaning: A view described elsewhere.",
    ].join("\n"),
    details: { action: "find", ids: ["other-view"] },
  });
});

test("3.1 find: no match with a filter, and the search text of every present part", async () => {
  const { io } = fakeWorkspace({ terms: FILTERABLE });
  assert.deepEqual(
    await runTerms({ action: "find", query: "x", status: "deprecated" }, depsOver(io)),
    {
      isError: false,
      text: 'No entry matches "x", status deprecated',
      details: { action: "find", ids: [] },
    },
  );
  assert.deepEqual(
    await runTerms({ action: "find", query: "x", status: "active", key: "shared" }, depsOver(io)),
    {
      isError: false,
      text: 'No entry matches "x", status active, key shared',
      details: { action: "find", ids: [] },
    },
  );
  assert.deepEqual(
    await runTerms(
      {
        action: "find",
        query: "x",
        status: "active",
        key: "shared",
        group: "  Rendering   Views ",
        owner: "docs/other.md",
      },
      depsOver(io),
    ),
    {
      isError: false,
      text: 'No entry matches "x", status active, key shared, group "Rendering Views", owner docs/other.md',
      details: { action: "find", ids: [] },
    },
  );
  assert.deepEqual(await runTerms({ action: "find", group: "Ghost" }, depsOver(io)), {
    isError: false,
    text: 'No entry matches group "Ghost"',
    details: { action: "find", ids: [] },
  });
});

test("1.2 validation: find requires a query or a filter", async () => {
  const cases: [TermsParams, string][] = [
    [{ action: "find" }, "action find requires query or a filter"],
    [{ action: "find", query: null }, "action find requires query or a filter"],
    [
      { action: "find", query: null, status: null, key: null, group: null, owner: null },
      "action find requires query or a filter",
    ],
    // Check 1 comes first.
    [{ action: "find", id: "a" }, "id is not valid for action find"],
  ];
  for (const [params, message] of cases) {
    const { io, calls } = fakeWorkspace({ terms: FILTERABLE });
    assert.deepEqual(await runTerms(params, depsOver(io)), { isError: true, text: message });
    assert.deepEqual(calls, [], "no file is read before validation");
  }
  // Each filter alone satisfies check 6.
  for (const params of [
    { action: "find", status: "active" },
    { action: "find", key: "shared" },
    { action: "find", group: "Rendering" },
    { action: "find", owner: "docs/view.md" },
  ] as const) {
    assert.equal(validate(cleanArgs(params)), undefined, JSON.stringify(params));
  }
  // Check 3 comes before check 6: an empty query with a filter is not empty.
  assert.equal(
    validate(cleanArgs({ action: "find", query: "  ", status: "active" })),
    "query must be a non-empty string",
  );
});

test("1.2 validation: update takes status active only; use deprecate", async () => {
  const { io, calls } = fakeWorkspace({ terms: FILTERABLE });
  assert.deepEqual(
    await runTerms({ action: "update", id: "old-view", status: "deprecated" }, depsOver(io)),
    { isError: true, text: "update takes status active only; use deprecate" },
  );
  assert.deepEqual(calls, [], "no file is read before validation");
  assert.equal(validate(cleanArgs({ action: "update", id: "a", status: "active" })), undefined);
  // Check 1 comes before check 7.
  assert.equal(
    validate(cleanArgs({ action: "update", id: "a", status: "deprecated", query: "x" })),
    "query is not valid for action update",
  );
});

test("3.2 check: the header, then the findings in order, with the details", async () => {
  const { io } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  assert.deepEqual(await runTerms({ action: "check" }, depsOver(io)), {
    isError: false,
    text: ["1 findings · 2 documents · 1 entries", `docs/other.md:1:9 P001 ${P001_TEXT}`].join(
      "\n",
    ),
    details: {
      action: "check",
      findings: [
        {
          path: "docs/other.md",
          line: 1,
          column: 9,
          code: "P001",
          message: P001_TEXT,
        },
      ],
    },
  });
});

test("3.2 check: the header counts the documents and the items of terms, 0 when terms is not a sequence, broken items included", async () => {
  const { io } = fakeWorkspace({
    terms: "terms: x\n",
    documents: { "docs/a.md": "text\n", "docs/b.md": "text\n" },
  });
  const result = await runTerms({ action: "check" }, depsOver(io));
  assert.equal(result.text.split("\n")[0], "1 findings · 2 documents · 0 entries");

  const mixed = fakeWorkspace({
    terms: `terms:\n  - id: alpha\n    label: alpha\n    meaning: A thing.\n    owner: docs/a.md\n    group: Terms\n    key: confusable\n    status: active\n    history:\n      - { date: 2024-01-01, op: add }\n  - label: x\n`,
    documents: { "docs/a.md": "alpha\n", "docs/b.md": "text\n" },
  });
  const counted = await runTerms({ action: "check" }, depsOver(mixed.io));
  assert.equal(counted.text.split("\n")[0], "7 findings · 2 documents · 2 entries");
});

test("3.2 check: no terms file is a tool error", async () => {
  const { io } = fakeWorkspace({ documents: DOCUMENTS });
  assert.deepEqual(await runTerms({ action: "check" }, depsOver(io)), {
    isError: true,
    text: "no terms file at .pi/pi-dent/terms.yaml",
  });
});

test("2 workspace: a git failure is the tool error, and a failed read is a tool error", async () => {
  const gitFails = fakeWorkspace({ terms: BASE, gitFails: true });
  assert.deepEqual(await runTerms({ action: "check" }, depsOver(gitFails.io)), {
    isError: true,
    text: "git failed: boom",
  });
  const unreadable: WorkspaceAccess = {
    ...fakeWorkspace().io,
    async readTerms() {
      throw new TermsError("cannot read .pi/pi-dent/terms.yaml: EISDIR");
    },
  };
  assert.deepEqual(await runTerms({ action: "find", query: "x" }, depsOver(unreadable)), {
    isError: true,
    text: "cannot read .pi/pi-dent/terms.yaml: EISDIR",
  });
});

test("3.3 add: the summary, the write, and an empty edit list", async () => {
  const { io, writes } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  const outcome = await runTerms(
    {
      action: "add",
      id: "terms-file",
      label: "terms  file",
      meaning: "The workspace thesaurus file.",
      owner: "docs/view.md",
      group: "Files",
      key: "confusable",
    },
    depsOver(io, "2026-11-14"),
  );
  assert.deepEqual(outcome, {
    isError: false,
    text: [
      'Added terms-file "terms file" · .pi/pi-dent/terms.yaml written',
      "No occurrences to edit.",
    ].join("\n"),
    details: { action: "add", edits: [] },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.root, ROOT);
  assert.ok(writes[0]?.text.includes("  - id: terms-file"));
  assert.ok(writes[0]?.text.includes("      - date: 2026-11-14\n        op: add\n"));
});

test("3.3 add: an existing id is a refusal, a tool error with nothing written", async () => {
  const { io, writes } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  const outcome = await runTerms(
    {
      action: "add",
      id: "rendered-view",
      label: "other",
      meaning: "m",
      owner: "docs/view.md",
      group: "g",
      key: "confusable",
    },
    depsOver(io),
  );
  assert.deepEqual(outcome, { isError: true, text: "rendered-view is already an entry" });
  assert.deepEqual(writes, []);
});

test("2 workspace: checks read external owner text and report T006 against it", async () => {
  const terms = BASE.replace("owner: docs/view.md", 'owner: "../other/owner.md"');
  const { io } = fakeWorkspace({
    terms,
    documents: DOCUMENTS,
    externalOwners: { "../other/owner.md": "No relevant term.\n" },
  });
  const result = await runTerms({ action: "check" }, depsOver(io));
  if (result.isError) assert.fail(result.text);
  assert.match(
    result.text,
    /T006 rendered-view: owner \.\.\/other\/owner\.md does not use "rendered view"/,
  );
});

test("3.3 reown accepts an external owner", async () => {
  const { io } = fakeWorkspace({
    terms: BASE.replace("owner: docs/view.md", "owner: ../old/owner.md"),
    documents: DOCUMENTS,
  });
  const result = await runTerms(
    { action: "reown", id: "rendered-view", owner: "../new/owner.md" },
    depsOver(io),
  );
  assert.equal(result.isError, false, result.text);
});

test("3.3 import accepts an Owner cell outside the workspace", async () => {
  const { io } = fakeWorkspace({
    documents: {
      "thesaurus.md":
        "# Tools\n\n| Term | Meaning | Owner | Avoid or distinguish |\n| --- | --- | --- | --- |\n| Remote | A remote concept. | ../remote/owner.md | |\n",
    },
  });
  const result = await runTerms({ action: "import", path: "thesaurus.md" }, depsOver(io));
  assert.equal(result.isError, false, result.text);
});

test("3.3 update: records a key and reject change and returns matching occurrences", async () => {
  const { io, writes } = fakeWorkspace({
    terms: BASE,
    documents: { "docs/view.md": "The rendered view.\n", "docs/other.md": "legacy preview.\n" },
  });
  const outcome = await runTerms(
    { action: "update", id: "rendered-view", key: "local", addReject: ["legacy preview"] },
    depsOver(io),
  );
  assert.deepEqual(outcome, {
    isError: false,
    text: [
      "Updated rendered-view · .pi/pi-dent/terms.yaml written",
      "1 occurrences to edit with your edit tool; no document was changed:",
      'docs/other.md:1:1 "legacy preview" → "rendered view"',
    ].join("\n"),
    details: {
      action: "update",
      edits: [
        { path: "docs/other.md", line: 1, column: 1, old: "legacy preview", new: "rendered view" },
      ],
    },
  });
  assert.equal(writes.length, 1);
  assert.ok(writes[0]?.text.includes("key: local"));
  assert.ok(writes[0]?.text.includes("op: update"));
});

test("3.3 update: changes the meaning and records the old one in history", async () => {
  const { io, writes } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  const outcome = await runTerms(
    { action: "update", id: "rendered-view", meaning: "The page as a reader sees it." },
    depsOver(io),
  );
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(writes.length, 1);
  assert.ok(writes[0]?.text.includes("    meaning: The page as a reader sees it.\n"));
  assert.ok(
    writes[0]?.text.includes(
      "      - date: 2026-11-14\n        op: update\n        meaning: How a document looks once rendered.\n",
    ),
  );
});

test("3.3 update: an unchanged meaning alone is refused", async () => {
  const { io, writes } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms(
      { action: "update", id: "rendered-view", meaning: "How a document looks once rendered." },
      depsOver(io),
    ),
    { isError: true, text: "update makes no changes to rendered-view" },
  );
  assert.equal(writes.length, 0);
});

test("3.3 update: status active returns a deprecated entry to active", async () => {
  const { io, writes } = fakeWorkspace({ terms: WITH_DEPRECATED_VIEW, documents: DOCUMENTS });
  const outcome = await runTerms(
    { action: "update", id: "old-view", status: "active" },
    depsOver(io),
  );
  assert.deepEqual(outcome, {
    isError: false,
    text: "Updated old-view · .pi/pi-dent/terms.yaml written\nNo occurrences to edit.",
    details: { action: "update", edits: [] },
  });
  assert.equal(writes.length, 1);
  assert.ok(
    writes[0]?.text.includes(
      "  - id: old-view\n    label: old view\n    meaning: An old way to view.\n    owner: docs/view.md\n    group: Rendering\n    key: confusable\n    status: active\n    history:",
    ),
  );
  assert.ok(
    writes[0]?.text.includes(
      "      - date: 2026-11-14\n        op: update\n        status: deprecated\n",
    ),
  );
});

test("3.3 rename: the edit list holds the old label as a reject occurrence", async () => {
  const { io, writes } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms({ action: "rename", id: "rendered-view", label: "rendered page" }, depsOver(io)),
    {
      isError: false,
      text: [
        'Renamed rendered-view "rendered view" → "rendered page" · .pi/pi-dent/terms.yaml written',
        "1 occurrences to edit with your edit tool; no document was changed:",
        'docs/view.md:3:5 "rendered view" → "rendered page"',
      ].join("\n"),
      details: {
        action: "rename",
        edits: [
          {
            path: "docs/view.md",
            line: 3,
            column: 5,
            old: "rendered view",
            new: "rendered page",
          },
        ],
      },
    },
  );
  assert.equal(writes.length, 1);
});

test("3.3 merge: moved reject phrases and the deprecated label, each with the suggested label", async () => {
  const { io, writes } = fakeWorkspace({ terms: BOTH, documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms({ action: "merge", id: "rendered-view", into: ["terms-file"] }, depsOver(io)),
    {
      isError: false,
      text: [
        "Merged rendered-view into terms-file · .pi/pi-dent/terms.yaml written",
        "2 occurrences to edit with your edit tool; no document was changed:",
        'docs/other.md:1:9 "html preview" → "terms file"',
        'docs/view.md:3:5 "rendered view" → "terms file"',
      ].join("\n"),
      details: {
        action: "merge",
        edits: [
          { path: "docs/other.md", line: 1, column: 9, old: "html preview", new: "terms file" },
          { path: "docs/view.md", line: 3, column: 5, old: "rendered view", new: "terms file" },
        ],
      },
    },
  );
  assert.equal(writes.length, 1);
});

test("3.3 deprecate: the arrow with its replacements; no suggestion without one", async () => {
  const replaced = fakeWorkspace({ terms: BOTH, documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms(
      { action: "deprecate", id: "rendered-view", reason: "renamed", replacedBy: ["terms-file"] },
      depsOver(replaced.io),
    ),
    {
      isError: false,
      text: [
        "Deprecated rendered-view (renamed) → terms-file · .pi/pi-dent/terms.yaml written",
        "2 occurrences to edit with your edit tool; no document was changed:",
        'docs/other.md:1:9 "html preview" → "terms file"',
        'docs/view.md:3:5 "rendered view" → "terms file"',
      ].join("\n"),
      details: {
        action: "deprecate",
        edits: [
          { path: "docs/other.md", line: 1, column: 9, old: "html preview", new: "terms file" },
          { path: "docs/view.md", line: 3, column: 5, old: "rendered view", new: "terms file" },
        ],
      },
    },
  );

  const alone = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms(
      { action: "deprecate", id: "rendered-view", reason: "out-of-scope" },
      depsOver(alone.io),
    ),
    {
      isError: false,
      text: [
        "Deprecated rendered-view (out-of-scope) · .pi/pi-dent/terms.yaml written",
        "1 occurrences to edit with your edit tool; no document was changed:",
        'docs/view.md:3:5 "rendered view" → no suggestion, rewrite by hand',
      ].join("\n"),
      details: {
        action: "deprecate",
        edits: [{ path: "docs/view.md", line: 3, column: 5, old: "rendered view", new: null }],
      },
    },
  );
});

test("3.3 reown: the summary with both owners and an empty edit list", async () => {
  const { io } = fakeWorkspace({ terms: BASE, documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms({ action: "reown", id: "rendered-view", owner: "docs/other.md" }, depsOver(io)),
    {
      isError: false,
      text: [
        "Moved the owner of rendered-view from docs/view.md to docs/other.md · .pi/pi-dent/terms.yaml written",
        "No occurrences to edit.",
      ].join("\n"),
      details: { action: "reown", edits: [] },
    },
  );
});

test("3.3 import: the summary, the edit list, and the reject candidates", async () => {
  const glossary = [
    "# Glossary",
    "",
    "## Rendering",
    "",
    "| Term | Meaning | Owner | Avoid or distinguish |",
    "| --- | --- | --- | --- |",
    "| Rendered view | How a document looks once rendered. | [view](view.md) | html preview |",
    "",
  ].join("\n");
  const { io, writes } = fakeWorkspace({
    documents: { ...DOCUMENTS, "docs/glossary.md": glossary },
  });
  assert.deepEqual(await runTerms({ action: "import", path: "docs/glossary.md" }, depsOver(io)), {
    isError: false,
    text: [
      "Imported 1 entries from docs/glossary.md · .pi/pi-dent/terms.yaml written",
      "No occurrences to edit.",
      "1 reject candidates; use update with addReject for specific phrases and drop ordinary words:",
      'rendered-view: "html preview"',
    ].join("\n"),
    details: {
      action: "import",
      edits: [],
      candidates: [{ id: "rendered-view", text: "html preview" }],
      localIds: [],
    },
  });
  assert.equal(writes.length, 1);
});

test("3.3 import: reports sorted local ids in its result text and details", async () => {
  const glossary =
    "# Glossary\n\n| Term | Meaning | Owner | Avoid or distinguish |\n| --- | --- | --- | --- |\n| Zeta | A concept. | owner.md | |\n| Alpha | A concept. | owner.md | |\n";
  const documents = { "glossary.md": glossary, "owner.md": "`Zeta` and Alpha." };
  const { io, writes } = fakeWorkspace({ documents });
  const result = await runTerms({ action: "import", path: "glossary.md" }, depsOver(io));
  assert.deepEqual(result, {
    isError: false,
    text: "Imported 2 entries from glossary.md; key local: alpha, zeta · .pi/pi-dent/terms.yaml written\nNo occurrences to edit.",
    details: { action: "import", edits: [], candidates: [], localIds: ["alpha", "zeta"] },
  });
  const written = writes[0];
  assert.ok(written);
  assert.equal((written.text.match(/key: local/g) ?? []).length, 2);
  const checked = await runTerms(
    { action: "check" },
    depsOver(fakeWorkspace({ terms: written.text, documents }).io),
  );
  assert.equal(checked.text, "0 findings · 2 documents · 2 entries");
});

test("3.3 import: a document without a thesaurus table is a refusal", async () => {
  const { io, writes } = fakeWorkspace({ documents: DOCUMENTS });
  assert.deepEqual(await runTerms({ action: "import", path: "docs/other.md" }, depsOver(io)), {
    isError: true,
    text: "docs/other.md has no thesaurus table",
  });
  assert.deepEqual(writes, []);
});

test("2 workspace: an operation without a terms file writes it with a new entry", async () => {
  const { io, writes } = fakeWorkspace({ documents: DOCUMENTS });
  const outcome = await runTerms(
    {
      action: "add",
      id: "rendered-view",
      label: "rendered view",
      meaning: "How a document looks once rendered.",
      owner: "docs/view.md",
      group: "Rendering",
      key: "confusable",
    },
    depsOver(io),
  );
  assert.equal(outcome.isError, false);
  assert.equal(writes.length, 1);
});

test("2 workspace: a rename of an absent file is a refusal", async () => {
  const { io } = fakeWorkspace({ documents: DOCUMENTS });
  assert.deepEqual(
    await runTerms({ action: "rename", id: "rendered-view", label: "x" }, depsOver(io)),
    { isError: true, text: "no terms file at .pi/pi-dent/terms.yaml" },
  );
});

test("2 workspace: a write failure is the tool error", async () => {
  const fake = fakeWorkspace({ documents: DOCUMENTS });
  const failing: WorkspaceAccess = {
    ...fake.io,
    async writeTerms() {
      throw new TermsError("cannot write .pi/pi-dent/terms.yaml: EACCES");
    },
  };
  assert.deepEqual(
    await runTerms(
      {
        action: "add",
        id: "rendered-view",
        label: "rendered view",
        meaning: "m",
        owner: "docs/view.md",
        group: "g",
        key: "confusable",
      },
      depsOver(failing),
    ),
    { isError: true, text: "cannot write .pi/pi-dent/terms.yaml: EACCES" },
  );
});

test("3 results: a tool error has its text and no details; a result has its details", () => {
  assert.deepEqual(toToolResult({ isError: true, text: "x" }), {
    content: [{ type: "text", text: "x" }],
    details: undefined,
    isError: true,
  });
  assert.deepEqual(
    toToolResult({ isError: false, text: "y", details: { action: "find", ids: [] } }),
    { content: [{ type: "text", text: "y" }], details: { action: "find", ids: [] } },
  );
});

test("3.2 changes report introduced findings, an empty line and label/form occurrences", async () => {
  const before = "rendered view\n";
  const current = "rendered view\nhtml preview; rendered views and `rendered view`.\n";
  const fake = fakeWorkspace({ terms: BASE, documents: { "docs/view.md": current } });
  const result = await createTermsTool(fake.io).execute(
    "x",
    { action: "check", changes: [{ path: " docs/view.md ", before }] },
    undefined,
    undefined,
    { cwd: ROOT } as never,
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, {
    action: "check",
    findings: [{ path: "docs/view.md", line: 2, column: 1, code: "P001", message: P001_TEXT }],
    occurrences: [
      { id: "rendered-view", path: "docs/view.md", line: 2, column: 15, text: "rendered views" },
    ],
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: `1 findings introduced · 1 changes · 1 documents · 1 entries\ndocs/view.md:2:1 P001 ${P001_TEXT}\n\n1 label occurrences in changed lines; confirm each means its entry:\nrendered-view "rendered view": How a document looks once rendered.\n  docs/view.md:2:15 "rendered views"`,
    },
  ]);
});

test("3.2 label occurrence text normalises source whitespace without removing source markup", async () => {
  const result = await runTerms(
    { action: "check", changes: [{ path: "docs/view.md", before: null }] },
    depsOver(fakeWorkspace({ terms: BASE, documents: { "docs/view.md": "rendered\t*view*" } }).io),
  );
  assert.ok(!result.isError && result.details.action === "check");
  assert.deepEqual(result.details.occurrences, [
    { id: "rendered-view", path: "docs/view.md", line: 1, column: 1, text: "rendered *view" },
  ]);
  assert.ok(result.text.endsWith('  docs/view.md:1:1 "rendered *view"'));
});

test("3.2 label occurrence blocks group entries by id and positions by path", async () => {
  const dependencies = depsOver(
    fakeWorkspace({
      terms: BOTH,
      documents: {
        "docs/view.md": "terms file rendered view",
        "a.md": "rendered view",
      },
    }).io,
  );
  const result = await runTerms(
    {
      action: "check",
      changes: [
        { path: "docs/view.md", before: null },
        { path: "a.md", before: null },
      ],
    },
    dependencies,
  );
  assert.ok(!result.isError && result.details.action === "check");
  assert.deepEqual(result.details.occurrences, [
    { id: "rendered-view", path: "a.md", line: 1, column: 1, text: "rendered view" },
    { id: "rendered-view", path: "docs/view.md", line: 1, column: 12, text: "rendered view" },
    { id: "terms-file", path: "docs/view.md", line: 1, column: 1, text: "terms file" },
  ]);
  assert.ok(
    result.text.endsWith(
      '\n\n3 label occurrences in changed lines; confirm each means its entry:\nrendered-view "rendered view": How a document looks once rendered.\n  a.md:1:1 "rendered view"\n  docs/view.md:1:12 "rendered view"\nterms-file "terms file": The workspace thesaurus file.\n  docs/view.md:1:1 "terms file"',
    ),
  );
});

test("3.2 the same change set can be checked again after fixing the introduced reject phrase", async () => {
  const options = { terms: BASE, documents: { "docs/view.md": "rendered view\nhtml preview\n" } };
  const changes = [{ path: "docs/view.md", before: "rendered view\n" }];
  const dependencies = depsOver(fakeWorkspace(options).io);
  const first = await runTerms({ action: "check", changes }, dependencies);
  assert.ok(!first.isError && first.text.startsWith("1 findings introduced"));
  options.documents["docs/view.md"] = "rendered view\nrendered view\n";
  const fixed = await runTerms({ action: "check", changes }, dependencies);
  assert.ok(!fixed.isError && fixed.text.startsWith("0 findings introduced"));
});

test("1.2 changes validate before workspace access, paths trimmed and before as given", async () => {
  const unavailable = fakeWorkspace({ gitFails: true });
  const cases: [TermsParams, string][] = [
    [{ action: "find", query: "x", changes: [] }, "changes is not valid for action find"],
    [
      { action: "check", query: "", changes: [{ path: "x", before: null }] },
      "query is not valid for action check",
    ],
    [
      { action: "check", changes: [{ path: "x", before: null }] },
      "changes[0].path must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
    ],
    [
      { action: "check", changes: [{ path: "a.md", from: "bad", before: null }] },
      "changes[0].from must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
    ],
    [
      {
        action: "check",
        changes: [{ path: "a.md", from: ".pi/pi-dent/terms.yaml", before: null }],
      },
      "changes[0].from must be .pi/pi-dent/terms.yaml exactly when path is",
    ],
    [
      { action: "check", changes: [{ path: "a.md", from: "b.md", before: null }] },
      "changes[0].from needs a before text",
    ],
    [
      { action: "check", changes: [{ path: "a.md", before: "\ud800" }] },
      "changes[0].before holds a lone surrogate",
    ],
    [
      {
        action: "check",
        changes: [
          { path: "a.md", before: null },
          { path: " a.md ", before: "" },
        ],
      },
      'changes[1].path repeats "a.md"',
    ],
    [
      {
        action: "check",
        changes: [
          { path: "a.md", before: "" },
          { path: "b.md", from: " a.md ", before: "" },
        ],
      },
      'changes[1].from repeats the base path "a.md"',
    ],
  ];
  for (const [params, text] of cases) {
    assert.deepEqual(await runTerms(params, depsOver(unavailable.io)), { isError: true, text });
  }
});

test("3.2 before is not trimmed, null changes is absent, and an empty change set is present", async () => {
  const dependencies = depsOver(
    fakeWorkspace({ terms: BASE, documents: { "docs/view.md": "rendered view" } }).io,
  );
  const replacement = await runTerms(
    { action: "check", changes: [{ path: "docs/view.md", before: " rendered view " }] },
    dependencies,
  );
  assert.ok(!replacement.isError && replacement.details.action === "check");
  assert.deepEqual(replacement.details.occurrences, [
    { id: "rendered-view", path: "docs/view.md", line: 1, column: 1, text: "rendered view" },
  ]);
  const absent = await runTerms({ action: "check", changes: null }, dependencies);
  const plain = await runTerms({ action: "check" }, dependencies);
  assert.deepEqual(absent, plain);
  const empty = await runTerms({ action: "check", changes: [] }, dependencies);
  assert.ok(!empty.isError && empty.details.action === "check");
  assert.ok(empty.text.startsWith("0 findings introduced · 0 changes"));
  assert.deepEqual(empty.details.occurrences, []);
});

test("2 moved and deleted files use supplied before texts even when individual file reads are unavailable", async () => {
  const fake = fakeWorkspace({
    terms: BASE,
    documents: {
      "docs/view.md": "rendered view",
      "docs/new.md": "html preview",
    },
  });
  const io: WorkspaceAccess = {
    ...fake.io,
    async document() {
      throw new Error("individual file reads are unavailable");
    },
  };
  const result = await runTerms(
    {
      action: "check",
      changes: [
        { path: "docs/new.md", from: "docs/old.md", before: "html preview" },
        { path: "docs/deleted.md", before: "html preview" },
      ],
    },
    depsOver(io),
  );
  assert.ok(!result.isError && result.details.action === "check");
  assert.deepEqual(result.details.findings, []);
  assert.deepEqual(result.details.occurrences, []);
});

test("1.1 changes item schema requires path and before, permits nullable from and no extra fields", () => {
  const schema = JSON.parse(JSON.stringify(TermsSchema));
  const array = schema.properties.changes.anyOf.find(
    (item: { type: string }) => item.type === "array",
  );
  assert.deepEqual(array.items, {
    type: "object",
    additionalProperties: false,
    required: ["path", "before"],
    properties: {
      path: { type: "string" },
      before: { anyOf: [{ type: "string" }, { type: "null" }] },
      from: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  });
});

test("2 date: the operation date is the local calendar date", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(localDate(new Date(2026, 11, 31, 0, 1)), "2026-12-31");
});
