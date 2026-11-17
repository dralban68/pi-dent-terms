/**
 * Shared text helpers of specs/terms.md: character classes (Section 4.1), normalisation
 * (Section 4.1), code-unit comparison, quoting in messages, and findings (Section 5.1).
 */

/** One reported problem of a check (specs/terms.md, Section 5.1). */
export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

const WORD_CHAR = /^[\p{L}\p{M}\p{N}]$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;

/** True when `ch` is one character of Unicode general category L, M, or N. */
export function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch);
}

/** True when `ch` is one character with the Unicode property White_Space. */
export function isWhiteSpace(ch: string): boolean {
  return WHITE_SPACE.test(ch);
}

/** Replaces each maximal run of white space with one space and trims leading and trailing white space. */
export function normalise(s: string): string {
  return s
    .replace(/\p{White_Space}+/gu, " ")
    .replace(/^ /, "")
    .replace(/ $/, "");
}

/** `s` with leading and trailing white space (Section 4.1) removed, inner characters kept. */
export function trimWhiteSpace(s: string): string {
  return s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** Orders two strings by UTF-16 code units: negative, zero, or positive. */
export function compareUtf16(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** A value as it appears in a message: `"<x>"` as ECMAScript `JSON.stringify` writes it. */
export function quote(s: string): string {
  return JSON.stringify(s);
}

/** The text of a finding: `<path>:<line>:<column> <code> <message>`. */
export function findingText(f: Finding): string {
  return `${f.path}:${f.line}:${f.column} ${f.code} ${f.message}`;
}

/** Orders findings by path, line, column, code, then message (Section 5.1). */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    compareUtf16(a.path, b.path) ||
    a.line - b.line ||
    a.column - b.column ||
    compareUtf16(a.code, b.code) ||
    compareUtf16(a.message, b.message)
  );
}
