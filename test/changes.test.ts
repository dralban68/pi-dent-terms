import assert from "node:assert/strict";
import { test } from "node:test";

import { checkWorkspace } from "../lib/checks.ts";
import { checkChanges, validateChanges, type Change } from "../lib/changes.ts";
import { findingText, type Finding } from "../lib/text.ts";

const TERMS = ".pi/pi-dent/terms.yaml";
const DEFAULT_HISTORY = "\n      - { date: 2024-01-01, op: add }";
const P001 = '"html preview" is rejected: use "rendered view" (rendered-view)';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An entry of the terms file text (as in checks.test.ts); `overrides` replaces or adds a field. */
function entry(id: string, overrides: Record<string, string | null> = {}): string {
  const fields = new Map<string, string | null>([
    ["label", id],
    ["meaning", "A thing."],
    ["owner", "docs/a.md"],
    ["group", "Terms"],
    ["key", "confusable"],
    ["status", "active"],
    ["history", DEFAULT_HISTORY],
  ]);
  for (const [name, value] of Object.entries(overrides)) fields.set(name, value);
  let out = `  - id: ${id}\n`;
  for (const [name, value] of fields) {
    if (value !== null) out += `    ${name}: ${value}\n`;
  }
  return out;
}

function terms(...entries: string[]): string {
  return entries.length === 0 ? "terms: []\n" : `terms:\n${entries.join("")}`;
}

const BASE_TERMS = terms(
  entry("rendered-view", {
    label: "rendered view",
    meaning: "How a view looks.",
    reject: "[html preview]",
  }),
);

/** The changed workspace checked against its change set; the findings and occurrences as texts. */
function run(termsText: string, documents: Record<string, string>, changes: Change[]) {
  const result = checkChanges(
    bytes(termsText),
    new Map(Object.entries(documents)),
    new Map(),
    changes,
  );
  return {
    findings: result.findings.map((finding: Finding) => findingText(finding)),
    occurrences: result.occurrences,
  };
}

function rendered(overrides: Record<string, string | null> = {}): string {
  return entry("rendered-view", {
    label: "rendered view",
    meaning: "How a document looks once rendered.",
    owner: "docs/a.md",
    reject: "[html preview]",
    forms: "[rendered visuals]",
    ...overrides,
  });
}

function legacy(overrides: Record<string, string | null> = {}): string {
  return entry("legacy-view", {
    label: "legacy view",
    meaning: "A view of the legacy page.",
    owner: "docs/a.md",
    reject: "[old preview]",
    ...overrides,
  });
}

function termsFileEntry(overrides: Record<string, string | null> = {}): string {
  return entry("terms-file", {
    label: "terms file",
    meaning: "The workspace thesaurus file.",
    owner: "docs/b.md",
    ...overrides,
  });
}

/** The `<line>:<column>` of the first occurrence of a needle in a text, as a finding position. */
function at(text: string, needle: string): string {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `${needle} is in the text`);
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `${line}:${column}`;
}

// --- Validity (terms.md 5.4 conditions 1 to 6; terms-tool.md 1.2 texts and order) ----------

test("5.4 validity: each condition's error text, from the first failing item", () => {
  const cases: [Change[], string | undefined][] = [
    [
      [{ path: "x.txt", before: null }],
      "changes[0].path must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
    ],
    [
      [{ path: "../a.md", before: null }],
      "changes[0].path must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
    ],
    [
      [{ path: "docs/a.md", from: "b/./c.md", before: "" }],
      "changes[0].from must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
    ],
    [
      [{ path: "docs/a.md", from: TERMS, before: "" }],
      `changes[0].from must be .pi/pi-dent/terms.yaml exactly when path is`,
    ],
    [
      [{ path: TERMS, from: "docs/a.md", before: "" }],
      `changes[0].from must be .pi/pi-dent/terms.yaml exactly when path is`,
    ],
    [
      [{ path: "docs/a.md", from: "docs/b.md", before: null }],
      "changes[0].from needs a before text",
    ],
    [[{ path: "docs/a.md", before: "\ud800" }], "changes[0].before holds a lone surrogate"],
    [
      [
        { path: "docs/a.md", before: null },
        { path: "docs/a.md", before: "" },
      ],
      'changes[1].path repeats "docs/a.md"',
    ],
    [
      [
        { path: "docs/a.md", before: "" },
        { path: "docs/b.md", from: "docs/a.md", before: "" },
      ],
      'changes[1].from repeats the base path "docs/a.md"',
    ],
    [
      [
        { path: "docs/a.md", before: "" },
        { path: "docs/b.md", before: "" },
      ],
      undefined,
    ],
    [[], undefined],
  ];
  for (const [changes, text] of cases) {
    assert.equal(validateChanges(changes), text, JSON.stringify(changes));
  }
});

test("5.4 validity: the examination order is field, then from, then the item", () => {
  // The path fails before from is looked at, and from fails before the item-level checks.
  assert.equal(
    validateChanges([{ path: "x.txt", from: "y.txt", before: null }]),
    "changes[0].path must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
  );
  assert.equal(
    validateChanges([{ path: "docs/a.md", from: "y.txt", before: null }]),
    "changes[0].from must be .pi/pi-dent/terms.yaml or a workspace path ending with .md",
  );
  // Condition 3 (from without a before) comes before condition 4 (a lone surrogate).
  assert.equal(
    validateChanges([{ path: "docs/a.md", from: "docs/b.md", before: null }]),
    "changes[0].from needs a before text",
  );
  // Condition 5 (repeated path) comes before condition 6 (repeated base path).
  assert.equal(
    validateChanges([
      { path: "docs/a.md", before: "" },
      { path: "docs/a.md", from: "docs/a.md", before: "" },
    ]),
    'changes[1].path repeats "docs/a.md"',
  );
});

// --- Base workspace (terms.md 5.4) -------------------------------------------------------------

test("5.4 base: a new file has every finding introduced", () => {
  const result = run(BASE_TERMS, { "docs/new.md": "html preview\n" }, [
    { path: "docs/new.md", before: null },
  ]);
  assert.deepEqual(result.findings, [`docs/new.md:1:1 P001 ${P001}`]);
});

test("5.4 base: a deleted file has no finding of its own in the current workspace", () => {
  const result = run(BASE_TERMS, {}, [{ path: "docs/gone.md", before: "html preview\n" }]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.occurrences, []);
});

test("5.4 base: a moved file's finding in an unchanged text is not introduced", () => {
  const result = run(BASE_TERMS, { "docs/new.md": "html preview\n" }, [
    { path: "docs/new.md", from: "docs/old.md", before: "html preview\n" },
  ]);
  assert.deepEqual(result.findings, []);
});

test("5.4 base: the terms file as a change, with before null, has no base terms file", () => {
  // The owner uses the label, so the terms file itself has no finding; the P001 is new with it.
  const result = run(BASE_TERMS, { "docs/a.md": "rendered view and html preview\n" }, [
    { path: TERMS, before: null },
  ]);
  assert.deepEqual(result.findings, [`docs/a.md:1:19 P001 ${P001}`]);
});

test("5.4 base: an unlisted file counts as unchanged", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "html preview\n", "docs/b.md": "html preview\n" }, [
    { path: "docs/a.md", before: "html preview\n" },
  ]);
  assert.deepEqual(result.findings, []);
});

// --- Line pairing and regions (terms.md 5.4) ---------------------------------------------------

test("5.4 pairing: base x,y against current y,x pairs (1,2), so current line 1 is changed", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "rendered view\nx\n" }, [
    { path: "docs/a.md", before: "x\nrendered view\n" },
  ]);
  assert.deepEqual(
    result.occurrences.map((occurrence) => occurrence.line),
    [1],
  );
});

test("5.4 regions: an inserted line with a P001 is introduced", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "rendered view\nhtml preview\n" }, [
    { path: "docs/a.md", before: "rendered view\n" },
  ]);
  assert.deepEqual(result.findings, [`docs/a.md:2:1 P001 ${P001}`]);
});

test("5.4 regions: a replacement line keeping the same P001 is not introduced", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "html preview there\n" }, [
    { path: "docs/a.md", before: "html preview here\n" },
  ]);
  assert.deepEqual(result.findings, []);
});

test("5.4 regions: a replacement adding a second identical P001 to a region introduces one", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "a\nhtml preview html preview\n" }, [
    { path: "docs/a.md", before: "a\nhtml preview\n" },
  ]);
  assert.deepEqual(result.findings, [`docs/a.md:2:14 P001 ${P001}`]);
});

test("5.4 regions: a line moved across an unchanged line has its finding introduced", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "html preview\nkeep\n" }, [
    { path: "docs/a.md", before: "keep\nhtml preview\n" },
  ]);
  assert.deepEqual(result.findings, [`docs/a.md:1:1 P001 ${P001}`]);
});

test("5.4 regions: an empty current terms file's T001 past the end is compared with the base", () => {
  // The base text "\n" and the current empty file both give one T001 at 1:1.
  const current = checkWorkspace(bytes(""), new Map());
  assert.equal(current.findings.length, 1);
  const result = checkChanges(bytes(""), new Map(), new Map(), [{ path: TERMS, before: "\n" }]);
  assert.deepEqual(result.findings, []);
});

test("5.4 regions: a terms file's finding past the last line of both texts is not introduced", () => {
  // The base text "a: 1\nkey: [\n" and the current "b: 2\nkey: [\n" hold the same unclosed
  // flow sequence, which the parser reports past their last line.
  const before = "a: 1\nkey: [\n";
  const current = "b: 2\nkey: [\n";
  const base = checkWorkspace(bytes(before), new Map()).findings.map(findingText);
  assert.deepEqual(checkWorkspace(bytes(current), new Map()).findings.map(findingText), base);
  const result = checkChanges(bytes(current), new Map(), new Map(), [{ path: TERMS, before }]);
  assert.deepEqual(result.findings, []);
});

test("5.4 regions: an empty base and current terms file's T001 at 1:1 is not introduced", () => {
  assert.equal(checkWorkspace(bytes(""), new Map()).findings.length, 1);
  const result = checkChanges(bytes(""), new Map(), new Map(), [{ path: TERMS, before: "" }]);
  assert.deepEqual(result.findings, []);
});

test("5.4 regions: an entry newly deprecated makes a P002 on an unchanged line introduced", () => {
  const before = terms(entry("alpha"));
  const current = terms(
    entry("alpha"),
    entry("gamma", { status: "deprecated", reason: "renamed", replacedBy: "[alpha]" }),
  );
  const result = checkChanges(
    bytes(current),
    new Map([["docs/a.md", "The gamma here.\n"]]),
    new Map(),
    [{ path: TERMS, before }],
  );
  assert.deepEqual(
    result.findings.map((finding) => findingText(finding)),
    ['docs/a.md:1:5 P002 "gamma" is deprecated (renamed): use "alpha" (alpha)'],
  );
});

test("5.4 pairing: CRLF and lone CR line endings split the lines they end", () => {
  const crlf = run(BASE_TERMS, { "docs/a.md": "rendered view\nhtml preview\n" }, [
    { path: "docs/a.md", before: "rendered view\r\nhtml preview\r" },
  ]);
  assert.deepEqual(crlf.occurrences, []);
  assert.deepEqual(crlf.findings, []);
  const cr = run(BASE_TERMS, { "docs/a.md": "rendered view\rrendered view\r" }, [
    { path: "docs/a.md", before: "rendered view\r" },
  ]);
  assert.deepEqual(
    cr.occurrences.map((occurrence) => occurrence.line),
    [2],
  );
});

test("5.4 base: a before text's leading U+FEFF is dropped, so its lines pair", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "rendered view\nrendered view\n" }, [
    { path: "docs/a.md", before: "\uFEFFrendered view\n" },
  ]);
  assert.deepEqual(
    result.occurrences.map((occurrence) => occurrence.line),
    [2],
  );
});

// --- Label occurrences in changed lines (terms.md 5.4) -----------------------------------------

test("5.4 occurrences: only occurrences on changed lines count", () => {
  const result = run(BASE_TERMS, { "docs/a.md": "rendered view\nrendered view\n" }, [
    { path: "docs/a.md", before: "rendered view\n" },
  ]);
  assert.deepEqual(result.occurrences, [
    {
      id: "rendered-view",
      label: "rendered view",
      meaning: "How a view looks.",
      path: "docs/a.md",
      line: 2,
      column: 1,
      text: "rendered view",
    },
  ]);
});

test("5.4 occurrences: a form counts, and a code span is no occurrence", () => {
  const withForm = terms(
    entry("rendered-view", {
      label: "rendered view",
      meaning: "How a view looks.",
      forms: "[rendered vistas]",
    }),
  );
  const forms = run(withForm, { "docs/a.md": "rendered vistas\n" }, [
    { path: "docs/a.md", before: null },
  ]);
  assert.deepEqual(
    forms.occurrences.map((occurrence) => [occurrence.text, occurrence.line]),
    [["rendered vistas", 1]],
  );
  const spans = run(BASE_TERMS, { "docs/a.md": "`rendered view`\n" }, [
    { path: "docs/a.md", before: null },
  ]);
  assert.deepEqual(spans.occurrences, []);
});

// --- Further cases: empty change set, moved and deleted documents, terms changes, regions -----

test("5.4 base: an empty change set introduces no findings and lists no occurrences", () => {
  const result = run(
    terms(rendered()),
    { "docs/a.md": "The rendered view here.\n", "docs/b.md": "html preview\n" },
    [],
  );
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.occurrences, []);
});

test("5.4 base: a deleted document is restored in the base workspace", () => {
  const termsText = terms(
    entry("rendered-view", { label: "rendered view", owner: "docs/b.md", key: "local" }),
  );
  const result = run(termsText, {}, [{ path: "docs/b.md", before: "rendered view\n" }]);
  assert.deepEqual(result.findings, [
    `${TERMS}:${at(termsText, "docs/b.md")} T003 rendered-view: owner docs/b.md is not a document`,
  ]);
});

test("5.4 base: a finding whose message names a moved document's path is introduced", () => {
  const termsText = terms(rendered({ owner: "docs/old.md" }));
  const result = run(termsText, { "docs/new.md": "rendered view\n" }, [
    { path: "docs/new.md", from: "docs/old.md", before: "rendered view\n" },
  ]);
  assert.deepEqual(result.findings, [
    `${TERMS}:${at(termsText, "docs/old.md")} T003 rendered-view: owner docs/old.md is not a document`,
  ]);
});

test("5.4 base: a terms change is undone in the base workspace", () => {
  const termsText = terms(rendered());
  const result = run(termsText, { "docs/a.md": "Nothing here.\n" }, [
    { path: TERMS, before: terms() },
  ]);
  assert.deepEqual(result.findings, [
    `${TERMS}:${at(termsText, "rendered view")} T005 rendered-view: "rendered view" is used by no document`,
    `${TERMS}:${at(termsText, "docs/a.md")} T006 rendered-view: owner docs/a.md does not use "rendered view"`,
  ]);
});

test("5.4 base: a before with U+0000 adds no base document", () => {
  const result = run(
    terms(rendered()),
    { "docs/a.md": "The rendered view here.\n", "docs/b.md": "html preview\n" },
    [{ path: "docs/b.md", before: "html preview\n\u0000" }],
  );
  assert.deepEqual(result.findings, [`docs/b.md:1:1 P001 ${P001}`]);
});

test("5.4 regions: the line pairing takes the smallest pair sequence of the longest", () => {
  const result = run(
    terms(legacy(), rendered()),
    {
      "docs/a.md": "The rendered view and legacy view here.\n",
      "docs/b.md": "old preview\nhtml preview\n",
    },
    [{ path: "docs/b.md", before: "html preview\nold preview\n" }],
  );
  assert.deepEqual(result.findings, [
    'docs/b.md:1:1 P001 "old preview" is rejected: use "legacy view" (legacy-view)',
  ]);
});

test("5.4 regions: a replaced line is compared with the base lines of its region", () => {
  const same = run(
    terms(rendered()),
    { "docs/a.md": "The rendered view here.\n", "docs/b.md": "rendered view\nan html preview\n" },
    [{ path: "docs/b.md", before: "rendered view\nhtml preview\n" }],
  );
  assert.deepEqual(same.findings, []);

  const other = run(
    terms(legacy(), rendered()),
    {
      "docs/a.md": "The rendered view and legacy view here.\n",
      "docs/b.md": "rendered view\nold preview\n",
    },
    [{ path: "docs/b.md", before: "rendered view\nhtml preview\n" }],
  );
  assert.deepEqual(other.findings, [
    'docs/b.md:2:1 P001 "old preview" is rejected: use "legacy view" (legacy-view)',
  ]);
});

test("5.4 base: a file copied with from while its source stays shares its source's base findings", () => {
  // Both copies of the base finding form one group, so only the copy past the base count is
  // introduced: the second in finding order, docs/old.md before docs/new.md.
  const result = run(
    BASE_TERMS,
    { "docs/new.md": "html preview\n", "docs/old.md": "html preview\n" },
    [{ path: "docs/new.md", from: "docs/old.md", before: "html preview\n" }],
  );
  assert.deepEqual(result.findings, [`docs/old.md:1:1 P001 ${P001}`]);
});

test("5.4 regions: a newly deprecated entry without a replacement gives an introduced P002", () => {
  const before = terms(rendered());
  const after = terms(rendered({ status: "deprecated", reason: "out-of-scope" }));
  const result = run(after, { "docs/a.md": "rendered view\n" }, [{ path: TERMS, before }]);
  assert.deepEqual(result.findings, [
    'docs/a.md:1:1 P002 "rendered view" is deprecated (out-of-scope)',
  ]);
});

test("5.4 occurrences: order by id, then path, line, and column", () => {
  const termsText = terms(rendered(), termsFileEntry());
  const result = run(
    termsText,
    {
      "docs/a.md": "The rendered view here.\n",
      "docs/b.md": "The terms file here.\n",
      "docs/x.md": "terms file\nrendered view\n",
      "docs/y.md": "rendered view terms file\n",
    },
    [
      { path: "docs/x.md", before: null },
      { path: "docs/y.md", before: null },
    ],
  );
  assert.deepEqual(
    result.occurrences.map(({ id, path, line, column }) => `${id} ${path}:${line}:${column}`),
    [
      "rendered-view docs/x.md:2:1",
      "rendered-view docs/y.md:1:1",
      "terms-file docs/x.md:1:1",
      "terms-file docs/y.md:1:15",
    ],
  );
});

test("5.4 occurrences: reject and deprecated occurrences are omitted", () => {
  const result = run(
    terms(legacy({ status: "deprecated", reason: "out-of-scope" }), rendered()),
    {
      "docs/a.md": "The rendered view here.\n",
      "docs/c.md": "html preview old preview legacy view\n",
    },
    [{ path: "docs/c.md", before: null }],
  );
  assert.deepEqual(result.occurrences, []);
});

test("5.4 base: the same before text checked again after the fix reports no finding", () => {
  const termsText = terms(rendered());
  const before = "rendered view\n";
  const changes: Change[] = [{ path: "docs/b.md", before }];
  const first = run(
    termsText,
    { "docs/a.md": "The rendered view here.\n", "docs/b.md": "rendered view\nhtml preview\n" },
    changes,
  );
  assert.deepEqual(first.findings, [`docs/b.md:2:1 P001 ${P001}`]);
  const fixed = run(
    termsText,
    { "docs/a.md": "The rendered view here.\n", "docs/b.md": "rendered view\nrendered view\n" },
    changes,
  );
  assert.deepEqual(fixed.findings, []);
});
