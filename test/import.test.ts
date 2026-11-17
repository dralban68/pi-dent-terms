import assert from "node:assert/strict";
import { test } from "node:test";
import { runOperation, type OperationResult } from "../lib/operations.ts";

const DATE = "2026-11-14";
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const HEADER = "| Term | Meaning | Owner | Avoid or distinguish |\n| --- | --- | --- | --- |\n";

function run(documents: Record<string, string>, path: string, termsText?: string): OperationResult {
  return runOperation({
    termsBytes: termsText === undefined ? undefined : enc(termsText),
    documents: new Map(Object.entries(documents)),
    date: DATE,
    op: { op: "import", path },
  });
}

function refusalOf(result: OperationResult): string {
  if (result.ok) {
    assert.fail("expected a refusal");
  }
  return result.refusal;
}

/** A thesaurus document in `specs/`, with two sections and five rows. */
const THESAURUS = `# Terms

## Tool

${HEADER}| Terms | The tool. | [terms-tool.md](terms-tool.md) | terms file; term |
| terms file | The file. | [terms.md](terms.md) | \`terms.yaml\`; Terms |

## Other

${HEADER}| Alpha term | A thing. | docs/a.md#section | old alpha; Terms |
| Terms! | Duplicate. | ../x.md |  |
`;

/** The documents that the owners of THESAURUS name, so that its owners are documents. */
const OWNERS: Record<string, string> = {
  "specs/terms-tool.md": "",
  "specs/terms.md": "",
  "specs/docs/a.md": "",
  "x.md": "",
};

// ---------------------------------------------------------------------------------------------
// 6.8 import

for (const [name, owner, ownerText, otherText, key] of [
  ["only its owner uses it", "owner.md", "Alpha", "", "local"],
  ["only its owner uses it in a code span", "owner.md", "`Alpha`", "", "local"],
  ["its owner and another document use it", "owner.md", "Alpha", "Alpha", "shared"],
  ["only another document uses it", "owner.md", "", "Alpha", "shared"],
  ["no document uses it", "owner.md", "", "", "shared"],
  ["an external owner has a workspace use", "../owner.md", "Alpha", "", "shared"],
] as const) {
  test(`6.8 derives ${key} when ${name}`, () => {
    const source = `# Concepts\n\n${HEADER}| Alpha | A concept. | ${owner} | |\n`;
    const result = run(
      { "thesaurus.md": source, "owner.md": ownerText, "other.md": otherText },
      "thesaurus.md",
    );
    if (!result.ok) assert.fail(result.refusal);
    assert.match(result.text, new RegExp(`    key: ${key}\\n`));
    assert.deepEqual(result.summary, {
      op: "import",
      imported: 1,
      localIds: key === "local" ? ["alpha"] : [],
    });
  });
}

test("6.8 derives keys from the proposed matching and reports local ids in ascending order", () => {
  const source = `# Concepts\n\n${HEADER}| Zeta | A concept. | owner.md | |\n| Alpha term | A concept. | owner.md | |\n| Alpha | A concept. | owner.md | |\n`;
  const result = run(
    { "thesaurus.md": source, "owner.md": "Alpha term and Zeta." },
    "thesaurus.md",
  );
  if (!result.ok) assert.fail(result.refusal);
  assert.match(result.text, /id: alpha\n[\s\S]*?key: shared/);
  assert.match(result.text, /id: alpha-term\n[\s\S]*?key: local/);
  assert.match(result.text, /id: zeta\n[\s\S]*?key: local/);
  assert.deepEqual(result.summary, { op: "import", imported: 3, localIds: ["alpha-term", "zeta"] });
});

test("6.8 imports the rows of every thesaurus table in document order", () => {
  const result = run({ "specs/thesaurus.md": THESAURUS, ...OWNERS }, "specs/thesaurus.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.equal(
    result.text,
    `terms:
  - id: alpha-term
    label: Alpha term
    meaning: A thing.
    owner: specs/docs/a.md
    group: Other
    key: shared
    status: active
    distinguish:
      - terms
    history:
      - date: 2026-11-14
        op: import
        from: specs/thesaurus.md
  - id: terms
    label: Terms
    meaning: The tool.
    owner: specs/terms-tool.md
    group: Tool
    key: shared
    status: active
    distinguish:
      - terms-file
    history:
      - date: 2026-11-14
        op: import
        from: specs/thesaurus.md
  - id: terms-2
    label: "Terms!"
    meaning: Duplicate.
    owner: x.md
    group: Other
    key: shared
    status: active
    history:
      - date: 2026-11-14
        op: import
        from: specs/thesaurus.md
  - id: terms-file
    label: terms file
    meaning: The file.
    owner: specs/terms.md
    group: Tool
    key: shared
    status: active
    distinguish:
      - terms
    history:
      - date: 2026-11-14
        op: import
        from: specs/thesaurus.md
`,
  );
  assert.deepEqual(result.candidates, [
    { id: "terms", item: "term" },
    { id: "terms-file", item: "terms.yaml" },
    { id: "alpha-term", item: "old alpha" },
  ]);
  assert.deepEqual(result.summary, { op: "import", imported: 4, localIds: [] });
  assert.deepEqual(result.edits, []);
});

test("6.8 keeps the settings of the empty terms file", () => {
  const result = run(
    { "specs/t.md": `# T\n\n## G\n\n${HEADER}| A | M | terms.md | |\n`, "specs/terms.md": "" },
    "specs/t.md",
    "settings:\n  checkAfterEdit: true\nterms: []\n",
  );
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.ok(result.text.startsWith("settings:\n  checkAfterEdit: true\nterms:\n  - id: a\n"));
});

test("6.8 refuses a terms file that has entries", () => {
  const terms = `terms:
  - id: alpha
    label: Alpha
    meaning: A.
    owner: docs/a.md
    group: Terms
    key: shared
    status: active
    history:
      - { date: 2024-01-01, op: add }
`;
  assert.equal(
    refusalOf(run({ "specs/thesaurus.md": THESAURUS, ...OWNERS }, "specs/thesaurus.md", terms)),
    "import needs a terms file without entries; .pi/pi-dent/terms.yaml has 1",
  );
});

test("6.8 refuses a path that is not a document", () => {
  assert.equal(refusalOf(run({}, "specs/zz.md")), "specs/zz.md is not a document");
});

test("6.8 refuses a document without a thesaurus table", () => {
  assert.equal(
    refusalOf(
      run({ "docs/a.md": "# A\n\n| Term | Meaning |\n| --- | --- |\n| A | B |\n" }, "docs/a.md"),
    ),
    "docs/a.md has no thesaurus table",
  );
});

test("6.8 refusal 4 gives the first row problem in document order", () => {
  const doc = (row: string): string => `# T\n\n## G\n\n${HEADER}${row}\n`;
  assert.equal(
    refusalOf(run({ "specs/t.md": doc("|  | M | terms.md | |") }, "specs/t.md")),
    "specs/t.md:7: the Term cell is empty",
  );
  assert.equal(
    refusalOf(run({ "specs/t.md": doc("| — | M | terms.md | |") }, "specs/t.md")),
    "specs/t.md:7: the label gives no id",
  );
  assert.equal(
    refusalOf(run({ "specs/t.md": `${HEADER}| A | M | terms.md | |\n` }, "specs/t.md")),
    "specs/t.md:3: no heading precedes the table",
  );
});

test("6.8 refusal 4 gives the Owner problem when the Owner cell gives no owner path", () => {
  for (const owner of ["/abs.md", "https://x/a.md", "terms", "#only", "a//b.md"]) {
    const doc = `# T\n\n## G\n\n${HEADER}| A | M | ${owner} | |\n`;
    assert.equal(
      refusalOf(run({ "specs/t.md": doc }, "specs/t.md")),
      "specs/t.md:7: the Owner cell gives no owner path",
      owner,
    );
  }
});

test("6.8 keeps leading ../ segments in an external owner path", () => {
  const text = `# T\n\n## G\n\n${HEADER}| Terms | M | [terms.md](terms.md) | |\n| diagnostic | N | [c](../../pi-dent/specs/config-file.md) | |\n`;
  const result = run({ "specs/t.md": text, "specs/terms.md": "" }, "specs/t.md");
  if (!result.ok) assert.fail(result.refusal);
  assert.ok(result.text.includes('owner: "../pi-dent/specs/config-file.md"'));
});

test("6.8 refusal 4 gives the T002 finding of two rows with the same label", () => {
  const text = `# T\n\n## G\n\n${HEADER}| Term | M | terms.md | |\n| Term | N | terms.md | |\n`;
  assert.equal(
    refusalOf(run({ "specs/t.md": text, "specs/terms.md": "" }, "specs/t.md")),
    'import refused: .pi/pi-dent/terms.yaml:14:12 T002 term-2: "Term" is also a label or form of term',
  );
});

test("6.8 derives ids: lower case, runs of other characters as -, trimmed of -", () => {
  const text = `# T\n\n## G\n\n${HEADER}| C++ tool | M | terms.md | |\n| (Alpha) | N | terms.md | |\n`;
  const result = run({ "specs/t.md": text, "specs/terms.md": "" }, "specs/t.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  const ids = [...result.text.matchAll(/^  - id: (.*)$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ["alpha", "c-tool"]);
});

test("6.8 gives an item that names another row's label a distinguish id, not a candidate", () => {
  const text = `# T\n\n## G\n\n${HEADER}| Alpha | M | terms.md | Beta; gamma |\n| Beta | N | terms.md | |\n`;
  const result = run({ "specs/t.md": text, "specs/terms.md": "" }, "specs/t.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.deepEqual(result.candidates, [{ id: "alpha", item: "gamma" }]);
  assert.match(result.text, /- id: alpha\n(?:.*\n)*?    distinguish:\n      - beta\n/);
});

test("6.8 the Term cell text is plain: a code span and an image contribute, raw HTML and autolinks do not", () => {
  const source = `# Terms\n\n${HEADER}| \`x y\` ![alt](i.png) <b>h</b> <http://a.b> z | A thing. | a.md | |\n`;
  const result = run({ "terms.md": source, "a.md": "x y\n" }, "terms.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.ok(result.text.includes("  - id: x-y-alt-h-z\n    label: x y alt h z\n"), result.text);
});

test("6.8 the owner path keeps a percent-encoded link destination as written", () => {
  const source = `# Terms\n\n${HEADER}| T | A thing. | [x](dest%20x.md#top) | |\n`;
  const result = run({ "specs/terms.md": source, "specs/dest%20x.md": "T\n" }, "specs/terms.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.ok(result.text.includes('    owner: "specs/dest%20x.md"\n'), result.text);
});

test("6.8 the owner path follows a reference link's destination", () => {
  const source = `# Terms\n\n${HEADER}| Thing | A thing. | [x][ref] | |\n\n[ref]: a.md\n`;
  const result = run({ "terms.md": source, "a.md": "Thing\n" }, "terms.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.ok(result.text.includes("    owner: a.md\n"), result.text);
});

test("6.8 the group is the heading's plain text, with its code span and emphasis as plain text", () => {
  const source = `# *Hello* \`code\` world\n\n${HEADER}| T | A thing. | a.md | |\n`;
  const result = run({ "terms.md": source, "a.md": "T\n" }, "terms.md");
  if (!result.ok) {
    assert.fail(result.refusal);
  }
  assert.ok(result.text.includes("    group: Hello code world\n"), result.text);
});
