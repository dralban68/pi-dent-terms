import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkspace, type CheckFinding } from "../lib/checks.ts";
import {
  parseTermsFile,
  writeTermsFile,
  type Entry,
  type TermsFile,
  type TermsModel,
} from "../lib/terms-file.ts";
import { findingText } from "../lib/text.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function parse(text: string): TermsFile {
  return parseTermsFile(bytes(text));
}

/** The T001 findings a check of the terms file `input` reports, in finding order. */
function t001(input: string | Uint8Array): CheckFinding[] {
  const termsBytes = typeof input === "string" ? bytes(input) : input;
  return checkWorkspace(termsBytes, new Map()).findings.filter(
    (finding) => finding.code === "T001",
  );
}

function messages(text: string): string[] {
  return t001(text).map((finding) => finding.message);
}

function places(text: string): string[] {
  return t001(text).map((finding) => `${finding.line}:${finding.column} ${finding.message}`);
}

const TERMS = ".pi/pi-dent/terms.yaml";

/** The line and column of the first `needle` in `text`, plus `offset`, as `<line>:<column>`. */
function at(text: string, needle: string, offset = 0, anchor = ""): string {
  const start = anchor === "" ? 0 : text.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} is in the text`);
  const index = text.indexOf(needle, start);
  assert.notEqual(index, -1, `${needle} is in the text`);
  const lines = text.slice(0, index + offset).split("\n");
  return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
}

/** The ids of the entries a check leaves in: those it reports as used by no document. */
function ids(text: string): string[] {
  const result = checkWorkspace(bytes(text), new Map([["docs/a.md", "nothing\n"]]));
  return result.findings.flatMap((finding) =>
    finding.code === "T005" && finding.message.endsWith("is used by no document")
      ? [finding.message.split(":")[0] ?? ""]
      : [],
  );
}

const DEFAULT_HISTORY = "\n      - { date: 2024-01-01, op: add }";

/**
 * An entry of the file text. `overrides` replaces a field in place (`null` leaves it out) and
 * appends a new one; a value starting with a line feed is a block value written on the next lines.
 */
function entry(id: string, overrides: Record<string, string | null> = {}): string {
  const fields = new Map<string, string | null>([
    ["label", /^[a-z]/.test(id) ? id : "term"],
    ["meaning", "A thing."],
    ["owner", "docs/a.md"],
    ["group", "Terms"],
    ["key", "shared"],
    ["status", "active"],
    ["history", DEFAULT_HISTORY],
  ]);
  for (const [name, value] of Object.entries(overrides)) {
    fields.set(name, value);
  }
  let out = `  - id: ${id}\n`;
  for (const [name, value] of fields) {
    if (value !== null) {
      out += value.startsWith("\n") ? `    ${name}:${value}\n` : `    ${name}: ${value}\n`;
    }
  }
  return out;
}

function terms(...entries: string[]): string {
  return entries.length === 0 ? "terms: []\n" : `terms:\n${entries.join("")}`;
}

function history(...items: string[]): string {
  return items.map((item) => `\n      - ${item}`).join("");
}

/** The messages of the entry's history with one item. */
function historyMessages(item: string): string[] {
  return messages(terms(entry("alpha", { history: history(item) })));
}

const ID_TYPE = "must be an id matching ^[a-z0-9]+(-[a-z0-9]+)*$";
const PHRASE_TYPE = "must be a phrase (one trimmed line holding a letter, mark, or digit)";

// ---------------------------------------------------------------------------------------------
// 2.1 Location and syntax
// ---------------------------------------------------------------------------------------------

test("2.1 bytes: invalid UTF-8 gives one T001 at (file)", () => {
  const found = t001(new Uint8Array([0x74, 0x65, 0xff, 0x0a]));
  assert.deepEqual(
    found.map((finding) => [finding.line, finding.column, finding.message]),
    [[1, 1, "(file): not valid UTF-8"]],
  );
});

test("2.1 BOM: a leading U+FEFF is not part of the text, so columns count from the first character", () => {
  assert.deepEqual(messages(`\uFEFF${terms()}`), []);
  assert.deepEqual(places("\uFEFFterms: 1\n"), ["1:8 terms: must be a sequence"]);
});

test("2.1 syntax: a text that does not parse gives one T001 at (file), and no entries", () => {
  const found = t001("terms: [\n");
  assert.equal(found.length, 1);
  const [finding] = found;
  assert.ok(finding?.message.startsWith("(file): "));
  assert.ok((finding?.line ?? 0) >= 1 && (finding?.column ?? 0) >= 1);
  assert.deepEqual(ids("terms: [\n"), []);
});

test("2.1 documents: empty text holds 0 YAML documents", () => {
  assert.deepEqual(messages(""), ["(file): holds 0 YAML documents"]);
});

test("2.1 documents: a second document gives one T001 naming the count", () => {
  assert.deepEqual(messages(`${terms()}---\nterms: []\n`), ["(file): holds 2 YAML documents"]);
});

test("2.1 duplicate key: a duplicate key in a mapping gives one T001 and no entries", () => {
  const text = `settings:\n  checkAfterEdit: true\nsettings: {}\n${terms(entry("alpha"))}`;
  assert.deepEqual(messages(text), ["(file): duplicate key"]);
  assert.deepEqual(ids(text), []);
});

test("2.1 duplicate key: a duplicate key inside an entry is one file-level T001", () => {
  assert.deepEqual(messages(terms(`${entry("alpha")}    label: gamma\n`)), [
    "(file): duplicate key",
  ]);
});

test("2.1 line endings: CRLF and a lone CR are line breaks for the positions", () => {
  assert.deepEqual(places("terms: 1\r\nx: 2\r\n"), [
    '1:1 (root): unknown keys "x"',
    "1:8 terms: must be a sequence",
  ]);
  assert.deepEqual(places("x: 1\rterms: 2\r"), [
    '1:1 (root): unknown keys "x"',
    "2:8 terms: must be a sequence",
  ]);
});

// ---------------------------------------------------------------------------------------------
// 2.2 Root
// ---------------------------------------------------------------------------------------------

test("2.2 root: a root that is not a mapping gives one T001 and no entries", () => {
  const text = "- a\n- b\n";
  assert.deepEqual(messages(text), ["(root): must be a mapping"]);
  assert.deepEqual(ids(text), []);
});

test("2.2 root: an absent terms key gives one T001 and no entries", () => {
  const text = "settings:\n  checkAfterEdit: true\n";
  assert.deepEqual(messages(text), ["(root): missing terms"]);
  assert.deepEqual(ids(text), []);
});

test("2.2 root: a terms value that is not a sequence gives one T001 and no entries", () => {
  const text = "terms: 5\n";
  assert.deepEqual(messages(text), ["terms: must be a sequence"]);
  assert.deepEqual(ids(text), []);
});

test("2.2 root: unknown root keys give one finding naming all of them, and the entries stay", () => {
  const found = t001(`x: 1\ny: 2\n${terms(entry("alpha"))}`);
  assert.deepEqual(
    found.map((finding) => finding.message),
    ['(root): unknown keys "x", "y"'],
  );
  assert.deepEqual(ids(`x: 1\ny: 2\n${terms(entry("alpha"))}`), ["alpha"]);
});

test("2.2 settings: a settings value that is not a mapping gives one T001", () => {
  assert.deepEqual(messages(`settings: 5\n${terms()}`), ["settings: must be a mapping"]);
});

test("2.2 settings: a checkAfterEdit that is not a boolean gives one T001", () => {
  assert.deepEqual(messages(`settings:\n  checkAfterEdit: yes-please\n${terms()}`), [
    "settings.checkAfterEdit: must be true or false",
  ]);
});

test("2.2 settings: unknown settings keys give one finding naming all of them", () => {
  assert.deepEqual(messages(`settings:\n  checkAfterEdit: true\n  a: 1\n  b: 2\n${terms()}`), [
    'settings: unknown keys "a", "b"',
  ]);
});

test("2.2 terms: an empty sequence is valid and has no entries", () => {
  assert.deepEqual(messages("terms: []\n"), []);
  assert.deepEqual(ids("terms: []\n"), []);
});

// ---------------------------------------------------------------------------------------------
// 2.3 Entries
// ---------------------------------------------------------------------------------------------

test("2.3 entry: a valid entry with absent lists gives no finding, and its reject phrase is prose", () => {
  const text = terms(entry("alpha", { key: "confusable", reject: "\n      - old name" }));
  const result = checkWorkspace(bytes(text), new Map([["docs/a.md", "old name and alpha\n"]]));
  assert.deepEqual(result.findings.map(findingText), [
    'docs/a.md:1:1 P001 "old name" is rejected: use "alpha" (alpha)',
  ]);
});

test("2.3 id: an id not matching the pattern is left out", () => {
  const text = terms(entry("Bad Id"));
  assert.deepEqual(messages(text), [`terms[0].id: ${ID_TYPE}`]);
  assert.deepEqual(ids(text), []);
});

test("2.3 id: a non-string id is a T001, and a reference to it is a T003", () => {
  const text = terms(entry("5"), entry("alpha", { key: "confusable", distinguish: '["5"]' }));
  const result = checkWorkspace(bytes(text), new Map([["docs/a.md", "alpha\n"]]));
  assert.deepEqual(result.findings.map(findingText), [
    `${TERMS}:${at(text, "5")} T001 terms[0].id: ${ID_TYPE}`,
    `${TERMS}:${at(text, '"5"')} T003 alpha: distinguish names 5, which is not an entry`,
  ]);
});

test("2.3 order: an id not greater than the last string id gives one T001 and leaves the entry out", () => {
  const text = terms(entry("beta"), entry("alpha"), entry("gamma", { distinguish: "[alpha]" }));
  const result = checkWorkspace(
    bytes(text),
    new Map([
      ["docs/a.md", "beta gamma\n"],
      ["docs/b.md", "beta gamma\n"],
    ]),
  );
  assert.deepEqual(result.findings.map(findingText), [
    `${TERMS}:${at(text, "alpha", 0, "- id: alpha")} T001 terms[1].id: must come after beta`,
  ]);
});

test("2.3 order: a duplicate id is an order violation", () => {
  assert.deepEqual(messages(terms(entry("alpha"), entry("alpha"))), [
    "terms[1].id: must come after alpha",
  ]);
});

test("2.3 order: a non-string id does not change the last string id", () => {
  const text = terms(entry("beta"), entry("5"), entry("gamma"));
  assert.deepEqual(messages(text), [`terms[1].id: ${ID_TYPE}`]);
  assert.deepEqual(ids(text), ["beta", "gamma"]);
});

test("2.3 order: ids are compared by UTF-16 code units", () => {
  assert.deepEqual(messages(terms(entry("a-b"), entry("a1"))), []);
  assert.deepEqual(messages(terms(entry("a1"), entry("a-b"))), ["terms[1].id: must come after a1"]);
});

test("2.3 left out: each missing required field gives 'missing <key>' at the entry", () => {
  for (const field of ["label", "meaning", "owner", "group", "key", "status", "history"]) {
    const text = terms(entry("alpha", { [field]: null }));
    assert.deepEqual(messages(text), [`terms[0]: missing ${field}`], field);
    assert.deepEqual(ids(text), [], field);
  }
});

test("2.3 left out: an entry without an id gives 'missing id' and its other missing fields", () => {
  assert.deepEqual(messages("terms:\n  - label: alpha\n").toSorted(), [
    "terms[0]: missing group",
    "terms[0]: missing history",
    "terms[0]: missing id",
    "terms[0]: missing key",
    "terms[0]: missing meaning",
    "terms[0]: missing owner",
    "terms[0]: missing status",
  ]);
});

test("2.3 left out: an entry that is not a mapping gives one T001 and no entry", () => {
  const text = "terms:\n  - alpha\n";
  assert.deepEqual(messages(text), ["terms[0]: must be a mapping"]);
  assert.deepEqual(ids(text), []);
});

test("2.3 phrase: a label is one trimmed line holding a letter, mark, or digit", () => {
  assert.deepEqual(messages(terms(entry("alpha", { label: '" alpha"' }))), [
    `terms[0].label: ${PHRASE_TYPE}`,
  ]);
  assert.deepEqual(messages(terms(entry("alpha", { label: "--" }))), [
    `terms[0].label: ${PHRASE_TYPE}`,
  ]);
  assert.deepEqual(messages(terms(entry("alpha", { label: '"a\\nb"' }))), [
    `terms[0].label: ${PHRASE_TYPE}`,
  ]);
  assert.deepEqual(messages(terms(entry("alpha", { label: "é" }))), []);
  assert.deepEqual(messages(terms(entry("alpha", { label: "2fa" }))), []);
});

test("2.3 line: meaning and group are one non-empty line", () => {
  assert.deepEqual(messages(terms(entry("alpha", { meaning: '"  "' }))), [
    "terms[0].meaning: must be one non-empty line",
  ]);
  assert.deepEqual(messages(terms(entry("alpha", { group: '"a\\nb"' }))), [
    "terms[0].group: must be one non-empty line",
  ]);
});

test("2.3 owner: workspace paths and leading ../ external owner paths ending with .md", () => {
  for (const bad of ["/a.md", "a/../b.md", "a//b.md", "a.txt", "./a.md", "a/.."]) {
    assert.deepEqual(
      messages(terms(entry("alpha", { owner: bad }))),
      ["terms[0].owner: must be an owner path ending with .md"],
      bad,
    );
  }
  assert.deepEqual(messages(terms(entry("alpha", { owner: "docs/x.y.md" }))), []);
  assert.deepEqual(messages(terms(entry("alpha", { owner: "../pi-dent/specs/host.md" }))), []);
  assert.deepEqual(messages(terms(entry("alpha", { owner: "x/../host.md" }))), [
    "terms[0].owner: must be an owner path ending with .md",
  ]);
});

test("2.3 enum: local is a valid key", () => {
  assert.deepEqual(messages(terms(entry("alpha", { key: "local" }))), []);
});

test("2.3 enum: key, status, and reason take their listed values", () => {
  assert.deepEqual(messages(terms(entry("alpha", { key: "both" }))), [
    "terms[0].key: must be one of shared, confusable, local",
  ]);
  assert.deepEqual(messages(terms(entry("alpha", { status: "gone" }))), [
    "terms[0].status: must be one of active, deprecated",
  ]);
  assert.deepEqual(messages(terms(entry("alpha", { reason: "renamed" }))), []);
  assert.deepEqual(messages(terms(entry("alpha", { reason: "nope" }))), [
    "terms[0].reason: must be one of merged, split, renamed, out-of-scope",
  ]);
});

test("2.3 reject: a repeated phrase gives one 'repeats' finding, compared after normalisation", () => {
  assert.deepEqual(messages(terms(entry("alpha", { reject: "\n      - a  b\n      - a b" }))), [
    'terms[0].reject[1]: repeats "a b"',
  ]);
});

test("2.3 reject: each item is a phrase", () => {
  assert.deepEqual(messages(terms(entry("alpha", { reject: "\n      - ' a'" }))), [
    `terms[0].reject[0]: ${PHRASE_TYPE}`,
  ]);
});

test("2.3 lists: a list that is not a sequence gives one T001 and leaves the entry out", () => {
  const text = terms(entry("alpha", { forms: "alphas" }));
  assert.deepEqual(messages(text), ["terms[0].forms: must be a sequence"]);
  assert.deepEqual(ids(text), []);
});

test("2.3 lists: distinguish and replacedBy items are ids, and repeats are findings", () => {
  assert.deepEqual(messages(terms(entry("alpha", { distinguish: "\n      - Beta" }))), [
    `terms[0].distinguish[0]: ${ID_TYPE}`,
  ]);
  assert.deepEqual(
    messages(terms(entry("alpha", { replacedBy: "\n      - beta\n      - beta" }))),
    ['terms[0].replacedBy[1]: repeats "beta"'],
  );
});

test("2.3 unknown keys: one finding names all unknown keys of an entry, and the entry stays", () => {
  const text = terms(entry("alpha", { extra: "1", other: "2" }));
  assert.deepEqual(messages(text), ['terms[0]: unknown keys "extra", "other"']);
  assert.deepEqual(ids(text), ["alpha"]);
});

test("2.3 deprecated: an entry with status deprecated, a reason, and replacedBy parses", () => {
  const text = terms(
    entry("alpha", {
      status: "deprecated",
      key: "confusable",
      reason: "merged",
      replacedBy: "[beta]",
      history: history("{ date: 2024-01-01, op: merge, into: beta }"),
    }),
    entry("beta", { key: "confusable" }),
  );
  const result = checkWorkspace(bytes(text), new Map([["docs/a.md", "beta\n"]]));
  assert.deepEqual(result.findings.map(findingText), []);
});

// ---------------------------------------------------------------------------------------------
// 2.4 History items
// ---------------------------------------------------------------------------------------------

test("2.4 history: an empty history gives one T001 and leaves the entry out", () => {
  const text = terms(entry("alpha", { history: "[]" }));
  assert.deepEqual(messages(text), ["terms[0].history: must hold at least one item"]);
  assert.deepEqual(ids(text), []);
});

test("2.4 history: a history that is not a sequence gives one T001", () => {
  assert.deepEqual(messages(terms(entry("alpha", { history: "add" }))), [
    "terms[0].history: must be a sequence",
  ]);
});

test("2.4 history: an item that is not a mapping gives one T001", () => {
  assert.deepEqual(historyMessages("add"), ["terms[0].history[0]: must be a mapping"]);
});

test("2.4 history: a missing date or op is a T001 at the item", () => {
  assert.deepEqual(historyMessages("{ op: add }"), ["terms[0].history[0]: missing date"]);
  assert.deepEqual(historyMessages("{ date: 2024-01-01 }"), ["terms[0].history[0]: missing op"]);
});

test("2.4 history: a date is a valid calendar date in the form YYYY-MM-DD", () => {
  assert.deepEqual(historyMessages("{ date: 2024-02-29, op: add }"), []);
  assert.deepEqual(historyMessages("{ date: 2023-02-29, op: add }"), [
    "terms[0].history[0].date: must be a date YYYY-MM-DD",
  ]);
  assert.deepEqual(historyMessages("{ date: 2024-13-01, op: add }"), [
    "terms[0].history[0].date: must be a date YYYY-MM-DD",
  ]);
  assert.deepEqual(historyMessages("{ date: 2024-1-01, op: add }"), [
    "terms[0].history[0].date: must be a date YYYY-MM-DD",
  ]);
});

test("2.4 history: op is one of the listed operations; an absent or unknown op takes no operand set", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: edit }"), [
    "terms[0].history[0].op: must be one of add, update, import, rename, merge, split, deprecate, reown",
  ]);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, from: a }"), [
    "terms[0].history[0]: missing op",
  ]);
  assert.deepEqual(historyMessages("{ op: edit, from: a, to: b }"), [
    "terms[0].history[0]: missing date",
    "terms[0].history[0].op: must be one of add, update, import, rename, merge, split, deprecate, reown",
  ]);
});

test("2.4 history operand sets: update takes no operands", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: update }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: update, from: a }"), [
    'terms[0].history[0]: unknown keys "from"',
  ]);
});

test("2.4 history operand sets: update takes meaning, the old meaning as a string", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: update, meaning: Old one. }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: update, meaning: 5 }"), [
    "terms[0].history[0].meaning: must be a string",
  ]);
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: update, meaning: Old one., from: a }"),
    ['terms[0].history[0]: unknown keys "from"'],
  );
});

test("2.4 history operand sets: update takes status, the old status deprecated", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: update, status: deprecated }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: update, status: active }"), [
    "terms[0].history[0].status: must be one of deprecated",
  ]);
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: update, status: deprecated, from: a }"),
    ['terms[0].history[0]: unknown keys "from"'],
  );
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: add, status: deprecated }"), [
    'terms[0].history[0]: unknown keys "status"',
  ]);
});

test("2.4 history operand sets: update takes meaning and status together", () => {
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: update, meaning: Old one., status: deprecated }"),
    [],
  );
  assert.deepEqual(
    historyMessages(
      "{ date: 2024-01-01, op: update, status: deprecated, meaning: Old one., into: b }",
    ),
    ['terms[0].history[0]: unknown keys "into"'],
  );
});

test("2.4 history operand sets: add takes none, and any other key is unknown", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: add, from: a }"), [
    'terms[0].history[0]: unknown keys "from"',
  ]);
});

test("2.4 history operand sets: import takes from, a workspace path ending with .md", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: import, from: docs/a.md }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: import, from: ../pi-dent/a.md }"), [
    "terms[0].history[0].from: must be a workspace path ending with .md",
  ]);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: import }"), [
    "terms[0].history[0]: missing from",
  ]);
});

test("2.4 history operand sets: rename takes from and to, both phrases", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: rename, from: old, to: new }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: rename, from: old }"), [
    "terms[0].history[0]: missing to",
  ]);
});

test("2.4 history operand sets: merge with into takes into, and from is then unknown", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: merge, into: beta }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: merge, into: beta, from: x }"), [
    'terms[0].history[0]: unknown keys "from"',
  ]);
});

test("2.4 history operand sets: merge without into takes from", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: merge, from: beta }"), []);
});

test("2.4 history operand sets: split with into takes a sequence of strings", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: split, into: [a, b] }"), []);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: split, into: a }"), [
    "terms[0].history[0].into: must be a sequence",
  ]);
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: split, into: [a, 1] }"), [
    "terms[0].history[0].into[1]: must be a string",
  ]);
});

test("2.4 history operand sets: split without into takes from", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: split, from: beta }"), []);
});

test("2.4 history operand sets: deprecate with reason takes reason and an optional replacedBy", () => {
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: deprecate, reason: merged, replacedBy: [beta] }"),
    [],
  );
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: deprecate, reason: out-of-scope }"),
    [],
  );
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: deprecate, reason: nope }"), [
    "terms[0].history[0].reason: must be one of merged, split, renamed, out-of-scope",
  ]);
});

test("2.4 history operand sets: deprecate without reason takes from", () => {
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: deprecate, from: beta }"), []);
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: deprecate, from: beta, replacedBy: [x] }"),
    ['terms[0].history[0]: unknown keys "replacedBy"'],
  );
});

test("2.4 history operand sets: reown takes owner paths, including leading ../", () => {
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: reown, from: a.md, to: docs/b.md }"),
    [],
  );
  assert.deepEqual(
    historyMessages("{ date: 2024-01-01, op: reown, from: ../pi-dent/a.md, to: ../other/b.md }"),
    [],
  );
  assert.deepEqual(historyMessages("{ date: 2024-01-01, op: reown, from: a.md, to: b.txt }"), [
    "terms[0].history[0].to: must be an owner path ending with .md",
  ]);
});

test("2.4 history: a T001 inside a history item leaves the entry out but keeps its id", () => {
  const text = terms(
    entry("alpha", { history: history("{ date: 2024-01-01, op: rename, from: old }") }),
    entry("beta", { distinguish: "[alpha]" }),
  );
  const result = checkWorkspace(
    bytes(text),
    new Map([
      ["docs/a.md", "beta\n"],
      ["docs/b.md", "beta\n"],
    ]),
  );
  assert.deepEqual(result.findings.map(findingText), [
    `${TERMS}:${at(text, "{ date")} T001 terms[0].history[0]: missing to`,
  ]);
});

// ---------------------------------------------------------------------------------------------
// 2.5 Canonical form
// ---------------------------------------------------------------------------------------------

const FULL: Entry = {
  id: "alpha",
  label: "alpha",
  meaning: "A thing.",
  owner: "docs/a.md",
  group: "Terms",
  key: "shared",
  status: "deprecated",
  reject: ["old name"],
  distinguish: ["beta"],
  forms: ["alphas"],
  replacedBy: ["beta"],
  reason: "merged",
  history: [
    { date: "2024-01-01", op: "add" },
    { date: "2024-02-01", op: "merge", into: "beta" },
  ],
};

const MINIMAL: Entry = {
  id: "alpha",
  label: "alpha",
  meaning: "A thing.",
  owner: "docs/a.md",
  group: "Terms",
  key: "shared",
  status: "active",
  reject: [],
  distinguish: [],
  forms: [],
  replacedBy: [],
  history: [{ date: "2024-01-01", op: "add" }],
};

function withMeaning(meaning: string): TermsModel {
  return { settings: {}, entries: [{ ...FULL, meaning }] };
}

test("2.5 canonical: an empty model writes terms: [] and no settings", () => {
  assert.equal(writeTermsFile({ settings: {}, entries: [] }), "terms: []\n");
});

test("2.5 canonical: settings are written when they have a key, before terms", () => {
  assert.equal(
    writeTermsFile({ settings: { checkAfterEdit: false }, entries: [] }),
    "settings:\n  checkAfterEdit: false\nterms: []\n",
  );
});

test("2.5 canonical: an entry is written in the field order of Section 2.3", () => {
  assert.equal(
    writeTermsFile({ settings: {}, entries: [FULL] }),
    [
      "terms:",
      "  - id: alpha",
      "    label: alpha",
      "    meaning: A thing.",
      "    owner: docs/a.md",
      "    group: Terms",
      "    key: shared",
      "    status: deprecated",
      "    reject:",
      "      - old name",
      "    distinguish:",
      "      - beta",
      "    forms:",
      "      - alphas",
      "    replacedBy:",
      "      - beta",
      "    reason: merged",
      "    history:",
      "      - date: 2024-01-01",
      "        op: add",
      "      - date: 2024-02-01",
      "        op: merge",
      "        into: beta",
      "",
    ].join("\n"),
  );
});

test("2.5 canonical: empty lists and absent optional fields are not written", () => {
  assert.equal(
    writeTermsFile({ settings: {}, entries: [MINIMAL] }),
    [
      "terms:",
      "  - id: alpha",
      "    label: alpha",
      "    meaning: A thing.",
      "    owner: docs/a.md",
      "    group: Terms",
      "    key: shared",
      "    status: active",
      "    history:",
      "      - date: 2024-01-01",
      "        op: add",
      "",
    ].join("\n"),
  );
});

test("2.5 canonical: history operands are written in the table order of Section 2.4", () => {
  const items: Entry["history"] = [
    { date: "2024-01-01", op: "rename", from: "old", to: "new" },
    { date: "2024-01-02", op: "split", into: ["a", "b"] },
    { date: "2024-01-03", op: "split", from: "x" },
    { date: "2024-01-04", op: "deprecate", reason: "merged", replacedBy: ["beta"] },
    { date: "2024-01-05", op: "deprecate", from: "beta" },
    { date: "2024-01-06", op: "reown", from: "a.md", to: "b.md" },
    { date: "2024-01-07", op: "import", from: "docs/a.md" },
  ];
  const text = writeTermsFile({ settings: {}, entries: [{ ...FULL, history: items }] });
  assert.ok(
    text.endsWith(
      [
        "    history:",
        "      - date: 2024-01-01",
        "        op: rename",
        "        from: old",
        "        to: new",
        "      - date: 2024-01-02",
        "        op: split",
        "        into:",
        "          - a",
        "          - b",
        "      - date: 2024-01-03",
        "        op: split",
        "        from: x",
        "      - date: 2024-01-04",
        "        op: deprecate",
        "        reason: merged",
        "        replacedBy:",
        "          - beta",
        "      - date: 2024-01-05",
        "        op: deprecate",
        "        from: beta",
        "      - date: 2024-01-06",
        "        op: reown",
        "        from: a.md",
        "        to: b.md",
        "      - date: 2024-01-07",
        "        op: import",
        "        from: docs/a.md",
        "",
      ].join("\n"),
    ),
  );
  assert.deepEqual(t001(text), []);
});

test("2.5 canonical: lines end with LF, have no trailing white space, and there is no BOM", () => {
  const text = writeTermsFile({ settings: { checkAfterEdit: true }, entries: [FULL] });
  assert.equal(text.startsWith("\uFEFF"), false);
  assert.equal(text.includes("\r"), false);
  assert.equal(text.endsWith("\n"), true);
  for (const line of text.split("\n")) {
    assert.equal(/[ \t]$/.test(line), false, JSON.stringify(line));
  }
});

test("2.5 canonical: a model's canonical text is a valid terms file", () => {
  const beta: Entry = {
    id: "beta",
    label: "beta",
    meaning: "true",
    owner: "docs/b.md",
    group: "Terms",
    key: "confusable",
    status: "active",
    reject: ["1.0", "null"],
    distinguish: ["alpha"],
    forms: [],
    replacedBy: [],
    history: [
      { date: "2024-01-01", op: "add" },
      { date: "2024-01-02", op: "deprecate", reason: "merged", replacedBy: ["alpha"] },
    ],
  };
  const model: TermsModel = { settings: { checkAfterEdit: true }, entries: [FULL, beta] };
  assert.deepEqual(t001(writeTermsFile(model)), []);
});

test("2.5 quoting: plain strings are written plain", () => {
  assert.ok(
    writeTermsFile(withMeaning("workspace-relative 2024 a_b/c.d e")).includes(
      "    meaning: workspace-relative 2024 a_b/c.d e\n",
    ),
  );
});

test("2.5 quoting: core-schema null, boolean, integer, and float strings are JSON-quoted", () => {
  for (const value of ["true", "False", "null", "Null", "1.0", "007", "0x1f", "1e3", "+1", "-1"]) {
    assert.ok(
      writeTermsFile(withMeaning(value)).includes(`    meaning: ${JSON.stringify(value)}\n`),
      value,
    );
  }
});

test("2.5 quoting: a date stays a plain string", () => {
  const text = writeTermsFile(withMeaning("2024-01-01"));
  assert.ok(text.includes("    meaning: 2024-01-01\n"));
  assert.deepEqual(t001(text), []);
});

test("2.5 quoting: strings outside the plain set are JSON-quoted, and printable ones stay raw", () => {
  const cases: Array<[string, string]> = [
    ["Dir: x", '"Dir: x"'],
    [" lead", '" lead"'],
    ["back\\slash", '"back\\\\slash"'],
    ["tab\there", '"tab\\there"'],
    ["bell\u0007", '"bell\\u0007"'],
    ["del\u007f", '"del\\u007f"'],
    ["c1\u0085x", '"c1\u0085x"'],
    ["é", '"é"'],
    ["😀", '"😀"'],
  ];
  for (const [value, expected] of cases) {
    const text = writeTermsFile(withMeaning(value));
    assert.ok(text.includes(`    meaning: ${expected}\n`), `${JSON.stringify(value)} -> ${text}`);
    assert.deepEqual(t001(text), [], JSON.stringify(value));
  }
});

test("2.5 quoting: a string whose only escapes are quotes is single-quoted, its quotes doubled", () => {
  const cases: Array<[string, string]> = [
    ['Says "hello" here', "'Says \"hello\" here'"],
    [`one " and one '`, `'one " and one '''`],
    [' lead "q" ', "' lead \"q\" '"],
    [`it's "x"`, `'it''s "x"'`],
    [`''"`, `'''''"'`],
  ];
  for (const [value, expected] of cases) {
    const text = writeTermsFile(withMeaning(value));
    assert.ok(text.includes(`    meaning: ${expected}\n`), `${JSON.stringify(value)} -> ${text}`);
  }
});

test("2.5 quoting: a string with a backslash, a control, or a non-printable character stays double-quoted", () => {
  const cases: Array<[string, string]> = [
    ['back\\slash "q"', '"back\\\\slash \\"q\\""'],
    ['tab\t "q"', '"tab\\t \\"q\\""'],
    ['bell\u0007 "q"', '"bell\\u0007 \\"q\\""'],
    ['\u0080 "q"', '"\\u0080 \\"q\\""'],
    ['line\n"q"', '"line\\n\\"q\\""'],
  ];
  for (const [value, expected] of cases) {
    const text = writeTermsFile(withMeaning(value));
    assert.ok(text.includes(`    meaning: ${expected}\n`), `${JSON.stringify(value)} -> ${text}`);
  }
});

test("2.5 quoting: every quoted form reads back as the string written", () => {
  const values = [
    'Says "hello" here',
    `one " and one '`,
    ' lead "q" ',
    `''"`,
    'back\\slash "q"',
    'tab\t "q"',
    '\u0080 "q"',
    "it's",
    'say "hi"',
  ];
  for (const value of values) {
    const file = parse(writeTermsFile(withMeaning(value)));
    assert.deepEqual(t001(writeTermsFile(withMeaning(value))), [], JSON.stringify(value));
    assert.equal(file.entries[0]?.entry.meaning, value, JSON.stringify(value));
  }
});

test("2.5 quoting: list items and history operands use the same rule", () => {
  const text = writeTermsFile({
    settings: {},
    entries: [
      {
        ...FULL,
        reject: ["true", "a: b"],
        history: [{ date: "2024-01-01", op: "merge", into: "null" }],
      },
    ],
  });
  assert.ok(text.includes('      - "true"\n      - "a: b"\n'));
  assert.ok(text.includes('      - date: 2024-01-01\n        op: merge\n        into: "null"\n'));
});

test("2.5 canonical: an update item with meaning is written after op and reads back unchanged", () => {
  const model: TermsModel = {
    settings: {},
    entries: [
      {
        ...MINIMAL,
        history: [
          { date: "2024-01-01", op: "add" },
          { date: "2024-02-01", op: "update", meaning: "Old one, with: a colon." },
          { date: "2024-03-01", op: "update" },
        ],
      },
    ],
  };
  const text = writeTermsFile(model);
  assert.ok(
    text.includes(
      '      - date: 2024-02-01\n        op: update\n        meaning: "Old one, with: a colon."\n',
    ),
    text,
  );
  assert.deepEqual(t001(text), []);
  const reread = parse(text);
  assert.deepEqual(
    reread.entries.map((record) => record.entry),
    model.entries,
  );
  assert.equal(writeTermsFile({ settings: {}, entries: reread.entries.map((r) => r.entry) }), text);
});

test("2.5 canonical: settings with no entries write settings and terms: []", () => {
  assert.equal(
    writeTermsFile({ settings: { checkAfterEdit: true }, entries: [] }),
    "settings:\n  checkAfterEdit: true\nterms: []\n",
  );
});

// ---------------------------------------------------------------------------------------------
// 5.2 File checks: the T001 part
// ---------------------------------------------------------------------------------------------

test("5.2 T001 reasons: each reason of the table is reported for its violation", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["(file): not valid UTF-8", new Uint8Array([0xff])],
    ["(file): holds 0 YAML documents", bytes("")],
    ["(file): duplicate key", bytes("terms: []\nterms: []\n")],
    ["(root): missing terms", bytes("settings: {}\n")],
    ["(root): must be a mapping", bytes("- a\n")],
    ['(root): unknown keys "x"', bytes(`x: 1\n${terms()}`)],
    ["terms: must be a sequence", bytes("terms: 1\n")],
    [
      "settings.checkAfterEdit: must be true or false",
      bytes(`settings:\n  checkAfterEdit: 1\n${terms()}`),
    ],
    ["terms[0]: missing label", bytes(terms(entry("alpha", { label: null })))],
    [
      "terms[0].history: must hold at least one item",
      bytes(terms(entry("alpha", { history: "[]" }))),
    ],
    ["terms[1].id: must come after alpha", bytes(terms(entry("alpha"), entry("alpha")))],
    [
      'terms[0].forms[1]: repeats "f"',
      bytes(terms(entry("alpha", { forms: "\n      - f\n      - f" }))),
    ],
  ];
  for (const [expected, text] of cases) {
    const found = t001(text);
    assert.ok(
      found.some((finding) => finding.message === expected),
      `${expected} not in ${JSON.stringify(found.map((finding) => finding.message))}`,
    );
  }
});

test("5.2 T001 reasons: a syntax error gives a (file) T001 at the parser's position", () => {
  const found = t001("terms: [\n");
  assert.equal(found.length, 1);
  assert.ok(found[0]?.message.startsWith("(file): "));
});

test("5.2 T001 positions: a finding is placed at the start of the node its value path names", () => {
  assert.deepEqual(places("terms: 1\n"), ["1:8 terms: must be a sequence"]);
  assert.deepEqual(places("settings: 1\nterms: []\n"), ["1:11 settings: must be a mapping"]);
});

test("5.2 T001 positions: a missing key is placed at its object", () => {
  assert.deepEqual(places("terms:\n  - label: alpha\n").toSorted(), [
    "2:5 terms[0]: missing group",
    "2:5 terms[0]: missing history",
    "2:5 terms[0]: missing id",
    "2:5 terms[0]: missing key",
    "2:5 terms[0]: missing meaning",
    "2:5 terms[0]: missing owner",
    "2:5 terms[0]: missing status",
  ]);
});

test("5.2 T001 positions: a column counts UTF-16 code units before it on its line", () => {
  // Line 2: `  - { id: "😀", label: 1 }` — the `1` follows four UTF-16 units of the emoji string.
  const label = t001('terms:\n  - { id: "😀", label: 1 }\n').find((finding) =>
    finding.message.startsWith("terms[0].label"),
  );
  assert.deepEqual([label?.line, label?.column], [2, 24]);
});

test("5.2 T001 ordering: findings are ordered by line, then column", () => {
  assert.deepEqual(places("settings: 1\nx: 1\nterms: 2\n"), [
    '1:1 (root): unknown keys "x"',
    "1:11 settings: must be a mapping",
    "3:8 terms: must be a sequence",
  ]);
});

test("5.2 T001 left out: a T001 for an entry leaves only that entry out", () => {
  const text = terms(entry("alpha", { key: "both" }), entry("beta"));
  assert.deepEqual(ids(text), ["beta"]);
});

test("5.2 T001 left out: an unknown-key finding alone does not leave an entry out", () => {
  const found = t001(terms(entry("alpha", { extra: "1" })));
  assert.deepEqual(ids(terms(entry("alpha", { extra: "1" }))), ["alpha"]);
  assert.equal(found.length, 1);
});

test("5.2 T001 positions: an anchored value is placed at the start of its anchor", () => {
  assert.deepEqual(places("settings: &s 1\nterms: []\n"), ["1:11 settings: must be a mapping"]);
  assert.deepEqual(places("terms: &t 1\n"), ["1:8 terms: must be a sequence"]);
  assert.deepEqual(
    places(terms(entry("alpha", { label: "&l 1" }))).filter((p) => p.includes("label")),
    ["3:12 terms[0].label: must be a phrase (one trimmed line holding a letter, mark, or digit)"],
  );
});

test("5.2 T001 positions: a tagged value is placed at the start of its tag", () => {
  assert.deepEqual(
    places(terms(entry("alpha", { meaning: '!!str ""' }))).filter((p) => p.includes("meaning")),
    ["4:14 terms[0].meaning: must be one non-empty line"],
  );
  assert.deepEqual(places("settings: !!str 1\nterms: []\n"), ["1:11 settings: must be a mapping"]);
});

test("5.2 T001 positions: a value given by an alias is placed at the alias", () => {
  assert.deepEqual(places("x: &t 1\nterms: *t\n"), [
    '1:1 (root): unknown keys "x"',
    "2:8 terms: must be a sequence",
  ]);
  const text = terms(entry("alpha", { label: "&l 1", meaning: "*l" }));
  assert.deepEqual(
    places(text).filter((p) => p.includes("meaning")),
    ["4:14 terms[0].meaning: must be one non-empty line"],
  );
});

test("5.2 T001 positions: an anchored entry is placed at its anchor, not at its first key", () => {
  assert.deepEqual(
    places("terms:\n  - &m\n    label: 1\n").filter((p) => p.includes("missing id")),
    ["2:5 terms[0]: missing id"],
  );
});

test("5.2 T001 positions: a wrong value in an otherwise valid entry is placed at the value", () => {
  assert.deepEqual(places(terms(entry("alpha", { key: "both" }))), [
    "7:10 terms[0].key: must be one of shared, confusable, local",
  ]);
});
