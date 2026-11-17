import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkspace } from "../lib/checks.ts";
import { findingText } from "../lib/text.ts";

const S001 = "terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A terms file of two active entries, `alpha` and `beta`, where `beta` rejects `phrase`. */
function termsFor(phrase: string): string {
  return [
    "terms:",
    "  - id: alpha",
    "    label: alpha",
    "    meaning: A thing.",
    "    owner: docs/a.md",
    "    group: Terms",
    "    key: confusable",
    "    status: active",
    "    history:",
    "      - { date: 2024-01-01, op: add }",
    "  - id: beta",
    "    label: beta",
    "    meaning: Another.",
    "    owner: docs/a.md",
    "    group: Terms",
    "    key: confusable",
    "    status: active",
    "    reject:",
    `      - ${JSON.stringify(phrase)}`,
    "    history:",
    "      - { date: 2024-01-01, op: add }",
    "",
  ].join("\n");
}

/** The prose findings (P and S codes) of `docs/a.md`, as texts, for a probe phrase. */
function prose(markdown: string, phrase: string): string[] {
  const result = checkWorkspace(bytes(termsFor(phrase)), new Map([["docs/a.md", markdown]]));
  return result.findings
    .filter((finding) => finding.code.startsWith("P") || finding.code === "S001")
    .map(findingText);
}

/** The P001 text of the probe phrase's occurrence spelled `spelled` at `where` (`line:column`). */
function rejected(spelled: string, where: string): string {
  return `docs/a.md:${where} P001 "${spelled}" is rejected: use "beta" (beta)`;
}

/** The line and column of the first `needle` in `text`, plus `offset` into it, as `line:column`. */
function at(text: string, needle: string, offset = 0): string {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `${needle} is in the text`);
  const lines = text.slice(0, index + offset).split("\n");
  return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
}

test("3.1 front matter holds no prose and keeps line numbers", () => {
  assert.deepEqual(prose("---\nwidget: x\n---\nThe widget.\n", "widget"), [
    rejected("widget", "4:5"),
  ]);
});

test("3.1 an unclosed front matter is prose", () => {
  assert.deepEqual(prose("---\nwidget\n", "widget"), [rejected("widget", "2:1")]);
});

test("3.2 code spans are barriers", () => {
  assert.deepEqual(prose("a `b` c\n", "a"), [rejected("a", "1:1")]);
  assert.deepEqual(prose("a `b` c\n", "a c"), []);
  assert.deepEqual(prose("a `b` c\n", "b"), []);
});

test("3.2 emphasis and strong emphasis are transparent", () => {
  assert.deepEqual(prose("*a* **b** _c_\n", "a b c"), [rejected("a b c", "1:2")]);
});

test("3.2 link text contributes, destination and title do not", () => {
  const md = 'see [the *text*](dest/x.md "title") now\n';
  assert.deepEqual(prose(md, "see the text now"), [rejected("see the text now", "1:1")]);
  assert.deepEqual(prose(md, "dest x"), []);
  assert.deepEqual(prose(md, "title"), []);
});

test("3.2 images, raw HTML, and autolinks are barriers", () => {
  const md = "a ![alt](i.png) b <span>c</span> d <http://x.y> e\n";
  assert.deepEqual(prose(md, "a b"), []);
  assert.deepEqual(prose(md, "b c"), []);
  assert.deepEqual(prose(md, "d e"), []);
  assert.deepEqual(prose(md, "alt"), []);
  assert.deepEqual(prose(md, "c"), [rejected("c", at(md, "c</span>"))]);
});

test("3.2 a backslash escape is the escaped character at the backslash", () => {
  const md = "a\\*b\n";
  assert.deepEqual(prose(md, "a*b"), [rejected("a*b", "1:1")]);
  assert.deepEqual(prose(md, "*b"), [rejected("*b", "1:2")]);
});

test("3.2 a character reference is the decoded characters at the reference", () => {
  const md = "x&amp;y &#x41;&#65;\n";
  assert.deepEqual(prose(md, "x&y AA"), [rejected("x&y AA", "1:1")]);
  assert.deepEqual(prose(md, "y AA"), [rejected("y AA", "1:7")]);
  assert.deepEqual(prose(md, "&amp;"), []);
});

test("3.2 an unknown character reference is literal text", () => {
  assert.deepEqual(prose("a &nosuch; b\n", "a &nosuch; b"), [rejected("a &nosuch; b", "1:1")]);
});

test("3.2 a soft break is one space at the break", () => {
  assert.deepEqual(prose("foo\nbar\n", "foo bar"), [rejected("foo bar", "1:1")]);
  assert.deepEqual(prose("foo\nbar\n", "bar"), [rejected("bar", "2:1")]);
});

test("3.2 a soft break strips the spaces around it", () => {
  assert.deepEqual(prose("foo \n   bar\n", "foo bar"), [rejected("foo bar", "1:1")]);
});

test("3.2 a hard break is one space at the break's start", () => {
  assert.deepEqual(prose("foo  \nbar\n", "foo bar"), [rejected("foo bar", "1:1")]);
  assert.deepEqual(prose("foo\\\nbar\n", "foo bar"), [rejected("foo bar", "1:1")]);
});

test("1.2 CRLF and CR line endings count as one line break each", () => {
  assert.deepEqual(prose("a\r\nb\n", "b"), [rejected("b", "2:1")]);
  assert.deepEqual(prose("a\rb\n", "b"), [rejected("b", "2:1")]);
});

test("1.2 columns count UTF-16 code units, so an astral character takes two", () => {
  assert.deepEqual(prose("\u{1F600} Foo\n", "Foo"), [rejected("Foo", "1:4")]);
});

test("3.2 a blockquote prefix contributes nothing", () => {
  assert.deepEqual(prose("> a\n> b\n", "a b"), [rejected("a b", "1:3")]);
});

test("3.2 a continuation line's '>' past the block quote markers is paragraph text", () => {
  assert.deepEqual(prose("see old\n    > name\n", "old > name"), [rejected("old > name", "1:5")]);
  assert.deepEqual(prose("> see old\n>     > name\n", "see old > name"), [
    rejected("see old > name", "1:3"),
  ]);
  assert.deepEqual(prose("- a\n      > b\n", "a > b"), [rejected("a > b", "1:3")]);
  assert.deepEqual(prose("see old  \n    > name\n", "old > name"), [rejected("old > name", "1:5")]);
  assert.deepEqual(prose("see old\n\t> name\n", "old > name"), [rejected("old > name", "1:5")]);
});

test("3.2 a continuation line's block quote markers are skipped up to the enclosing depth", () => {
  assert.deepEqual(prose("> a\n  > b\n", "a b"), [rejected("a b", "1:3")]);
  assert.deepEqual(prose("> a\n>\n> b\n", "a b"), []);
  assert.deepEqual(prose("> a\n>\n> b\n", "b"), [rejected("b", "3:3")]);
  assert.deepEqual(prose("> > a\n> > b\n", "a b"), [rejected("a b", "1:5")]);
});

test("3.2 a block quote marker inside nested list items is a marker, not text", () => {
  const md = "- - > legacy\n    > name\n\nalpha\n";
  assert.deepEqual(prose(md, "legacy name"), [rejected("legacy name", "1:7")]);
  assert.deepEqual(prose(md, "legacy > name"), []);
  assert.deepEqual(prose("1. > legacy\n   > name\n", "legacy name"), [
    rejected("legacy name", "1:6"),
  ]);
});

test("3.2 a hard break inside a block quote is one space and the next line's prefix contributes nothing", () => {
  assert.deepEqual(prose("> foo  \n> bar\n", "foo bar"), [rejected("foo bar", "1:3")]);
  assert.deepEqual(prose("> foo  \n> bar\n", "bar"), [rejected("bar", "2:3")]);
  assert.deepEqual(prose("> foo\\\n> bar\n", "foo bar"), [rejected("foo bar", "1:3")]);
});

test("3.2 headings, paragraphs, and table cells are prose blocks; code and HTML blocks are not", () => {
  const md = [
    "# Head",
    "",
    "    indented code",
    "",
    "```",
    "fenced",
    "```",
    "",
    "<div>block html</div>",
    "",
    "[ref]: /url",
    "",
    "| A | B |",
    "| - | - |",
    "| c | d |",
    "",
    "last",
    "",
  ].join("\n");
  assert.deepEqual(prose(md, "Head"), [rejected("Head", at(md, "Head"))]);
  assert.deepEqual(prose(md, "c"), [rejected("c", at(md, "c | d"))]);
  assert.deepEqual(prose(md, "last"), [rejected("last", at(md, "last"))]);
  assert.deepEqual(prose(md, "fenced"), []);
  assert.deepEqual(prose(md, "block html"), []);
  assert.deepEqual(prose(md, "indented code"), []);
  assert.deepEqual(prose(md, "ref"), []);
});

test("3.2 the Term and Avoid or distinguish cells of a thesaurus table hold no prose", () => {
  const md = [
    "| Term | Meaning | Owner | Avoid or distinguish |",
    "| - | - | - | - |",
    "| Foo | Some meaning | docs/a.md | bar |",
    "",
  ].join("\n");
  assert.deepEqual(prose(md, "Foo"), []);
  assert.deepEqual(prose(md, "bar"), []);
  assert.deepEqual(prose(md, "Some meaning"), [rejected("Some meaning", "3:9")]);
  assert.deepEqual(prose(md, "Term"), []);
  assert.deepEqual(prose(md, "Meaning"), [rejected("Meaning", at(md, "Meaning"))]);
});

test("3.2 the Term cell of a table that is not a thesaurus table is prose", () => {
  assert.deepEqual(prose("| Term | Meaning |\n| - | - |\n| Foo | bar |\n", "Foo"), [
    rejected("Foo", "3:3"),
  ]);
});

test("3.2 table cells are prose, an escaped pipe is a pipe, and a thesaurus Term cell is not", () => {
  const md = [
    "## Group",
    "",
    "| Term | Meaning | Owner | Avoid or distinguish |",
    "| - | - | - | - |",
    "| [Foo](docs/a.md) | a \\| b | [x](y/z.md#top) | `bar`, *baz* |",
    "",
  ].join("\n");
  assert.deepEqual(prose(md, "Group"), [rejected("Group", "1:4")]);
  assert.deepEqual(prose(md, "a | b"), [rejected("a | b", at(md, "a \\| b"))]);
  assert.deepEqual(prose(md, "x"), [rejected("x", at(md, "[x]", 1))]);
  assert.deepEqual(prose(md, "Foo"), []);
  assert.deepEqual(prose(md, "bar baz"), []);
});

test("3.2 a reference link's link text is prose, and a resolved reference is not literal text", () => {
  const md = "| T | M |\n| - | - |\n| [a b](dest%20x.md) | [r][ref] |\n\n[ref]: other.md\n";
  assert.deepEqual(prose(md, "a b"), [rejected("a b", "3:4")]);
  assert.deepEqual(prose(md, "r"), [rejected("r", at(md, "[r]", 1))]);
  assert.deepEqual(prose(md, "[r][ref]"), []);
});

test("3.2 in a table cell a code span and an image are barriers, raw HTML and autolinks hold no prose", () => {
  const md = "| A | B |\n| - | - |\n| `x y` ![alt](i.png) <b>h</b> <http://a.b> z |\n";
  assert.deepEqual(prose(md, "x y"), []);
  assert.deepEqual(prose(md, "alt"), []);
  assert.deepEqual(prose(md, "a.b"), []);
  assert.deepEqual(prose(md, "h"), [rejected("h", at(md, "h</b>"))]);
  assert.deepEqual(prose(md, "z"), [rejected("z", at(md, "z |"))]);
});

test("3.2 a heading's prose keeps the code span as a barrier", () => {
  const md = "## *Hello* `code` world\n";
  assert.deepEqual(prose(md, "Hello world"), []);
  assert.deepEqual(prose(md, "Hello"), [rejected("Hello", "1:5")]);
  assert.deepEqual(prose(md, "code"), []);
});

test("3.3 a raw inline suppression comment targets its own line", () => {
  const md = "widget <!-- terms-ignore P001: x --> bar\nnext widget\n";
  assert.deepEqual(prose(md, "widget"), [rejected("widget", "2:6")]);
});

test("3.3 an HTML block suppression comment targets the first nonblank line after its block", () => {
  const md = "<!-- terms-ignore P001: a reason -->\n  \n\nwidget\n";
  assert.deepEqual(prose(md, "widget"), []);
  assert.deepEqual(prose(md.replace("P001", "P002"), "widget"), [rejected("widget", "4:1")]);
});

test("3.3 an HTML block suppression comment with no nonblank line after it has no target", () => {
  // The line before the comment is the only one a wrong target could reach.
  assert.deepEqual(prose("widget\n<!-- terms-ignore P001: a reason -->\n\n   \n", "widget"), [
    rejected("widget", "1:1"),
  ]);
  assert.deepEqual(prose("widget\n<!-- terms-ignore P001: a reason -->", "widget"), [
    rejected("widget", "1:1"),
  ]);
});

test("3.3 a multi-line HTML block comment targets the line after its last line", () => {
  const md = "x\n\n<!--\nterms-ignore P001: a reason\n-->\nThe widget.\nThe widget.\n";
  assert.deepEqual(prose(md, "widget"), [rejected("widget", "7:5")]);
});

test("3.3 a suppression comment without a code, colon, or reason is invalid", () => {
  const md = [
    "<!-- terms-ignore P001 -->",
    "",
    "<!-- terms-ignore P003: nope -->",
    "",
    "<!-- terms-ignore P001:reason -->",
    "",
    "<!-- terms-ignore: P001 -->",
    "",
  ].join("\n");
  assert.deepEqual(prose(md, "widget"), [
    `docs/a.md:1:1 S001 ${S001}`,
    `docs/a.md:3:1 S001 ${S001}`,
    `docs/a.md:5:1 S001 ${S001}`,
  ]);
});

test("3.3 an invalid suppression comment has no code and gives no suppression", () => {
  const md = "foo <!-- terms-ignore P001 --> widget\n";
  assert.deepEqual(prose(md, "widget"), [
    `docs/a.md:1:5 S001 ${S001}`,
    rejected("widget", at(md, "widget")),
  ]);
});

test("3.3 a suppression comment in a line broken raw comment is invalid", () => {
  const md = "foo <!-- terms-ignore P001:\nreason --> widget\n";
  assert.deepEqual(prose(md, "widget"), [
    `docs/a.md:1:5 S001 ${S001}`,
    rejected("widget", at(md, "widget")),
  ]);
});

test("3.3 a comment that is not a terms-ignore comment is not a suppression comment", () => {
  const md = "foo <!-- note --> bar <!-- terms-ignored P001: x --> widget\n";
  assert.deepEqual(prose(md, "widget"), [rejected("widget", at(md, "widget"))]);
});

test("3.3 an HTML block holding more than the comment is neither a suppression comment nor prose", () => {
  const md = "<!-- terms-ignore P001: x --> more\nThe widget.\n";
  assert.deepEqual(prose(md, "more"), []);
  assert.deepEqual(prose(md, "widget"), [rejected("widget", "2:5")]);
});

test("3.3 suppression comments in front matter are ignored", () => {
  const md = "---\n<!-- terms-ignore P001: x -->\n---\nThe widget.\n";
  assert.deepEqual(prose(md, "widget"), [rejected("widget", "4:5")]);
});

test("3.2 text inside a list item and a block quote is prose", () => {
  const md = "- one\n- two\n\n> three\n";
  assert.deepEqual(prose(md, "two"), [rejected("two", "2:3")]);
  assert.deepEqual(prose(md, "three"), [rejected("three", "4:3")]);
});
