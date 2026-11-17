import assert from "node:assert/strict";
import { test } from "node:test";
import { runOperation, type OperationParams, type OperationResult } from "../lib/operations.ts";
import { parseTermsFile } from "../lib/terms-file.ts";

type Success = Extract<OperationResult, { ok: true }>;

const DATE = "2026-11-14";
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The fixture terms file: two active entries, `alpha-term` with one reject phrase. */
const FIXTURE = `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: active
    reject:
      - old alpha
    history:
      - { date: 2024-01-01, op: add }
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - { date: 2024-01-01, op: add }
`;

/** The fixture with a deprecated entry `old-term`, for refusals 3. */
const WITH_DEPRECATED =
  FIXTURE +
  `  - id: old-term
    label: Old term
    meaning: Gone.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: deprecated
    reason: out-of-scope
    history:
      - { date: 2024-01-01, op: add }
      - { date: 2024-02-01, op: deprecate, reason: out-of-scope }
`;

/**
 * The fixture with a deprecated entry `old-term` that has a reason, a replacement, and a reject
 * phrase, for returning it to active.
 */
const WITH_REPLACEMENT = `${FIXTURE}  - id: old-term
    label: Old term
    meaning: Gone.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: deprecated
    reject:
      - ancient term
    replacedBy:
      - beta
    reason: renamed
    history:
      - { date: 2024-01-01, op: add }
      - { date: 2024-02-01, op: deprecate, reason: renamed, replacedBy: [beta] }
`;

/** The canonical text `WITH_REPLACEMENT` takes when `old-term` is returned to active. */
const REACTIVATED = `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: active
    reject:
      - old alpha
    history:
      - date: 2024-01-01
        op: add
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
  - id: old-term
    label: Old term
    meaning: Gone.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    reject:
      - ancient term
    history:
      - date: 2024-01-01
        op: add
      - date: 2024-02-01
        op: deprecate
        reason: renamed
        replacedBy:
          - beta
      - date: 2026-11-14
        op: update
        status: deprecated
`;

/** The fixture with a deprecated entry `old-term` whose label the active entry `beta` has. */
const WITH_TAKEN_LABEL = `${FIXTURE}  - id: old-term
    label: Beta
    meaning: Gone.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: deprecated
    reason: out-of-scope
    history:
      - { date: 2024-01-01, op: add }
      - { date: 2024-02-01, op: deprecate, reason: out-of-scope }
`;

/** The fixture with a third active entry, `gamma`, for split. */
const WITH_GAMMA =
  FIXTURE +
  `  - id: gamma
    label: Gamma
    meaning: G.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - { date: 2024-01-01, op: add }
`;

const DOCS: Record<string, string> = {
  "docs/a.md": "# A\n\nThe Alpha term and old alpha, Alpha terms.\n",
  "docs/b.md": "Beta here. Old alphas. alpha-terms.\n",
};

function run(
  termsText: string | undefined,
  op: OperationParams,
  documents: Record<string, string> = DOCS,
): OperationResult {
  return runOperation({
    termsBytes: termsText === undefined ? undefined : enc(termsText),
    documents: new Map(Object.entries(documents)),
    date: DATE,
    op,
  });
}

function succeeded(result: OperationResult): Success {
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  return result;
}

function refusalOf(result: OperationResult): string {
  if (result.ok) {
    assert.fail("expected a refusal");
  }
  return result.refusal;
}

// ---------------------------------------------------------------------------------------------
// 6.1 Common rules

test("6.1 refuses an absent terms file for an operation other than add and import", () => {
  const result = run(undefined, { op: "rename", id: "alpha-term", label: "Alpha" });
  assert.equal(refusalOf(result), "no terms file at .pi/pi-dent/terms.yaml");
});

test("6.1 refuses a terms file with a T001 finding before any other refusal", () => {
  const result = run("root: 1\nterms: []\n", { op: "rename", id: "nope", label: "X" });
  assert.equal(
    refusalOf(result),
    '.pi/pi-dent/terms.yaml has T001 findings; fix them first: .pi/pi-dent/terms.yaml:1:1 T001 (root): unknown keys "root"',
  );
});

test("6.1 refusal 3 gives no entry for an unknown id", () => {
  assert.equal(refusalOf(run(FIXTURE, { op: "rename", id: "nope", label: "X" })), "no entry nope");
});

test("6.1 refusal 3 gives is deprecated for a deprecated id", () => {
  assert.equal(
    refusalOf(run(WITH_DEPRECATED, { op: "rename", id: "old-term", label: "X" })),
    "old-term is deprecated",
  );
  assert.equal(
    refusalOf(run(WITH_DEPRECATED, { op: "merge", id: "alpha-term", into: "old-term" })),
    "old-term is deprecated",
  );
});

test("6.1 refusal 3 checks the parameter order, then the list order", () => {
  assert.equal(
    refusalOf(run(WITH_DEPRECATED, { op: "merge", id: "nope", into: "old-term" })),
    "no entry nope",
  );
  assert.equal(
    refusalOf(
      run(WITH_DEPRECATED, {
        op: "deprecate",
        id: "alpha-term",
        reason: "renamed",
        replacedBy: ["nope", "old-term"],
      }),
    ),
    "no entry nope",
  );
  assert.equal(
    refusalOf(
      run(WITH_DEPRECATED, {
        op: "deprecate",
        id: "alpha-term",
        reason: "renamed",
        replacedBy: ["old-term", "nope"],
      }),
    ),
    "old-term is deprecated",
  );
});

test("6.1 refusal 4 gives the first T002 finding that concerns a changed entry", () => {
  const result = run(FIXTURE, { op: "rename", id: "beta", label: "Alpha term" });
  assert.equal(
    refusalOf(result),
    'rename refused: .pi/pi-dent/terms.yaml:15:12 T002 beta: "Alpha term" is also a label or form of alpha-term',
  );
});

test("6.1 is deterministic: the same inputs give the same output", () => {
  const op: OperationParams = { op: "merge", id: "alpha-term", into: "beta" };
  const first = succeeded(run(FIXTURE, op));
  const reversed = Object.fromEntries(Object.entries(DOCS).reverse());
  const second = succeeded(run(FIXTURE, op));
  const third = succeeded(run(FIXTURE, op, reversed));
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("6.1 an owner is used with its leading and trailing white space removed", () => {
  const add = (owner: string, documents: Record<string, string>) =>
    succeeded(
      run(
        undefined,
        {
          op: "add",
          id: "thing",
          label: "Thing",
          meaning: "A thing.",
          owner,
          group: "Terms",
          key: "confusable",
        },
        documents,
      ),
    );
  // U+0085 has the White_Space property, so it is trailing white space.
  assert.match(add("a.md\u0085", { "a.md": "The Thing.\n" }).text, /^ {4}owner: a\.md$/mu);
  // A space inside the path is not leading or trailing, so it stays.
  assert.match(add("a  b.md", { "a  b.md": "The Thing.\n" }).text, /^ {4}owner: a {2}b\.md$/mu);
});

// ---------------------------------------------------------------------------------------------
// 6.2 add

test("6.2 adds an active entry to an absent terms file", () => {
  const result = succeeded(
    run(
      undefined,
      {
        op: "add",
        id: "gamma",
        label: "Gamma",
        meaning: "G.",
        owner: "docs/b.md",
        group: "Terms",
        key: "confusable",
        reject: ["gam"],
      },
      { "docs/b.md": "A gam and gams.\n" },
    ),
  );
  assert.equal(
    result.text,
    `terms:
  - id: gamma
    label: Gamma
    meaning: G.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    reject:
      - gam
    history:
      - date: 2026-11-14
        op: add
`,
  );
  assert.deepEqual(result.edits, [
    { path: "docs/b.md", line: 1, column: 3, old: "gam", new: "Gamma" },
    { path: "docs/b.md", line: 1, column: 11, old: "gams", new: "Gammas" },
  ]);
  assert.deepEqual(result.summary, { op: "add" });
});

test("6.2 inserts the entry at its place in id order", () => {
  const result = succeeded(
    run(FIXTURE, {
      op: "add",
      id: "aardvark",
      label: "Aardvark",
      meaning: "A.",
      owner: "docs/a.md",
      group: "Terms",
      key: "confusable",
    }),
  );
  const ids = [...result.text.matchAll(/^  - id: (.*)$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ["aardvark", "alpha-term", "beta"]);
});

test("6.2 refuses an id that is already an entry", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, {
        op: "add",
        id: "beta",
        label: "Beta two",
        meaning: "B.",
        owner: "docs/b.md",
        group: "Terms",
        key: "confusable",
      }),
    ),
    "beta is already an entry",
  );
});

test("6.2 refusal 4 gives the T003 finding of a distinguish id that names no entry", () => {
  const result = run(undefined, {
    op: "add",
    id: "gamma",
    label: "Gamma",
    meaning: "G.",
    owner: "docs/b.md",
    group: "Terms",
    key: "confusable",
    distinguish: ["nope"],
  });
  assert.equal(
    refusalOf(result),
    "add refused: .pi/pi-dent/terms.yaml:10:9 T003 gamma: distinguish names nope, which is not an entry",
  );
});

test("6.2 edit list: capitalised and plural variants get capitalised and plural suggestions", () => {
  const result = succeeded(
    run(
      undefined,
      {
        op: "add",
        id: "gamma",
        label: "Gamma",
        meaning: "G.",
        owner: "docs/b.md",
        group: "Terms",
        key: "confusable",
        reject: ["gam"],
      },
      { "docs/b.md": "Gam starts. Gams and gam.\n" },
    ),
  );
  assert.deepEqual(result.edits, [
    { path: "docs/b.md", line: 1, column: 1, old: "Gam", new: "Gamma" },
    { path: "docs/b.md", line: 1, column: 13, old: "Gams", new: "Gammas" },
    { path: "docs/b.md", line: 1, column: 22, old: "gam", new: "Gamma" },
  ]);
});

test("6.2 edit list omits an occurrence a valid P001 suppression comment suppresses", () => {
  const result = succeeded(
    run(
      undefined,
      {
        op: "add",
        id: "gamma",
        label: "Gamma",
        meaning: "G.",
        owner: "docs/b.md",
        group: "Terms",
        key: "confusable",
        reject: ["gam"],
      },
      { "docs/b.md": "<!-- terms-ignore P001: legacy wording -->\nA gam here.\nAnother gam.\n" },
    ),
  );
  assert.deepEqual(result.edits, [
    { path: "docs/b.md", line: 3, column: 9, old: "gam", new: "Gamma" },
  ]);
});

// ---------------------------------------------------------------------------------------------
// 6.9 update

test("6.9 updates key and reject phrases, records history, and lists newly added reject uses", () => {
  const result = succeeded(
    run(
      FIXTURE,
      {
        op: "update",
        id: "alpha-term",
        key: "local",
        addReject: ["alpha alias"],
      },
      { "docs/a.md": "Alpha term; alpha alias.\n", "docs/b.md": "Beta.\n" },
    ),
  );
  assert.ok(result.text.includes("    key: local\n"));
  assert.ok(result.text.includes("      - alpha alias\n"));
  assert.ok(result.text.includes("      - date: 2026-11-14\n        op: update\n"));
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 1, column: 13, old: "alpha alias", new: "Alpha term" },
  ]);
});

test("6.9 update requires an active existing entry before checking its changes", () => {
  assert.equal(refusalOf(run(FIXTURE, { op: "update", id: "missing" })), "no entry missing");
  assert.equal(
    refusalOf(run(WITH_DEPRECATED, { op: "update", id: "old-term" })),
    "old-term is deprecated",
  );
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term" })),
    "update makes no changes to alpha-term",
  );
});

test("6.9 update refuses already-present rejects and missing distinguish relations", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", addReject: ["old  alpha"] })),
    'alpha-term already rejects "old alpha"',
  );
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", removeDistinguish: ["beta"] })),
    "alpha-term is not distinguished from beta",
  );
});

test("6.9 update refuses a new reject equal to a label through the common T002 check", () => {
  assert.match(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", addReject: ["Beta"] })),
    /^update refused: .* T002 beta: "Beta" is a reject phrase of alpha-term$/,
  );
});

test("6.9 update refuses duplicate normalized list values before semantic checks", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, { op: "update", id: "alpha-term", addReject: ["two words", "two  words"] }),
    ),
    'addReject repeats "two words"',
  );
});

test("6.9 update refuses overlaps, missing phrases, and unchanged updates in spec order", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, { op: "update", id: "alpha-term", addReject: ["same"], removeReject: ["same"] }),
    ),
    'update cannot add and remove reject "same"',
  );
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", removeReject: ["missing"] })),
    'alpha-term does not reject "missing"',
  );
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", key: "shared" })),
    "update makes no changes to alpha-term",
  );
});

test("6.9 distinguish validation refuses unknown and self ids, then existing relations", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", addDistinguish: ["missing"] })),
    "no entry missing",
  );
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", addDistinguish: ["alpha-term"] })),
    "cannot distinguish alpha-term from itself",
  );
  const relation = FIXTURE.replace(
    "    status: active\n    history:",
    "    status: active\n    distinguish:\n      - alpha-term\n    history:",
  );
  assert.equal(
    refusalOf(run(relation, { op: "update", id: "alpha-term", addDistinguish: ["beta"] })),
    "alpha-term is already distinguished from beta",
  );
  assert.equal(
    refusalOf(run(relation, { op: "update", id: "alpha-term", removeDistinguish: ["missing"] })),
    "no entry missing",
  );
});

test("6.9 distinguish additions are symmetric and record history on both entries", () => {
  const result = succeeded(
    run(FIXTURE, { op: "update", id: "alpha-term", addDistinguish: ["beta"] }),
  );
  assert.equal((result.text.match(/op: update/g) ?? []).length, 2);
  assert.match(result.text, /distinguish:\n      - beta/);
  assert.match(result.text, /distinguish:\n      - alpha-term/);
});

test("6.9 removing a relation stored only on the other entry changes only that entry", () => {
  const linked = FIXTURE.replace(
    "    status: active\n    history:",
    "    status: active\n    distinguish:\n      - alpha-term\n    history:",
  );
  const result = succeeded(
    run(linked, { op: "update", id: "alpha-term", removeDistinguish: ["beta"] }),
  );
  assert.equal((result.text.match(/op: update/g) ?? []).length, 1);
  assert.ok(result.text.includes("      - date: 2026-11-14\n        op: update\n"));
});

test("6.9 update refuses distinguish additions and removals that overlap", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, {
        op: "update",
        id: "alpha-term",
        addDistinguish: ["beta"],
        removeDistinguish: ["beta"],
      }),
    ),
    "update cannot add and remove distinguish beta",
  );
});

test("6.9 update rejects repeated removeDistinguish values after normalization", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, { op: "update", id: "alpha-term", removeDistinguish: ["beta", " beta "] }),
    ),
    'removeDistinguish repeats "beta"',
  );
});

test("6.9 update checks missing removals before already-present additions", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, {
        op: "update",
        id: "alpha-term",
        addReject: ["old alpha"],
        removeReject: ["missing"],
      }),
    ),
    'alpha-term does not reject "missing"',
  );
});

test("6.9 symmetric distinguish removal writes history for both changed entries", () => {
  const linked = FIXTURE.replace(
    "    label: Alpha term\n",
    "    label: Alpha term\n    distinguish:\n      - beta\n",
  ).replace("    label: Beta\n", "    label: Beta\n    distinguish:\n      - alpha-term\n");
  const result = succeeded(
    run(linked, { op: "update", id: "alpha-term", removeDistinguish: ["beta"] }),
  );
  assert.equal((result.text.match(/op: update/g) ?? []).length, 2);
  assert.doesNotMatch(result.text, /distinguish:/);
});

test("6.9 update changes the meaning and keeps the old one in one history item", () => {
  const result = succeeded(
    run(FIXTURE, { op: "update", id: "alpha-term", meaning: "A new thing." }),
  );
  assert.ok(result.text.includes("    meaning: A new thing.\n"));
  assert.ok(
    result.text.includes(
      "      - date: 2026-11-14\n        op: update\n        meaning: A thing.\n",
    ),
  );
  assert.equal((result.text.match(/op: update/g) ?? []).length, 1);
});

test("6.9 an unchanged meaning on its own is refused as no change", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", meaning: "A thing." })),
    "update makes no changes to alpha-term",
  );
});

test("6.9 an unchanged meaning alongside a key change succeeds without a meaning operand", () => {
  const result = succeeded(
    run(FIXTURE, { op: "update", id: "alpha-term", key: "local", meaning: "A thing." }),
  );
  assert.ok(result.text.includes("    key: local\n"));
  assert.ok(result.text.includes("      - date: 2026-11-14\n        op: update\n"));
  assert.equal(result.text.match(/        meaning: /g), null);
});

test("6.9 a meaning that differs only in case is a change", () => {
  const result = succeeded(run(FIXTURE, { op: "update", id: "alpha-term", meaning: "a thing." }));
  assert.ok(result.text.includes("    meaning: a thing.\n"));
  assert.ok(result.text.includes("        meaning: A thing.\n"));
});

test("6.9 a meaning is normalised before the comparison, so a white-space-only difference is no change", () => {
  const result = run(FIXTURE, { op: "update", id: "alpha-term", meaning: " A \t thing. " });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.refusal === "update makes no changes to alpha-term");
});

test("6.9 a new meaning is stored normalised", () => {
  const result = succeeded(
    run(FIXTURE, { op: "update", id: "alpha-term", meaning: "A  new\tthing." }),
  );
  assert.ok(result.text.includes("    meaning: A new thing.\n"));
});

test("6.9 a reciprocal distinguish entry gets no meaning operand", () => {
  const result = succeeded(
    run(FIXTURE, {
      op: "update",
      id: "alpha-term",
      meaning: "A new thing.",
      addDistinguish: ["beta"],
    }),
  );
  const file = parseTermsFile(new TextEncoder().encode(result.text));
  const history = (id: string) =>
    file.entries.find((record) => record.entry.id === id)?.entry.history.at(-1);
  assert.deepEqual(history("alpha-term"), {
    date: DATE,
    op: "update",
    meaning: "A thing.",
  });
  assert.deepEqual(history("beta"), { date: DATE, op: "update" });
});

test("6.9 a changed meaning is still checked by refusal 4 on the proposed file", () => {
  assert.match(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", meaning: " \n " })),
    /^update refused: .* T001 /,
  );
});

test("6.9 status active returns a deprecated entry to active and records its old status", () => {
  const result = succeeded(
    run(WITH_REPLACEMENT, { op: "update", id: "old-term", status: "active" }),
  );
  assert.equal(result.text, REACTIVATED);
  assert.deepEqual(result.edits, []);
});

test("6.9 reactivation with a meaning change records both operands in one history item", () => {
  const result = succeeded(
    run(WITH_REPLACEMENT, {
      op: "update",
      id: "old-term",
      status: "active",
      meaning: "Back again.",
    }),
  );
  assert.equal((result.text.match(/op: update/g) ?? []).length, 1);
  assert.ok(result.text.includes("    meaning: Back again.\n"));
  assert.ok(
    result.text.includes(
      "      - date: 2026-11-14\n        op: update\n        meaning: Gone.\n        status: deprecated\n",
    ),
  );
});

test("6.9 update refuses a deprecated id without status and an unknown id with it", () => {
  assert.equal(
    refusalOf(run(WITH_REPLACEMENT, { op: "update", id: "old-term", meaning: "Back again." })),
    "old-term is deprecated",
  );
  assert.equal(
    refusalOf(run(WITH_REPLACEMENT, { op: "update", id: "old-term", addReject: ["ancient term"] })),
    "old-term is deprecated",
  );
  assert.equal(
    refusalOf(run(WITH_REPLACEMENT, { op: "update", id: "nope", status: "active" })),
    "no entry nope",
  );
});

test("6.9 an unchanged status alone is refused as no change", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "update", id: "alpha-term", status: "active" })),
    "update makes no changes to alpha-term",
  );
  const result = succeeded(
    run(FIXTURE, { op: "update", id: "alpha-term", status: "active", key: "local" }),
  );
  assert.ok(result.text.includes("    key: local\n"));
  const file = parseTermsFile(new TextEncoder().encode(result.text));
  assert.deepEqual(
    file.entries.find((record) => record.entry.id === "alpha-term")?.entry.history.at(-1),
    { date: DATE, op: "update" },
  );
});

test("6.9 reactivating an entry whose label an active entry has taken is refused", () => {
  assert.match(
    refusalOf(run(WITH_TAKEN_LABEL, { op: "update", id: "old-term", status: "active" })),
    /^update refused: .* T002 old-term: "Beta" is also a label or form of beta$/,
  );
});

// ---------------------------------------------------------------------------------------------
// 6.3 rename

test("6.3 appends the old label and forms to reject and sets the new label and forms", () => {
  const terms = `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: active
    forms:
      - alpha-terms
    reject:
      - old alpha
      - Alpha
    history:
      - { date: 2024-01-01, op: add }
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - { date: 2024-01-01, op: add }
`;
  const result = succeeded(
    run(terms, { op: "rename", id: "alpha-term", label: "Alpha", forms: ["alphas"] }),
  );
  assert.equal(
    result.text,
    `terms:
  - id: alpha-term
    label: Alpha
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: active
    reject:
      - old alpha
      - Alpha term
      - alpha-terms
    forms:
      - alphas
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: rename
        from: Alpha term
        to: Alpha
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
`,
  );
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 3, column: 5, old: "Alpha term", new: "Alpha" },
    { path: "docs/a.md", line: 3, column: 31, old: "Alpha terms", new: "Alphas" },
    { path: "docs/b.md", line: 1, column: 24, old: "alpha-terms", new: null },
  ]);
  assert.deepEqual(result.summary, { op: "rename", oldLabel: "Alpha term" });
});

test("6.3 refuses a rename to the label the entry has", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "rename", id: "alpha-term", label: "Alpha  term" })),
    'alpha-term is already labelled "Alpha term"',
  );
});

// ---------------------------------------------------------------------------------------------
// 6.4 merge

test("6.4 merge deprecates the entry, moves its reject phrases, and writes the history", () => {
  const result = succeeded(run(FIXTURE, { op: "merge", id: "alpha-term", into: "beta" }));
  assert.equal(
    result.text,
    `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: deprecated
    replacedBy:
      - beta
    reason: merged
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: merge
        into: beta
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    reject:
      - old alpha
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: merge
        from: alpha-term
`,
  );
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 3, column: 5, old: "Alpha term", new: "Beta" },
    { path: "docs/a.md", line: 3, column: 20, old: "old alpha", new: "Beta" },
    { path: "docs/a.md", line: 3, column: 31, old: "Alpha terms", new: "Betas" },
    { path: "docs/b.md", line: 1, column: 12, old: "Old alphas", new: "Betas" },
  ]);
});

test("6.4 refuses a merge into the same entry", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "merge", id: "beta", into: "beta" })),
    "cannot merge beta into itself",
  );
});

// ---------------------------------------------------------------------------------------------
// 6.5 split

test("6.5 split deprecates the entry and gives each target a history item", () => {
  const result = succeeded(
    run(WITH_GAMMA, { op: "split", id: "alpha-term", into: ["beta", "gamma"] }),
  );
  assert.equal(
    result.text,
    `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: deprecated
    reject:
      - old alpha
    replacedBy:
      - beta
      - gamma
    reason: split
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: split
        into:
          - beta
          - gamma
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: split
        from: alpha-term
  - id: gamma
    label: Gamma
    meaning: G.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: split
        from: alpha-term
`,
  );
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 3, column: 5, old: "Alpha term", new: null },
    { path: "docs/a.md", line: 3, column: 31, old: "Alpha terms", new: null },
  ]);
});

test("6.5 refusal 4 gives the T004 finding of a split into one entry", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "split", id: "alpha-term", into: ["beta"] })),
    "split refused: .pi/pi-dent/terms.yaml:13:13 T004 alpha-term: reason split needs at least two replacements, has 1",
  );
});

test("6.5 refusal 4 gives the T003 finding of a split that names the entry itself", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "split", id: "alpha-term", into: ["alpha-term", "beta"] })),
    "split refused: .pi/pi-dent/terms.yaml:12:9 T003 alpha-term: replacedBy names the entry itself",
  );
});

// ---------------------------------------------------------------------------------------------
// 6.6 deprecate

test("6.6 renamed deprecation with one replacement moves the reject phrases to it", () => {
  const result = succeeded(
    run(FIXTURE, { op: "deprecate", id: "alpha-term", reason: "renamed", replacedBy: ["beta"] }),
  );
  assert.equal(
    result.text,
    `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: deprecated
    replacedBy:
      - beta
    reason: renamed
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: deprecate
        reason: renamed
        replacedBy:
          - beta
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    reject:
      - old alpha
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: deprecate
        from: alpha-term
`,
  );
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 3, column: 5, old: "Alpha term", new: "Beta" },
    { path: "docs/a.md", line: 3, column: 20, old: "old alpha", new: "Beta" },
    { path: "docs/a.md", line: 3, column: 31, old: "Alpha terms", new: "Betas" },
    { path: "docs/b.md", line: 1, column: 12, old: "Old alphas", new: "Betas" },
  ]);
});

test("6.6 out-of-scope deprecation keeps the reject phrases and suggests nothing", () => {
  const result = succeeded(
    run(FIXTURE, { op: "deprecate", id: "alpha-term", reason: "out-of-scope" }),
  );
  assert.equal(
    result.text,
    `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: shared
    status: deprecated
    reject:
      - old alpha
    reason: out-of-scope
    history:
      - date: 2024-01-01
        op: add
      - date: 2026-11-14
        op: deprecate
        reason: out-of-scope
  - id: beta
    label: Beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
`,
  );
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 3, column: 5, old: "Alpha term", new: null },
    { path: "docs/a.md", line: 3, column: 31, old: "Alpha terms", new: null },
  ]);
});

test("6.6 refusal 4 gives the T004 finding of an out-of-scope deprecation with a replacement", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, {
        op: "deprecate",
        id: "alpha-term",
        reason: "out-of-scope",
        replacedBy: ["beta"],
      }),
    ),
    "deprecate refused: .pi/pi-dent/terms.yaml:11:13 T004 alpha-term: reason out-of-scope takes no replacement, has 1",
  );
});

test("6.6 refusal 4 gives the T004 finding of a renamed deprecation without a replacement", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "deprecate", id: "alpha-term", reason: "renamed" })),
    "deprecate refused: .pi/pi-dent/terms.yaml:11:13 T004 alpha-term: reason renamed needs exactly one replacement, has 0",
  );
});

// ---------------------------------------------------------------------------------------------
// 6.7 reown

test("6.7 reown sets the owner, writes the history, and gives no edits", () => {
  const result = succeeded(run(FIXTURE, { op: "reown", id: "alpha-term", owner: "docs/b.md" }));
  assert.equal(
    result.text,
    FIXTURE.replace("    owner: docs/a.md\n", "    owner: docs/b.md\n")
      .replace(
        "      - { date: 2024-01-01, op: add }\n  - id: beta",
        "      - date: 2024-01-01\n        op: add\n      - date: 2026-11-14\n        op: reown\n        from: docs/a.md\n        to: docs/b.md\n  - id: beta",
      )
      .replace(
        "      - { date: 2024-01-01, op: add }\n",
        "      - date: 2024-01-01\n        op: add\n",
      ),
  );
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.summary, { op: "reown", oldOwner: "docs/a.md" });
});

test("6.7 refuses an owner that the entry already has", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "reown", id: "alpha-term", owner: " docs/a.md " })),
    "alpha-term is already owned by docs/a.md",
  );
});

test("6.7 refusal 4 gives the T003 finding of an owner that is not a document", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "reown", id: "alpha-term", owner: "docs/zz.md" })),
    "reown refused: .pi/pi-dent/terms.yaml:5:12 T003 alpha-term: owner docs/zz.md is not a document",
  );
});

// ---------------------------------------------------------------------------------------------
// Edit lists and refusal 4 across operations

test("6.4 an occurrence from a deprecated form has no suggested text", () => {
  const terms = FIXTURE.replace(
    "    status: active\n    reject:",
    "    status: active\n    forms:\n      - alpha-terms\n    reject:",
  );
  const result = succeeded(
    run(
      terms,
      { op: "merge", id: "alpha-term", into: "beta" },
      {
        "docs/a.md": "",
        "docs/b.md": "alpha-terms.\n",
      },
    ),
  );
  assert.deepEqual(result.edits, [
    { path: "docs/b.md", line: 1, column: 1, old: "alpha-terms", new: null },
  ]);
});

test("6.5 edit list omits a deprecated occurrence a valid P002 suppression comment suppresses", () => {
  const result = succeeded(
    run(
      WITH_GAMMA,
      { op: "split", id: "alpha-term", into: ["beta", "gamma"] },
      {
        "docs/a.md":
          "<!-- terms-ignore P002: kept for history -->\nAlpha term here.\nAnother Alpha term.\n",
        "docs/b.md": "",
      },
    ),
  );
  assert.deepEqual(result.edits, [
    { path: "docs/a.md", line: 3, column: 9, old: "Alpha term", new: null },
  ]);
});

test("6.1 refusal 4 gives the T001 finding of an added entry left out by its owner", () => {
  assert.equal(
    refusalOf(
      run(FIXTURE, {
        op: "add",
        id: "b-new",
        label: "Bee",
        meaning: "B.",
        owner: "b.txt",
        group: "Terms",
        key: "confusable",
      }),
    ),
    "add refused: .pi/pi-dent/terms.yaml:17:12 T001 terms[1].owner: must be an owner path ending with .md",
  );
});

test("6.1 refusal 4 gives the T001 repeats finding of a split into one id twice", () => {
  assert.equal(
    refusalOf(run(FIXTURE, { op: "split", id: "alpha-term", into: ["beta", "beta"] })),
    'split refused: .pi/pi-dent/terms.yaml:13:9 T001 terms[0].replacedBy[1]: repeats "beta"',
  );
});

test("6.6 changed: an out-of-scope deprecation with two replacements changes only the entry", () => {
  // alpha-term carries a T003 finding that predates the operation; it must not block it.
  const terms = WITH_GAMMA.replace(
    "    key: shared\n    status: active\n",
    "    key: shared\n    status: active\n    distinguish:\n      - zzz\n",
  );
  assert.equal(
    refusalOf(
      run(terms, {
        op: "deprecate",
        id: "beta",
        reason: "out-of-scope",
        replacedBy: ["alpha-term", "gamma"],
      }),
    ),
    "deprecate refused: .pi/pi-dent/terms.yaml:26:13 T004 beta: reason out-of-scope takes no replacement, has 2",
  );
});

test("6.3 the old label is kept as written in reject, history, and summary", () => {
  const terms = FIXTURE.replace("    label: Alpha term\n", "    label: Alpha  term\n");
  const result = succeeded(run(terms, { op: "rename", id: "alpha-term", label: "Alpha" }));
  assert.ok(result.text.includes("\n      - Alpha  term\n"), result.text);
  assert.ok(
    result.text.includes(
      "      - date: 2026-11-14\n        op: rename\n        from: Alpha  term\n        to: Alpha\n",
    ),
  );
  assert.deepEqual(result.summary, { op: "rename", oldLabel: "Alpha  term" });
});

test("6.1 normalises the key and reason parameters", () => {
  const added = succeeded(
    run(FIXTURE, {
      op: "add",
      id: "gamma",
      label: "Gamma",
      meaning: "G.",
      owner: "docs/b.md",
      group: "Terms",
      key: " shared ",
    }),
  );
  assert.ok(
    added.text.includes(
      "  - id: gamma\n    label: Gamma\n    meaning: G.\n    owner: docs/b.md\n    group: Terms\n    key: shared\n",
    ),
    added.text,
  );

  const deprecated = succeeded(
    run(FIXTURE, { op: "deprecate", id: "alpha-term", reason: " out-of-scope ", replacedBy: [] }),
  );
  assert.ok(deprecated.text.includes("    reason: out-of-scope\n"), deprecated.text);
  assert.ok(
    deprecated.text.includes(
      "      - date: 2026-11-14\n        op: deprecate\n        reason: out-of-scope\n",
    ),
    deprecated.text,
  );
});

test("6.1 refusal 4 gives the T001 finding of a changed entry that is left out", () => {
  const result = run(FIXTURE, {
    op: "add",
    id: "gamma",
    label: "",
    meaning: "G.",
    owner: "docs/b.md",
    group: "Terms",
    key: "confusable",
  });
  assert.match(
    refusalOf(result),
    /^add refused: \.pi\/pi-dent\/terms\.yaml:\d+:\d+ T001 terms\[2\]\.label: must be a phrase \(one trimmed line holding a letter, mark, or digit\)$/,
  );
});

test("6.1 refusal 4 gives the T002 finding that concerns the changed entry and the entry it clashes with", () => {
  const text = `terms:\n  - id: alpha\n    label: alpha\n    meaning: A thing.\n    owner: docs/a.md\n    group: Terms\n    key: confusable\n    status: active\n    history:\n      - { date: 2024-01-01, op: add }\n  - id: beta\n    label: alpha\n    meaning: Another.\n    owner: docs/b.md\n    group: Terms\n    key: confusable\n    status: active\n    history:\n      - { date: 2024-01-01, op: add }\n`;
  const result = runOperation({
    termsBytes: enc(text),
    documents: new Map([
      ["docs/a.md", "alpha\n"],
      ["docs/b.md", "alpha\n"],
    ]),
    date: DATE,
    op: { op: "reown", id: "alpha", owner: "docs/b.md" },
  });
  assert.equal(
    refusalOf(result),
    'reown refused: .pi/pi-dent/terms.yaml:17:12 T002 beta: "alpha" is also a label or form of alpha',
  );
});

test("6.1 refusal 4 gives the T003 cycle finding of a changed entry in the cycle", () => {
  const text = `terms:
  - id: alpha
    label: alpha
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: deprecated
    replacedBy:
      - zeta
    reason: renamed
    history:
      - { date: 2024-01-01, op: add }
  - id: zeta
    label: zeta
    meaning: Z.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: active
    replacedBy: [alpha]
    history:
      - { date: 2024-01-01, op: add }
`;
  const result = runOperation({
    termsBytes: enc(text),
    documents: new Map([
      ["docs/a.md", "alpha\n"],
      ["docs/b.md", "zeta\n"],
    ]),
    date: DATE,
    op: { op: "reown", id: "zeta", owner: "docs/b.md" },
  });
  assert.equal(
    refusalOf(result),
    "reown refused: .pi/pi-dent/terms.yaml:10:7 T003 alpha: replacedBy cycle through alpha, zeta",
  );
});

test("2.5 canonical: an operation leaves every untouched entry's lines byte for byte", () => {
  const settings = "settings:\n  checkAfterEdit: true\nterms:\n";
  const alpha = `  - id: alpha
    label: Alpha
    meaning: A thing.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: active
    history:
      - { date: 2024-01-01, op: add }
`;
  const beta = `  - id: beta
    label: Beta term
    meaning: A beta thing.
    owner: docs/b.md
    group: Terms
    key: shared
    status: active
    reject:
      - old beta
      - beta alt
    distinguish:
      - gamma
    forms:
      - betas
    history:
      - { date: 2024-01-01, op: add }
      - { date: 2024-01-02, op: update }
      - { date: 2024-01-03, op: import, from: docs/b.md }
      - { date: 2024-01-04, op: rename, from: Old beta, to: Beta term }
      - { date: 2024-01-05, op: merge, into: alpha }
      - { date: 2024-01-06, op: split, into: [alpha, gamma] }
      - { date: 2024-01-07, op: reown, from: docs/x.md, to: docs/b.md }
`;
  const gamma = `  - id: gamma
    label: Gamma
    meaning: A gamma thing.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: active
    history:
      - { date: 2024-01-01, op: add }
`;
  const zeta = `  - id: zeta
    label: Zeta
    meaning: Z.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: deprecated
    replacedBy:
      - alpha
    reason: merged
    history:
      - { date: 2024-01-01, op: add }
      - { date: 2024-01-08, op: deprecate, reason: merged, replacedBy: [alpha] }
`;
  const betaWritten = `  - id: beta
    label: Beta term
    meaning: A beta thing.
    owner: docs/b.md
    group: Terms
    key: shared
    status: active
    reject:
      - old beta
      - beta alt
    distinguish:
      - gamma
    forms:
      - betas
    history:
      - date: 2024-01-01
        op: add
      - date: 2024-01-02
        op: update
      - date: 2024-01-03
        op: import
        from: docs/b.md
      - date: 2024-01-04
        op: rename
        from: Old beta
        to: Beta term
      - date: 2024-01-05
        op: merge
        into: alpha
      - date: 2024-01-06
        op: split
        into:
          - alpha
          - gamma
      - date: 2024-01-07
        op: reown
        from: docs/x.md
        to: docs/b.md
`;
  const gammaWritten = `  - id: gamma
    label: Gamma
    meaning: A gamma thing.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
`;
  const zetaWritten = `  - id: zeta
    label: Zeta
    meaning: Z.
    owner: docs/a.md
    group: Terms
    key: confusable
    status: deprecated
    replacedBy:
      - alpha
    reason: merged
    history:
      - date: 2024-01-01
        op: add
      - date: 2024-01-08
        op: deprecate
        reason: merged
        replacedBy:
          - alpha
`;
  const text = settings + alpha + beta + gamma + zeta;
  const result = succeeded(
    run(
      text,
      { op: "reown", id: "alpha", owner: "docs/c.md" },
      {
        "docs/a.md": "Alpha Beta Gamma Zeta\n",
        "docs/b.md": "Beta term betas\n",
        "docs/c.md": "Alpha\n",
      },
    ),
  );
  assert.ok(result.text.startsWith(settings), result.text);
  assert.ok(result.text.includes("    owner: docs/c.md\n"), result.text);
  assert.ok(result.text.includes(betaWritten), result.text);
  assert.ok(result.text.includes(gammaWritten), result.text);
  assert.ok(result.text.includes(zetaWritten), result.text);
});

test("2.5 canonical: an operation writes the lines it does not change as the canonical text of its input", () => {
  // The input has flow-form history items, which the parser reads; the output is in block form.
  const canonical = `terms:\n  - id: alpha\n    label: alpha\n    meaning: A thing.\n    owner: docs/a.md\n    group: Terms\n    key: confusable\n    status: active\n    history:\n      - { date: 2024-01-01, op: add }\n  - id: beta\n    label: beta\n    meaning: Another.\n    owner: docs/b.md\n    group: Terms\n    key: confusable\n    status: active\n    history:\n      - { date: 2024-01-01, op: add }\n`;
  const result = succeeded(
    run(
      canonical,
      { op: "reown", id: "alpha", owner: "docs/b.md" },
      {
        "docs/a.md": "alpha\n",
        "docs/b.md": "alpha beta\n",
      },
    ),
  );
  assert.equal(
    result.text,
    `terms:
  - id: alpha
    label: alpha
    meaning: A thing.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
      - date: ${DATE}
        op: reown
        from: docs/a.md
        to: docs/b.md
  - id: beta
    label: beta
    meaning: Another.
    owner: docs/b.md
    group: Terms
    key: confusable
    status: active
    history:
      - date: 2024-01-01
        op: add
`,
  );
});

test("4.2 an occurrence's source text runs from the first to the last source character", () => {
  const result = succeeded(
    run(
      undefined,
      {
        op: "add",
        id: "ab",
        label: "Thing",
        meaning: "A thing.",
        owner: "docs/a.md",
        group: "Terms",
        key: "confusable",
        reject: ["a_b", "pi-dent terms"],
      },
      { "docs/a.md": "see a\\_b and pi-dent\n\n> pi-dent\n> terms\n" },
    ),
  );
  assert.deepEqual(
    result.edits.map((edit) => [edit.old, edit.line, edit.column, edit.new]),
    [
      ["a\\_b", 1, 5, "Thing"],
      ["pi-dent\n> terms", 3, 3, "Thing"],
    ],
  );
});
