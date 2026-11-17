import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkspace, type WorkspaceCheck } from "../lib/checks.ts";
import { findingText, type Finding } from "../lib/text.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A JSON list, which is a YAML flow sequence. */
const list = (...items: string[]): string => JSON.stringify(items);

/**
 * An entry of the terms file text. The label defaults to the id; `overrides` replaces a field in
 * place (`null` leaves it out).
 */
function entry(id: string, overrides: Record<string, string | null> = {}): string {
  const fields = new Map<string, string | null>([
    ["label", id],
    ["meaning", "A thing."],
    ["owner", "docs/a.md"],
    ["group", "Terms"],
    ["key", "confusable"],
    ["status", "active"],
    ["history", "\n      - { date: 2024-01-01, op: add }"],
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
  return `terms:\n${entries.join("")}`;
}

/** The check of one document, `docs/a.md`, against a terms file. */
function check(termsText: string, markdown: string): WorkspaceCheck {
  return checkWorkspace(bytes(termsText), new Map([["docs/a.md", markdown]]));
}

/** The texts of the findings with the given code prefix. */
function texts(result: WorkspaceCheck, prefix: string): string[] {
  return result.findings
    .filter((finding: Finding) => finding.code.startsWith(prefix))
    .map(findingText);
}

/** The messages of the findings with the given code. */
function messages(result: WorkspaceCheck, code: string): string[] {
  return result.findings
    .filter((finding) => finding.code === code)
    .map((finding) => finding.message);
}

/** The line and column of the first `needle` in `text`, plus `offset` into it, as `line:column`. */
function at(text: string, needle: string, offset = 0): string {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `${needle} is in the text`);
  const lines = text.slice(0, index + offset).split("\n");
  return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
}

/** The P001 text of a reject occurrence of `beta`'s phrase, spelled `spelled` at `where`. */
function rejected(spelled: string, where: string): string {
  return `docs/a.md:${where} P001 "${spelled}" is rejected: use "beta" (beta)`;
}

/** The P001 texts of a document for the reject phrase `phrase`, held by `beta`. */
function rejects(phrase: string, markdown: string): string[] {
  const termsText = terms(entry("alpha"), entry("beta", { reject: list(phrase) }));
  return texts(check(termsText, markdown), "P001");
}

/** The P002 texts of a document for a deprecated entry `old` labelled `label`. */
function deprecates(label: string, markdown: string, reason = "out-of-scope"): string[] {
  const termsText = terms(
    entry("old", { label: JSON.stringify(label), status: "deprecated", reason }),
  );
  return texts(check(termsText, markdown), "P002");
}

test("4.1 the plural of a word ending in s, x, z, ch, or sh adds es", () => {
  const cases: Array<[word: string, plural: string]> = [
    ["bus", "buses"],
    ["box", "boxes"],
    ["quiz", "quizes"],
    ["church", "churches"],
    ["wish", "wishes"],
  ];
  for (const [word, plural] of cases) {
    assert.deepEqual(rejects(word, plural), [rejected(plural, "1:1")], word);
  }
});

test("4.1 the plural of a word ending in a consonant and y replaces y by ies", () => {
  assert.deepEqual(rejects("entry", "entries"), [rejected("entries", "1:1")]);
  assert.deepEqual(rejects("fly", "flies"), [rejected("flies", "1:1")]);
  assert.deepEqual(rejects("entry", "entrys"), []);
});

test("4.1 the plural of a word ending in a vowel and y adds s", () => {
  assert.deepEqual(rejects("key", "keys"), [rejected("keys", "1:1")]);
  assert.deepEqual(rejects("day", "Days"), [rejected("Days", "1:1")]);
});

test("4.1 the default plural adds s, to the last word only", () => {
  assert.deepEqual(rejects("pi-dent tool", "pi-dent tools"), [rejected("pi-dent tools", "1:1")]);
  assert.deepEqual(rejects("pi-dent terms", "pi-dent termses"), [
    rejected("pi-dent termses", "1:1"),
  ]);
  assert.deepEqual(rejects("work space", "work spaces"), [rejected("work spaces", "1:1")]);
  assert.deepEqual(rejects("API", "APIs"), [rejected("APIs", "1:1")]);
});

test("4.1 a phrase whose last character is not a letter has no plural", () => {
  assert.deepEqual(rejects("version 2", "version 2"), [rejected("version 2", "1:1")]);
  assert.deepEqual(rejects("version 2", "version 2s"), []);
});

test("4.1 the capitalised variant replaces an Ll first character by its upper case", () => {
  assert.deepEqual(rejects("node", "Node"), [rejected("Node", "1:1")]);
  assert.deepEqual(rejects("Node", "node"), []);
  assert.deepEqual(rejects("node version", "Node version"), [rejected("Node version", "1:1")]);
  assert.deepEqual(rejects("1node", "1Node"), []);
});

test("4.1 variants of an active entry: label, plural, capitalised, forms, rejects", () => {
  const termsText = terms(
    entry("ws", { label: "workspace", forms: list("work area"), reject: list("repo") }),
  );
  for (const variant of [
    "workspace",
    "Workspace",
    "workspaces",
    "Workspaces",
    "work area",
    "Work area",
  ]) {
    const result = check(termsText, `${variant}\n`);
    assert.deepEqual(messages(result, "T005"), [], variant);
  }
  assert.deepEqual(messages(check(termsText, "work areas\n"), "T005"), [
    'ws: "workspace" is used by no document',
  ]);
  assert.deepEqual(texts(check(termsText, "repo Repo repos Repos\n"), "P001"), [
    'docs/a.md:1:1 P001 "repo" is rejected: use "workspace" (ws)',
    'docs/a.md:1:6 P001 "Repo" is rejected: use "workspace" (ws)',
    'docs/a.md:1:11 P001 "repos" is rejected: use "workspace" (ws)',
    'docs/a.md:1:17 P001 "Repos" is rejected: use "workspace" (ws)',
  ]);
});

test("4.1 a deprecated entry has label and form variants but no reject variants", () => {
  const termsText = terms(
    entry("old", {
      label: "old thing",
      status: "deprecated",
      reason: "out-of-scope",
      forms: list("legacy"),
      reject: list("ignored"),
    }),
  );
  const md = "Old thing, Old things, Legacy, legacy, ignored.\n";
  assert.deepEqual(texts(check(termsText, md), "P"), [
    'docs/a.md:1:1 P002 "Old thing" is deprecated (out-of-scope)',
    `docs/a.md:${at(md, "Old things")} P002 "Old things" is deprecated (out-of-scope)`,
    `docs/a.md:${at(md, "Legacy")} P002 "Legacy" is deprecated (out-of-scope)`,
    `docs/a.md:${at(md, "legacy")} P002 "legacy" is deprecated (out-of-scope)`,
  ]);
});

test("4.1 a variant of a normalised phrase is normalised", () => {
  assert.deepEqual(rejects("pi-dent  \t terms", "pi-dent terms\n"), [
    rejected("pi-dent terms", "1:1"),
  ]);
});

test("4.2 the longest match wins", () => {
  // The shorter variant has the smaller id, so only the length rule attributes the use to `root`.
  const termsText = terms(
    entry("a-ws", { label: "workspace" }),
    entry("root", { label: "workspace root" }),
  );
  const result = check(termsText, "the workspace root\n");
  assert.deepEqual(messages(result, "T005"), ['a-ws: "workspace" is used by no document']);
});

test("4.2 a plural is found by its own variant and the scan continues after it", () => {
  const md = "workspaces and workspace\n";
  assert.deepEqual(deprecates("workspace", md), [
    'docs/a.md:1:1 P002 "workspaces" is deprecated (out-of-scope)',
    `docs/a.md:${at(md, "workspace\n")} P002 "workspace" is deprecated (out-of-scope)`,
  ]);
});

test("4.2 a word must start and end at a word boundary", () => {
  assert.deepEqual(deprecates("workspace", "subworkspace workspacey\n"), []);
  assert.deepEqual(deprecates("workspace", "workspace-relative\n"), [
    'docs/a.md:1:1 P002 "workspace" is deprecated (out-of-scope)',
  ]);
  const md = "_workspace_ (workspace)\n";
  assert.deepEqual(deprecates("workspace", md), [
    `docs/a.md:${at(md, "workspace_")} P002 "workspace" is deprecated (out-of-scope)`,
    `docs/a.md:${at(md, "workspace)")} P002 "workspace" is deprecated (out-of-scope)`,
  ]);
});

test("4.2 a barrier is not a word character, so it bounds a word", () => {
  assert.deepEqual(deprecates("workspace", "`code`workspace\n"), [
    `docs/a.md:${at("`code`workspace", "workspace")} P002 "workspace" is deprecated (out-of-scope)`,
  ]);
  assert.deepEqual(deprecates("workspace", "workspace`code`\n"), [
    'docs/a.md:1:1 P002 "workspace" is deprecated (out-of-scope)',
  ]);
});

test("4.2 emphasis does not stop a match", () => {
  assert.deepEqual(rejects("workspace root", "the *workspace* root\n"), [
    rejected("workspace root", "1:6"),
  ]);
  assert.deepEqual(rejects("workspace root", "the **workspace** *root*\n"), [
    rejected("workspace root", "1:7"),
  ]);
});

test("4.2 a soft break, a hard break, a white space run, and a space reference match one space", () => {
  for (const md of [
    "pi-dent\nterms\n",
    "pi-dent  \nterms\n",
    "pi-dent \t  terms\n",
    "pi-dent&#32;terms\n",
    "pi-dent\u00a0terms\n",
  ]) {
    assert.deepEqual(rejects("pi-dent terms", md), [rejected("pi-dent terms", "1:1")], md);
  }
});

test("4.2 a match does not cross a barrier or a block", () => {
  assert.deepEqual(rejects("pi-dent terms", "pi-dent terms\n"), [rejected("pi-dent terms", "1:1")]);
  assert.deepEqual(rejects("pi-dent terms", "pi-dent `x` terms\n"), []);
  assert.deepEqual(rejects("pi-dent terms", "pi-dent\n\nterms\n"), []);
});

test("4.2 a capitalised variant is found with its flag", () => {
  const md = "Workspace and workspace\n";
  assert.deepEqual(rejects("workspace", md), [
    rejected("Workspace", "1:1"),
    rejected("workspace", at(md, "workspace\n")),
  ]);
});

test("4.2 tie-break: a longer spelled text comes first", () => {
  // The active label is the shorter variant; the deprecated longer one must win over it.
  const termsText = terms(
    entry("old", { label: "pi-dent terms", status: "deprecated", reason: "out-of-scope" }),
    entry("pt", { label: "pi-dent" }),
  );
  assert.deepEqual(texts(check(termsText, "pi-dent terms\n"), "P"), [
    'docs/a.md:1:1 P002 "pi-dent terms" is deprecated (out-of-scope)',
  ]);
});

test("4.2 tie-break: not capitalised comes before capitalised", () => {
  const termsText = terms(entry("lower", { label: "node" }), entry("upper", { label: "Node" }));
  assert.deepEqual(messages(check(termsText, "Node\n"), "T005"), [
    'lower: "node" is used by no document',
  ]);
});

test("4.2 tie-break: not plural comes before plural", () => {
  const termsText = terms(entry("cat"), entry("cats", { label: "cats" }));
  assert.deepEqual(messages(check(termsText, "cats\n"), "T005"), [
    'cat: "cat" is used by no document',
  ]);
});

test("4.2 tie-break: kind label, then form, then deprecated, then reject", () => {
  // The reject holder `a` has the smallest id, so only the kind order picks the other entry.
  const label = terms(
    entry("a", { label: "beta", reject: list("alpha") }),
    entry("l", { label: "alpha" }),
  );
  assert.deepEqual(texts(check(label, "alpha\n"), "P"), []);

  const form = terms(
    entry("a", { label: "beta", reject: list("alpha") }),
    entry("f", { label: "gamma", forms: list("alpha") }),
  );
  const formResult = check(form, "alpha\n");
  assert.deepEqual(texts(formResult, "P"), []);
  assert.deepEqual(messages(formResult, "T005"), ['a: "beta" is used by no document']);

  const deprecated = terms(
    entry("a", { label: "beta", reject: list("alpha") }),
    entry("d", { label: "alpha", status: "deprecated", reason: "out-of-scope" }),
  );
  assert.deepEqual(texts(check(deprecated, "alpha\n"), "P"), [
    'docs/a.md:1:1 P002 "alpha" is deprecated (out-of-scope)',
  ]);

  // Label before form: the form holder `a` has the smaller id.
  const labelForm = terms(
    entry("a", { label: "gamma", forms: list("alpha") }),
    entry("z", { label: "alpha" }),
  );
  assert.deepEqual(messages(check(labelForm, "alpha\n"), "T005"), [
    'a: "gamma" is used by no document',
  ]);
});

test("4.2 tie-break: ascending entry id", () => {
  const termsText = terms(entry("beta", { label: "alpha" }), entry("zeta", { label: "alpha" }));
  assert.deepEqual(messages(check(termsText, "alpha\n"), "T005"), [
    'zeta: "alpha" is used by no document',
  ]);
});

test("4.2 a reject phrase is found with its kind", () => {
  const md = "the repos and Repo\n";
  assert.deepEqual(rejects("repo", md), [
    rejected("repos", at(md, "repos")),
    rejected("Repo", at(md, "Repo")),
  ]);
});

test("4.3 a document uses an active entry by its label or form occurrences only", () => {
  const termsText = terms(
    entry("old", { label: "legacy tool", status: "deprecated", reason: "out-of-scope" }),
    entry("repo", { label: "repository", reject: list("repo") }),
    entry("unused", { label: "unused word" }),
    entry("ws", { label: "workspace", forms: list("work area") }),
  );
  const md = "A workspace, a work area, a repo, a legacy tool.\n";
  const result = check(termsText, md);
  assert.deepEqual(texts(result, "P"), [
    `docs/a.md:${at(md, "repo,")} P001 "repo" is rejected: use "repository" (repo)`,
    `docs/a.md:${at(md, "legacy tool")} P002 "legacy tool" is deprecated (out-of-scope)`,
  ]);
  assert.deepEqual(messages(result, "T005"), [
    'repo: "repository" is used by no document',
    'unused: "unused word" is used by no document',
  ]);
});

test("4.3 an entry used twice is reported once", () => {
  const termsText = terms(
    entry("a", { label: "alpha", key: "shared" }),
    entry("b", { label: "beta", key: "shared" }),
  );
  assert.deepEqual(messages(check(termsText, "beta alpha beta\n"), "T005"), [
    'a: "alpha" is shared but used only by docs/a.md',
    'b: "beta" is shared but used only by docs/a.md',
  ]);
});
