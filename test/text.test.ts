import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareFindings,
  compareUtf16,
  findingText,
  isWhiteSpace,
  isWordChar,
  normalise,
  quote,
  type Finding,
} from "../lib/text.ts";

test("4.1 word character: general categories L, M, and N only", () => {
  for (const ch of ["a", "é", "中", "7", "٣", "\u0301"]) {
    assert.equal(isWordChar(ch), true, ch);
  }
  for (const ch of ["-", "'", " ", "_", "!", "😀", ""]) {
    assert.equal(isWordChar(ch), false, JSON.stringify(ch));
  }
});

test("4.1 white space: the Unicode White_Space property", () => {
  for (const ch of [" ", "\t", "\n", "\r", "\u00a0", "\u2028", "\u3000"]) {
    assert.equal(isWhiteSpace(ch), true, JSON.stringify(ch));
  }
  for (const ch of ["a", "\uFEFF", "\u200b", ""]) {
    assert.equal(isWhiteSpace(ch), false, JSON.stringify(ch));
  }
});

test("4.1 normalise: each maximal run of white space becomes one space, and the ends are trimmed", () => {
  assert.equal(normalise("  a \t\u00a0 b\n c  "), "a b c");
  assert.equal(normalise("a"), "a");
  assert.equal(normalise(" \n "), "");
  assert.equal(normalise("\uFEFFa"), "\uFEFFa");
});

test("5.1 ordering: strings are compared by UTF-16 code units", () => {
  assert.equal(compareUtf16("a", "b") < 0, true);
  assert.equal(compareUtf16("b", "a") > 0, true);
  assert.equal(compareUtf16("a", "a"), 0);
  assert.equal(compareUtf16("Z", "a") < 0, true);
  assert.equal(compareUtf16("\uFFFF", "\u{1F600}") > 0, true);
});

test("5.1 quote: a value as ECMAScript JSON.stringify writes it", () => {
  assert.equal(quote('say "hi"'), '"say \\"hi\\""');
  assert.equal(quote("a\nb"), '"a\\nb"');
});

test("5.1 finding text: <path>:<line>:<column> <code> <message>", () => {
  const finding: Finding = {
    path: ".pi/pi-dent/terms.yaml",
    line: 3,
    column: 9,
    code: "T001",
    message: "terms[0].key: must be one of shared, confusable",
  };
  assert.equal(
    findingText(finding),
    ".pi/pi-dent/terms.yaml:3:9 T001 terms[0].key: must be one of shared, confusable",
  );
});

test("5.1 finding order: by path, line, column, code, then message", () => {
  const at = (
    path: string,
    line: number,
    column: number,
    code: string,
    message: string,
  ): Finding => ({
    path,
    line,
    column,
    code,
    message,
  });
  const first = at("a.md", 1, 1, "P002", "x");
  const second = at("a.md", 2, 1, "P001", "a");
  const third = at("a.md", 2, 3, "P001", "a");
  const fourth = at("a.md", 2, 3, "P002", "a");
  const fifth = at("a.md", 2, 3, "P002", "b");
  const sixth = at("b.md", 1, 1, "P001", "a");
  const expected = [first, second, third, fourth, fifth, sixth];
  const shuffled = [fifth, first, sixth, third, second, fourth];
  assert.deepEqual(
    shuffled.toSorted(compareFindings).map((finding) => findingText(finding)),
    expected.map((finding) => findingText(finding)),
  );
});
