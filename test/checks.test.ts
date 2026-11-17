import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkspace, type CheckFinding, type WorkspaceCheck } from "../lib/checks.ts";
import { findingText, type Finding } from "../lib/text.ts";

const TERMS = ".pi/pi-dent/terms.yaml";
const DEFAULT_HISTORY = "\n      - { date: 2024-01-01, op: add }";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * An entry of the terms file text. The label defaults to the id; `overrides` replaces a field in
 * place (`null` leaves it out) or appends a new one.
 */
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
  for (const [name, value] of Object.entries(overrides)) {
    fields.set(name, value);
  }
  let out = `  - id: ${id}\n`;
  for (const [name, value] of fields) {
    if (value !== null) {
      out += `    ${name}: ${value}\n`;
    }
  }
  return out;
}

/** A deprecated entry replaced by the given ids, with the given reason. */
function deprecated(id: string, reason: string | null, replacedBy: string | null = null): string {
  return entry(id, {
    status: "deprecated",
    reason,
    replacedBy,
  });
}

function terms(...entries: string[]): string {
  return entries.length === 0 ? "terms: []\n" : `terms:\n${entries.join("")}`;
}

function check(termsText: string, docs: Record<string, string>): WorkspaceCheck {
  return checkWorkspace(bytes(termsText), new Map(Object.entries(docs)));
}

/** The findings as their texts (Section 5.1), in the order given. */
function texts(findings: readonly Finding[]): string[] {
  return findings.map(findingText);
}

function fileTexts(result: WorkspaceCheck): string[] {
  return texts(result.findings.filter((finding) => finding.code.startsWith("T")));
}

function proseTexts(result: WorkspaceCheck): string[] {
  return texts(
    result.findings.filter((finding) => finding.code.startsWith("P") || finding.code === "S001"),
  );
}

function codeFindings(result: WorkspaceCheck, code: CheckFinding["code"]): string[] {
  return texts(result.findings.filter((finding) => finding.code === code));
}

/**
 * The line and column of a needle in a text, as `<line>:<column>`: the first occurrence at or
 * after the anchor, plus an offset into the needle.
 */
function at(text: string, needle: string, offset = 0, anchor = ""): string {
  const start = anchor === "" ? 0 : text.indexOf(anchor);
  assert.notEqual(start, -1, `anchor ${anchor} is in the text`);
  const index = text.indexOf(needle, start);
  assert.notEqual(index, -1, `${needle} is in the text`);
  const before = text.slice(0, index + offset);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `${line}:${column}`;
}

// ---------------------------------------------------------------------------------------------
// 5.1 Findings, ordering, and suppression
// ---------------------------------------------------------------------------------------------

test("5.1 ordering: findings by path, then line, then column", () => {
  const t = terms(
    entry("alpha", { owner: "docs/b.md" }),
    entry("beta", { owner: "docs/b.md", reject: "[widget]", distinguish: "[nope]" }),
  );
  const result = check(t, {
    "docs/b.md": "Line one.\n\nA widget, alpha and beta.\n",
    "docs/a.md": "# Head\n\nThe widget here, widget again.\n",
  });
  const widget = '"widget" is rejected: use "beta" (beta)';
  assert.deepEqual(texts(result.findings), [
    `${TERMS}:${at(t, "nope")} T003 beta: distinguish names nope, which is not an entry`,
    `docs/a.md:3:5 P001 ${widget}`,
    `docs/a.md:3:18 P001 ${widget}`,
    `docs/b.md:3:3 P001 ${widget}`,
  ]);
});

test("5.1 suppression: a valid comment on the line before suppresses its code on the next line", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[widget]" })), {
    "docs/a.md": "<!-- terms-ignore P001: quoted from a standard -->\nThe widget here.\n",
  });
  assert.deepEqual(proseTexts(result), []);
});

test("5.1 suppression: a valid comment at the end of its line suppresses its code on that line", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[widget]" })), {
    "docs/a.md": "The widget here. <!-- terms-ignore P001: quoted -->\n",
  });
  assert.deepEqual(proseTexts(result), []);
});

test("5.1 suppression: a valid comment suppresses only its code", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[widget]" })), {
    "docs/a.md": "<!-- terms-ignore P002: not this one -->\nThe widget here.\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:2:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.1 suppression: a valid comment suppresses only its target line", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[widget]" })), {
    "docs/a.md": "<!-- terms-ignore P001: x -->\nThe widget.\n\nThe widget again.\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:4:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.1 suppression: one comment suppresses every occurrence of its code on its line", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[widget]" })), {
    "docs/a.md": "<!-- terms-ignore P001: x -->\nThe widget and widget.\n",
  });
  assert.deepEqual(proseTexts(result), []);
});

test("5.1 suppression: an invalid comment gives S001 and suppresses nothing", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[widget]" })), {
    "docs/a.md": "<!-- terms-ignore P003: no -->\nThe widget here.\n",
  });
  assert.deepEqual(proseTexts(result), [
    "docs/a.md:1:1 S001 terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
    'docs/a.md:2:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

// ---------------------------------------------------------------------------------------------
// 5.2 File checks
// ---------------------------------------------------------------------------------------------

test("5.2 clean workspace: no findings", () => {
  const result = check(terms(entry("alpha")), { "docs/a.md": "The alpha term.\n" });
  assert.deepEqual(texts(result.findings), []);
});

test("5.2 T001: invalid UTF-8 is reported at the file, first line, first column", () => {
  const result = checkWorkspace(new Uint8Array([0x74, 0xff]), new Map());
  assert.deepEqual(texts(result.findings), [`${TERMS}:1:1 T001 (file): not valid UTF-8`]);
});

test("5.2 T001: a root that is not a mapping is reported at the root, and nothing else", () => {
  const t = "- x\n";
  const result = check(t, {});
  assert.deepEqual(texts(result.findings), [`${TERMS}:1:1 T001 (root): must be a mapping`]);
});

test("5.2 T001: a missing label is placed at its entry, which is left out and still counts as an id", () => {
  const t = terms(entry("alpha", { label: null }), entry("beta", { distinguish: "[alpha]" }));
  const result = check(t, { "docs/a.md": "beta\n" });
  assert.deepEqual(texts(result.findings), [
    `${TERMS}:${at(t, "id: alpha")} T001 terms[0]: missing label`,
  ]);
});

test("5.2 T001: a finding of an item with no string id leaves every other entry checked", () => {
  const t = terms(entry("alpha"), "  - label: x\n");
  const result = check(t, { "docs/a.md": "nothing\n" });
  assert.deepEqual(texts(result.findings), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
    `${TERMS}:${at(t, "owner: docs/a.md", 7)} T006 alpha: owner docs/a.md does not use "alpha"`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing group`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing history`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing id`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing key`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing meaning`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing owner`,
    `${TERMS}:${at(t, "label: x")} T001 terms[1]: missing status`,
  ]);
});

test("5.2 T001: an unknown key of a history item is one finding and does not leave its entry out", () => {
  const t = terms(entry("alpha", { history: "[{ date: 2024-01-01, op: add, colour: red }]" }));
  const result = check(t, { "docs/a.md": "nothing\n" });
  assert.deepEqual(texts(result.findings), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
    `${TERMS}:${at(t, "owner: docs/a.md", 7)} T006 alpha: owner docs/a.md does not use "alpha"`,
    `${TERMS}:${at(t, "{ date")} T001 terms[0].history[0]: unknown keys "colour"`,
  ]);
});

test("5.2 T001: a value of the wrong type is placed at the value", () => {
  const t = terms(entry("alpha", { meaning: "5" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "5")} T001 terms[0].meaning: must be one non-empty line`,
  ]);
});

test("5.2 T001: an unknown key is one finding and does not leave its entry out", () => {
  const t = terms(entry("alpha", { colour: "red" }));
  const result = check(t, {});
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "id: alpha")} T001 terms[0]: unknown keys "colour"`,
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
    `${TERMS}:${at(t, "owner: docs/a.md", 7)} T003 alpha: owner docs/a.md is not a document`,
  ]);
});

test("5.2 T002: a label equal to the label of an earlier active entry", () => {
  const t = terms(entry("alpha"), entry("beta", { label: "alpha" }));
  const result = check(t, { "docs/a.md": "Use alpha.\n" });
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "label: alpha", 7, "id: beta")} T002 beta: "alpha" is also a label or form of alpha`,
  ]);
});

test("5.2 T002: a form equal to the label of an earlier active entry", () => {
  const t = terms(entry("alpha"), entry("beta", { forms: "[alpha]" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "alpha", 0, "forms:")} T002 beta: "alpha" is also a label or form of alpha`,
  ]);
});

test("5.2 T002: a form equal to the label of a deprecated entry, whatever its id", () => {
  const t = terms(
    entry("alpha", { forms: "[delta]" }),
    entry("gamma", {
      label: "delta",
      status: "deprecated",
      reason: "renamed",
      replacedBy: "[alpha]",
    }),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "delta", 0, "forms:")} T002 alpha: "delta" is also a label or form of gamma`,
  ]);
});

test("5.2 T002: a phrase equal to a reject phrase of the same active entry", () => {
  const t = terms(entry("alpha", { reject: "[alpha]" }));
  const result = check(t, {});
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T002 alpha: "alpha" is a reject phrase of alpha`,
  ]);
});

test("5.2 T002: a phrase equal to a reject phrase of another active entry", () => {
  const t = terms(entry("alpha"), entry("beta", { reject: "[alpha]" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T002 alpha: "alpha" is a reject phrase of beta`,
  ]);
});

test("5.2 T002: phrases are compared normalised", () => {
  const t = terms(
    entry("alpha", { label: "alpha  beta" }),
    entry("beta", { forms: "[alpha beta]" }),
  );
  const result = check(t, { "docs/a.md": "x\n" });
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "alpha beta", 0, "forms:")} T002 beta: "alpha beta" is also a label or form of alpha`,
  ]);
});

test("5.2 T002: reject phrases of a deprecated entry are not compared", () => {
  const t = terms(
    entry("alpha", { forms: "[zeta]" }),
    entry("gamma", {
      status: "deprecated",
      reason: "renamed",
      replacedBy: "[alpha]",
      reject: "[zeta]",
    }),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T002"), []);
});

test("5.2 T003: a distinguish id that is not an existing id", () => {
  const t = terms(entry("alpha", { distinguish: "[nope]" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "nope")} T003 alpha: distinguish names nope, which is not an entry`,
  ]);
});

test("5.2 T003: a replacedBy id that is not an existing id", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "renamed", "[nope]"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "nope")} T003 gamma: replacedBy names nope, which is not an entry`,
  ]);
});

test("5.2 T003: a reference to a left-out entry's id is no finding", () => {
  const t = terms(entry("alpha", { distinguish: "[broken]" }), entry("broken", { meaning: null }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), []);
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "id: broken")} T001 terms[1]: missing meaning`,
  ]);
});

test("5.2 T003: distinguish or replacedBy that names the entry itself", () => {
  const t = terms(
    entry("alpha", { distinguish: "[alpha]" }),
    deprecated("gamma", "renamed", "[gamma]"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "alpha", 0, "distinguish:")} T003 alpha: distinguish names the entry itself`,
    `${TERMS}:${at(t, "gamma", 0, "replacedBy:")} T003 gamma: replacedBy names the entry itself`,
  ]);
});

test("5.2 T003: an active owner that is not a document", () => {
  const t = terms(entry("alpha", { owner: "docs/missing.md" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "docs/missing.md")} T003 alpha: owner docs/missing.md is not a document`,
  ]);
});

test("5.2 T003: a replacedBy cycle is reported once, at its smallest id", () => {
  const t = terms(
    entry("alpha"),
    deprecated("delta", "renamed", "[gamma]"),
    deprecated("gamma", "renamed", "[delta]"),
    deprecated("zeta", "renamed", "[delta]"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "[gamma]", 0, "id: delta")} T003 delta: replacedBy cycle through delta, gamma`,
  ]);
});

test("5.2 T003: a self-loop in replacedBy is not a cycle", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "renamed", "[gamma]"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "gamma", 0, "replacedBy:")} T003 gamma: replacedBy names the entry itself`,
  ]);
});

test("5.2 T004: a deprecated entry without a reason is placed at the entry", () => {
  const t = terms(entry("alpha"), deprecated("gamma", null, "[alpha]"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "id: gamma")} T004 gamma: deprecated without a reason`,
  ]);
});

test("5.2 T004: reason merged needs exactly one replacement", () => {
  const t = terms(entry("alpha"), entry("beta"), deprecated("gamma", "merged", "[alpha, beta]"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "merged")} T004 gamma: reason merged needs exactly one replacement, has 2`,
  ]);
});

test("5.2 T004: reason renamed with no replacement needs exactly one", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "renamed"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "renamed")} T004 gamma: reason renamed needs exactly one replacement, has 0`,
  ]);
});

test("5.2 T004: reason split needs at least two replacements", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "split", "[alpha]"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "split")} T004 gamma: reason split needs at least two replacements, has 1`,
  ]);
});

test("5.2 T004: reason out-of-scope takes no replacement, and none is no finding", () => {
  const withReplacement = terms(entry("alpha"), deprecated("gamma", "out-of-scope", "[alpha]"));
  assert.deepEqual(codeFindings(check(withReplacement, { "docs/a.md": "alpha\n" }), "T004"), [
    `${TERMS}:${at(withReplacement, "out-of-scope")} T004 gamma: reason out-of-scope takes no replacement, has 1`,
  ]);
  const without = terms(entry("alpha"), deprecated("gamma", "out-of-scope"));
  assert.deepEqual(codeFindings(check(without, { "docs/a.md": "alpha\n" }), "T004"), []);
});

test("5.2 T004: an active entry has no reason and no replacement", () => {
  const t = terms(entry("alpha", { reason: "renamed", replacedBy: "[beta]" }), entry("beta"));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "renamed")} T004 alpha: reason is set on an active entry`,
    `${TERMS}:${at(t, "[beta]")} T004 alpha: replacedBy is set on an active entry`,
  ]);
});

test("5.2 T005: an active entry used by no document", () => {
  const t = terms(entry("alpha"));
  const result = check(t, { "docs/a.md": "Nothing here.\n" });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
  ]);
});

test("5.2 T005: a shared entry used by exactly one document", () => {
  const t = terms(entry("alpha", { key: "shared" }));
  const result = check(t, { "docs/a.md": "alpha here\n" });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is shared but used only by docs/a.md`,
  ]);
});

test("5.2 T005: a shared entry used by two documents, and a confusable one by one, are no findings", () => {
  const shared = terms(entry("alpha", { key: "shared" }));
  assert.deepEqual(
    codeFindings(check(shared, { "docs/a.md": "alpha\n", "docs/b.md": "alpha\n" }), "T005"),
    [],
  );
  const confusable = terms(entry("alpha"));
  assert.deepEqual(codeFindings(check(confusable, { "docs/a.md": "alpha\n" }), "T005"), []);
});

test("5.2 T005: a reject phrase is no use, and a deprecated entry is not checked", () => {
  const t = terms(
    entry("alpha"),
    entry("beta", { reject: "[widget]" }),
    deprecated("gamma", "renamed", "[alpha]"),
  );
  const result = check(t, { "docs/a.md": "alpha widget\n" });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: beta", 7)} T005 beta: "beta" is used by no document`,
  ]);
});

test("5.2 T002: a label equal to the labels of two others gives one finding for each", () => {
  const t = terms(
    entry("alpha", { label: "term" }),
    entry("beta", { label: "term" }),
    entry("zeta", {
      label: "term",
      status: "deprecated",
      reason: "renamed",
      replacedBy: "[alpha]",
    }),
  );
  const result = check(t, { "docs/a.md": "term\n" });
  assert.deepEqual(codeFindings(result, "T002"), [
    `${TERMS}:${at(t, "label: term", 7, "id: alpha")} T002 alpha: "term" is also a label or form of zeta`,
    `${TERMS}:${at(t, "label: term", 7, "id: beta")} T002 beta: "term" is also a label or form of alpha`,
    `${TERMS}:${at(t, "label: term", 7, "id: beta")} T002 beta: "term" is also a label or form of zeta`,
  ]);
});

test("5.2 T003: several separate cycles are each reported at their smallest id", () => {
  const t = terms(
    entry("alpha"),
    deprecated("beta", "renamed", "[gamma]"),
    deprecated("delta", "renamed", "[epsilon]"),
    deprecated("epsilon", "renamed", "[delta]"),
    deprecated("gamma", "renamed", "[beta]"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "[gamma]", 0, "id: beta")} T003 beta: replacedBy cycle through beta, gamma`,
    `${TERMS}:${at(t, "[epsilon]", 0, "id: delta")} T003 delta: replacedBy cycle through delta, epsilon`,
  ]);
});

test("5.2 T003: a chain into a cycle is no cycle for its head, and the cycle is reported once", () => {
  const t = terms(
    entry("alpha"),
    deprecated("beta", "renamed", "[gamma]"),
    deprecated("delta", "renamed", "[gamma]"),
    deprecated("gamma", "renamed", "[delta]"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "[gamma]", 0, "id: delta")} T003 delta: replacedBy cycle through delta, gamma`,
  ]);
});

test("5.2 T003: a cycle through an active entry is reported with its T004 finding", () => {
  const t = terms(
    entry("alpha", { replacedBy: "[gamma]" }),
    deprecated("gamma", "renamed", "[alpha]"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "[gamma]", 0, "id: alpha")} T003 alpha: replacedBy cycle through alpha, gamma`,
  ]);
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "[gamma]", 0, "id: alpha")} T004 alpha: replacedBy is set on an active entry`,
  ]);
});

test("5.2 T003: a self-reference inside a cycle gives both the self-reference and the cycle", () => {
  const t = terms(
    entry("alpha"),
    deprecated("delta", "split", "[delta, gamma]"),
    deprecated("gamma", "renamed", "[delta]"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T003"), [
    `${TERMS}:${at(t, "[delta, gamma]")} T003 delta: replacedBy cycle through delta, gamma`,
    `${TERMS}:${at(t, "delta, gamma]", 0, "replacedBy:")} T003 delta: replacedBy names the entry itself`,
  ]);
});

test("5.2 T004: merged with no replacement, split with none, and renamed with two", () => {
  const t = terms(
    entry("alpha"),
    deprecated("beta", "merged"),
    deprecated("delta", "renamed", "[alpha, beta]"),
    deprecated("gamma", "split"),
  );
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "merged")} T004 beta: reason merged needs exactly one replacement, has 0`,
    `${TERMS}:${at(t, "renamed")} T004 delta: reason renamed needs exactly one replacement, has 2`,
    `${TERMS}:${at(t, "split")} T004 gamma: reason split needs at least two replacements, has 0`,
  ]);
});

test("5.2 T004: an active entry with a reason alone is one finding", () => {
  const t = terms(entry("alpha", { reason: "merged" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T004"), [
    `${TERMS}:${at(t, "merged")} T004 alpha: reason is set on an active entry`,
  ]);
});

test("5.2 T006: an owner that does not use its entry", () => {
  const t = terms(entry("alpha"));
  const result = check(t, { "docs/a.md": "nothing\n", "docs/b.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T006"), [
    `${TERMS}:${at(t, "owner: docs/a.md", 7)} T006 alpha: owner docs/a.md does not use "alpha"`,
  ]);
});

// ---------------------------------------------------------------------------------------------
// 5.2 Left-out entries and concerns
// ---------------------------------------------------------------------------------------------

test("5.2 left-out: an entry with a T001 finding gives no finding other than T001", () => {
  const t = terms(
    entry("alpha"),
    entry("broken", {
      label: "alpha",
      meaning: null,
      owner: "docs/missing.md",
      reject: "[widget]",
    }),
  );
  const result = check(t, { "docs/a.md": "The alpha term and a widget.\n" });
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "id: broken")} T001 terms[1]: missing meaning`,
  ]);
  assert.deepEqual(proseTexts(result), []);
});

// ---------------------------------------------------------------------------------------------
// 5.3 Prose checks
// ---------------------------------------------------------------------------------------------

const BASE_PROSE = terms(entry("alpha"), entry("beta", { reject: "[widget]" }));

test("5.3 P001: a reject phrase gives the rejection with the label and id, plural and capitalised", () => {
  const result = check(BASE_PROSE, { "docs/a.md": "Widgets and Widget.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:1 P001 "Widgets" is rejected: use "beta" (beta)',
    'docs/a.md:1:13 P001 "Widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 P001: a reject phrase in a code span, or inside another word, is no occurrence", () => {
  const result = check(BASE_PROSE, { "docs/a.md": "`widget` and widgetry.\n" });
  assert.deepEqual(proseTexts(result), []);
});

test("5.3 P002: a deprecated label gives the deprecation with its reason and replacement", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "renamed", "[alpha]"));
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:5 P002 "gamma" is deprecated (renamed): use "alpha" (alpha)',
  ]);
});

test("5.3 P002: no reason and no replacement give none and no replacement text", () => {
  const t = terms(entry("alpha"), deprecated("gamma", null));
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), ['docs/a.md:1:5 P002 "gamma" is deprecated (none)']);
});

test("5.3 P002: a capitalised active label is a use, not a deprecated label spelled the same", () => {
  const t = terms(
    entry("session"),
    deprecated("session-tool", "out-of-scope").replace("label: session-tool", "label: Session"),
  );
  const result = check(t, { "docs/a.md": "# Session store\n\nSession ends. The Session.\n" });
  assert.deepEqual(proseTexts(result), []);
  assert.deepEqual(codeFindings(result, "T006"), []);
});

test("5.3 P002: out-of-scope gives the reason and no replacement text", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "out-of-scope"));
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), ['docs/a.md:1:5 P002 "gamma" is deprecated (out-of-scope)']);
});

test("5.3 P002: replacements in replacedBy order, joined by or", () => {
  const t = terms(entry("alpha"), entry("beta"), deprecated("gamma", "split", "[beta, alpha]"));
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:5 P002 "gamma" is deprecated (split): use "beta" (beta) or "alpha" (alpha)',
  ]);
});

test("5.3 P002: a replacement id that names no entry is given alone", () => {
  const t = terms(entry("alpha"), deprecated("gamma", "renamed", "[nope]"));
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:5 P002 "gamma" is deprecated (renamed): use nope',
  ]);
});

test("5.3 P002: a replacement that is left out is given by its id alone", () => {
  const t = terms(
    entry("alpha"),
    entry("broken", { meaning: null }),
    deprecated("gamma", "renamed", "[broken]"),
  );
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:5 P002 "gamma" is deprecated (renamed): use broken',
  ]);
});

test("5.3 one document's prose findings apply its valid suppressions", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "<!-- terms-ignore P001: x -->\nThe widget.\nAlso widget here.\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:3:6 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 S001: a comment with no reason is invalid", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "<!-- terms-ignore P001: -->\nThe widget here.\n",
  });
  assert.deepEqual(proseTexts(result), [
    "docs/a.md:1:1 S001 terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
    'docs/a.md:2:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 S001: a comment spanning two lines is invalid", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "<!-- terms-ignore P001: a\nreason -->\nThe widget.\n",
  });
  assert.deepEqual(proseTexts(result), [
    "docs/a.md:1:1 S001 terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
    'docs/a.md:3:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 S001: terms-ignore with no code is invalid", () => {
  const result = check(BASE_PROSE, { "docs/a.md": "<!-- terms-ignore -->\nThe widget.\n" });
  assert.deepEqual(proseTexts(result), [
    "docs/a.md:1:1 S001 terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
    'docs/a.md:2:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 P002: a replacement that is itself deprecated is named with its label and id", () => {
  const t = terms(
    entry("alpha"),
    deprecated("delta", "renamed", "[alpha]"),
    deprecated("gamma", "renamed", "[delta]"),
  );
  const result = check(t, { "docs/a.md": "The gamma here.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:5 P002 "gamma" is deprecated (renamed): use "delta" (delta)',
  ]);
});

test("3.3 an occurrence that starts on the line before a comment's target line is not suppressed", () => {
  const result = check(terms(entry("alpha"), entry("beta", { reject: "[red widget]" })), {
    "docs/a.md": "A red\nwidget <!-- terms-ignore P001: x -->\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:3 P001 "red widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 S001: an indented HTML block is placed at its comment's first character", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "   <!-- terms-ignore P001: -->\nThe widget.\n",
  });
  assert.deepEqual(proseTexts(result), [
    "docs/a.md:1:4 S001 terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
    'docs/a.md:2:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.3 S001: a comment inside a block quote is placed inside the quote", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "> <!-- terms-ignore P001: -->\n> The widget.\n",
  });
  assert.deepEqual(proseTexts(result), [
    "docs/a.md:1:3 S001 terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
    'docs/a.md:2:7 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("5.1 ordering: paths are ordered by UTF-16 code units, so an astral character sorts first", () => {
  const result = check(BASE_PROSE, {
    "\uFF5E.md": "The widget.\n",
    "\u{1F600}.md": "The widget.\n",
  });
  assert.deepEqual(proseTexts(result), [
    '\u{1F600}.md:1:5 P001 "widget" is rejected: use "beta" (beta)',
    '\uFF5E.md:1:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("3.3 a comment that is not terms-ignore followed by white space is no suppression comment", () => {
  const result = check(BASE_PROSE, { "docs/a.md": "<!-- terms-ignore: x -->\nThe widget.\n" });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:2:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

// ---------------------------------------------------------------------------------------------
// 3.3 Standalone suppression targets the first nonblank line after its block
// ---------------------------------------------------------------------------------------------

test("3.3 a standalone comment targets the first nonblank line after blank lines", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "<!-- terms-ignore P001: x -->\n\n  \nThe widget.\n",
  });
  assert.deepEqual(proseTexts(result), []);
});

test("3.3 standalone comments skip blank block-quote marker lines", () => {
  for (const prefix of ["> ", "> > "]) {
    const result = check(BASE_PROSE, {
      "docs/a.md": `${prefix}<!-- terms-ignore P001: x -->\n${prefix.trimEnd()}\n${prefix}# The widget.\n\nThe widget.\n`,
    });
    assert.deepEqual(proseTexts(result), [
      'docs/a.md:5:5 P001 "widget" is rejected: use "beta" (beta)',
    ]);
  }
});

test("3.3 standalone comments in list items skip blank lines and only suppress their target", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "- <!-- terms-ignore P001: x -->\n\n  # The widget.\n\n  The widget.\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:5:7 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("3.3 quote markers after ordered-list indentation are blank, but code outside the quote is not", () => {
  const quoted = check(BASE_PROSE, {
    "docs/a.md": "123. > <!-- terms-ignore P001: x -->\n     >\n     > # The widget.\n",
  });
  assert.deepEqual(proseTexts(quoted), []);
  const code = check(BASE_PROSE, {
    "docs/a.md": "> <!-- terms-ignore P001: x -->\n\n    >\n\nThe widget.\n",
  });
  assert.deepEqual(proseTexts(code), [
    'docs/a.md:5:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("3.3 a standalone comment with no nonblank line after it suppresses nothing and gives no S001", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "The widget.\n<!-- terms-ignore P001: x -->\n\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:1:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

test("3.3 another nonblank comment after a standalone comment is the target, not skipped", () => {
  const result = check(BASE_PROSE, {
    "docs/a.md": "<!-- terms-ignore P001: x -->\n<!-- note -->\nThe widget.\n",
  });
  assert.deepEqual(proseTexts(result), [
    'docs/a.md:3:5 P001 "widget" is rejected: use "beta" (beta)',
  ]);
});

// ---------------------------------------------------------------------------------------------
// 4.3 Uses by code span, and 5.2 local and external owner checks
// ---------------------------------------------------------------------------------------------

/** The check of a workspace with external owner texts (terms.md, Section 1.2). */
function checkWith(
  termsText: string,
  docs: Record<string, string>,
  externals: Record<string, string>,
): WorkspaceCheck {
  return checkWorkspace(
    bytes(termsText),
    new Map(Object.entries(docs)),
    new Map(Object.entries(externals)),
  );
}

test("4.3 code span: a whole code span equal to a shared label is a use, with no occurrence", () => {
  const t = terms(entry("alpha", { key: "shared" }));
  const result = check(t, { "docs/a.md": "Use `alpha` here.\n" });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is shared but used only by docs/a.md`,
  ]);
  assert.deepEqual(proseTexts(result), []);
});

test("4.3 code span: the capitalised variant of a label counts as a use", () => {
  const result = check(terms(entry("alpha")), { "docs/a.md": "Use `Alpha` here.\n" });
  assert.deepEqual(codeFindings(result, "T005"), []);
});

test("4.3 code span: a derived plural does not count, a form listed in forms does", () => {
  const plural = terms(entry("widget"));
  assert.deepEqual(codeFindings(check(plural, { "docs/a.md": "`widgets`\n" }), "T005"), [
    `${TERMS}:${at(plural, "label: widget", 7)} T005 widget: "widget" is used by no document`,
  ]);
  const listed = terms(entry("person", { forms: "[people]" }));
  assert.deepEqual(codeFindings(check(listed, { "docs/a.md": "`people`\n" }), "T005"), []);
});

test("4.3 code span: a code span that only contains a label among other words is no use", () => {
  const t = terms(entry("alpha"));
  const result = check(t, { "docs/a.md": "Run `run alpha now` or `alpha()`.\n" });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
  ]);
});

test("4.3 code span: a code span in a thesaurus table's Term cell is a use", () => {
  const t = terms(entry("alpha", { owner: "docs/a.md" }));
  const table = [
    "| Term | Meaning | Owner | Avoid or distinguish |",
    "| - | - | - | - |",
    "| `alpha` | A thing. | docs/a.md | |",
    "",
  ].join("\n");
  const result = check(t, { "docs/a.md": table });
  assert.deepEqual(codeFindings(result, "T005"), []);
  assert.deepEqual(codeFindings(result, "T006"), []);
});

test("4.3 code span: image descriptions hold no code-span use", () => {
  const t = terms(entry("alpha"));
  const result = check(t, { "docs/a.md": "![`alpha`](image.png)\n" });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
  ]);
});

test("4.3 code span: code blocks and HTML blocks hold no code-span use", () => {
  const t = terms(entry("alpha"));
  const result = check(t, {
    "docs/a.md": "```\n`alpha`\n```\n\n<div>`alpha`</div>\n",
  });
  assert.deepEqual(codeFindings(result, "T005"), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
  ]);
});

test("5.2 local: an owner that uses the entry, and no other document, gives no finding", () => {
  const result = check(terms(entry("alpha", { key: "local" })), { "docs/a.md": "alpha\n" });
  assert.deepEqual(fileTexts(result), []);
});

test("5.2 local: a local entry used by no document gives only the owner T006", () => {
  const t = terms(entry("alpha", { key: "local" }));
  const result = check(t, { "docs/a.md": "nothing\n" });
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "owner: docs/a.md", 7)} T006 alpha: owner docs/a.md does not use "alpha"`,
  ]);
});

test("5.2 local: one T005 per other document that uses the entry, and T006 when the owner does not", () => {
  const t = terms(entry("alpha", { key: "local" }));
  const result = check(t, {
    "docs/a.md": "nothing\n",
    "docs/b.md": "alpha\n",
    "docs/c.md": "alpha again\n",
  });
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is local but used by docs/b.md`,
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is local but used by docs/c.md`,
    `${TERMS}:${at(t, "owner: docs/a.md", 7)} T006 alpha: owner docs/a.md does not use "alpha"`,
  ]);
});

test("5.2 local: an owner that is not a document is T003, and other users are still reported", () => {
  const t = terms(entry("alpha", { key: "local", owner: "docs/missing.md" }));
  const result = check(t, { "docs/b.md": "alpha\n" });
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is local but used by docs/b.md`,
    `${TERMS}:${at(t, "docs/missing.md")} T003 alpha: owner docs/missing.md is not a document`,
  ]);
});

test("5.2 external: an external owner is not a document, so no T003 and no T005 use", () => {
  const t = terms(entry("alpha", { owner: "../shared/a.md" }));
  const unused = checkWith(t, { "docs/a.md": "nothing\n" }, {});
  assert.deepEqual(fileTexts(unused), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
  ]);
  const used = checkWith(t, { "docs/a.md": "nothing\n" }, { "../shared/a.md": "alpha\n" });
  assert.deepEqual(fileTexts(used), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is used by no document`,
  ]);
});

test("5.2 external: T006 examines the external owner text, a code span included", () => {
  const t = terms(entry("alpha", { owner: "../shared/a.md" }));
  const docs = { "docs/a.md": "alpha\n" };
  assert.deepEqual(codeFindings(checkWith(t, docs, { "../shared/a.md": "nothing\n" }), "T006"), [
    `${TERMS}:${at(t, "owner: ../shared/a.md", 7)} T006 alpha: owner ../shared/a.md does not use "alpha"`,
  ]);
  assert.deepEqual(
    codeFindings(checkWith(t, docs, { "../shared/a.md": "Uses `alpha`.\n" }), "T006"),
    [],
  );
});

test("5.2 external: an unavailable external owner text gives no T006", () => {
  const t = terms(entry("alpha", { owner: "../shared/a.md" }));
  const result = check(t, { "docs/a.md": "alpha\n" });
  assert.deepEqual(codeFindings(result, "T006"), []);
});

test("5.2 local: an external owner text that uses the entry gives no T006, other users still T005", () => {
  const t = terms(entry("alpha", { key: "local", owner: "../shared/a.md" }));
  const result = checkWith(t, { "docs/b.md": "alpha\n" }, { "../shared/a.md": "alpha\n" });
  assert.deepEqual(fileTexts(result), [
    `${TERMS}:${at(t, "label: alpha", 7)} T005 alpha: "alpha" is local but used by docs/b.md`,
  ]);
});
