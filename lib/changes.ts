/**
 * Change checks (specs/terms.md, Section 5.4): the validation of a change set, the base workspace,
 * the line pairing, the introduced findings, and the label occurrences in changed lines.
 *
 * The functions are pure: the change set is supplied by the caller, and the library reads no
 * revision and runs no Git command. The inputs of `checkChanges` are those of `checkWorkspace`,
 * with the change set appended.
 */

import {
  analyseWorkspace,
  checkWorkspace,
  type CheckFinding,
  type WorkspaceCheck,
} from "./checks.ts";
import { TERMS_PATH, parseTermsFile } from "./terms-file.ts";
import { compareUtf16, normalise, quote } from "./text.ts";

/** A change of a change set (specs/terms.md, Section 5.4). */
export interface Change {
  /** The changed file's path in the workspace. */
  readonly path: string;
  /** The file's text in the base workspace; null when it has no file at the base path. */
  readonly before: string | null;
  /** The file's path in the base workspace when it was moved; absent means `path`. */
  readonly from?: string | undefined;
}

/** A label occurrence in a changed line (specs/terms.md, Section 5.4). */
export interface LabelOccurrence {
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  /** The occurrence's source text, normalised (Section 4.1). */
  readonly text: string;
}

/** The check of a change set: the introduced findings and the label occurrences. */
export interface ChangeCheck extends WorkspaceCheck {
  readonly occurrences: readonly LabelOccurrence[];
}

const CHANGE_PATH_RULE = `must be ${TERMS_PATH} or a workspace path ending with .md`;

const ENCODER = new TextEncoder();
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LINE_ENDING = /\r\n|\r|\n/;

// ---------------------------------------------------------------------------------------------
// Validation (specs/terms-tool.md, Section 1.2)

/** True when `path` is a workspace path (Section 1.1). */
function isWorkspacePath(path: string): boolean {
  if (path === "") {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** True when a `path` or `from` meets condition 1 of Section 5.4. */
function isChangePath(path: string): boolean {
  return path === TERMS_PATH || (path.endsWith(".md") && isWorkspacePath(path));
}

/** True when `text` holds a lone surrogate: a UTF-16 code unit without its pair. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** A change's base path: its `from`, else its `path` (Section 5.4). */
function basePathOf(change: Change): string {
  return change.from ?? change.path;
}

/**
 * The error text of the first failing check of specs/terms-tool.md, Section 1.2, for a change set,
 * or `undefined` when the change set is valid (Section 5.4). Items are examined in order; for each,
 * its `path`, then its `from` when set, then the item as a whole.
 */
export function validateChanges(changes: readonly Change[]): string | undefined {
  for (const [i, change] of changes.entries()) {
    const at = `changes[${i}]`;
    if (!isChangePath(change.path)) {
      return `${at}.path ${CHANGE_PATH_RULE}`;
    }
    if (change.from !== undefined) {
      if (!isChangePath(change.from)) {
        return `${at}.from ${CHANGE_PATH_RULE}`;
      }
      if ((change.from === TERMS_PATH) !== (change.path === TERMS_PATH)) {
        return `${at}.from must be ${TERMS_PATH} exactly when path is`;
      }
    }
    if (change.from !== undefined && change.before === null) {
      return `${at}.from needs a before text`;
    }
    if (change.before !== null && hasLoneSurrogate(change.before)) {
      return `${at}.before holds a lone surrogate`;
    }
    const earlier = changes.slice(0, i);
    if (earlier.some((other) => other.path === change.path)) {
      return `${at}.path repeats ${quote(change.path)}`;
    }
    const basePath = basePathOf(change);
    if (earlier.some((other) => basePathOf(other) === basePath)) {
      const field = change.from === undefined ? "path" : "from";
      return `${at}.${field} repeats the base path ${quote(basePath)}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Change check (specs/terms.md, Section 5.4)

/** One line number of a base text paired with one of a current text; both counted from 1. */
interface Pair {
  readonly base: number;
  readonly current: number;
}

/**
 * A contiguous range of line numbers, empty when `start` is greater than `end`; the range of a last
 * region ends at `Number.POSITIVE_INFINITY`, which also holds the lines past a text's last line.
 */
interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** A change with its texts, its line pairing, and its changed lines. */
interface ChangeAnalysis {
  readonly change: Change;
  readonly basePath: string;
  readonly baseLines: readonly string[];
  readonly currentLines: readonly string[];
  readonly pairs: readonly Pair[];
  /** The current lines that are in no pair. */
  readonly changed: ReadonlySet<number>;
}

/** The base workspace of a change set (Section 5.4). */
interface BaseWorkspace {
  readonly termsBytes: Uint8Array | undefined;
  readonly documents: ReadonlyMap<string, string>;
}

/** `text` without a leading U+FEFF. */
function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** A text decoded as UTF-8 without a leading U+FEFF; the empty text when absent or invalid. */
function decodeText(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) {
    return "";
  }
  try {
    return stripBom(UTF8.decode(bytes));
  } catch {
    return "";
  }
}

/** The lines of a text (Section 5.4): its parts between line endings, without a trailing empty one. */
function linesOf(text: string): string[] {
  const parts = text.split(LINE_ENDING);
  if (parts.at(-1) === "") {
    parts.pop();
  }
  return parts;
}

/**
 * The line pairing of a change (Section 5.4): a longest list of equal-line pairs, ascending in both
 * numbers, the smallest sequence `i1, j1, i2, j2, …` among the longest.
 */
function linePairing(base: readonly string[], current: readonly string[]): Pair[] {
  const m = base.length;
  const n = current.length;
  if (m === 0 || n === 0) {
    return [];
  }
  const width = n + 1;
  // lcs[i, j] is the length of a longest common subsequence of base[i…] and current[j…].
  const lcs = new Int32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const down = lcs[(i + 1) * width + j] ?? 0;
      const right = lcs[i * width + j + 1] ?? 0;
      lcs[i * width + j] =
        base[i] === current[j] ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(down, right);
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const remaining = lcs[i * width + j] ?? 0;
    if (remaining === 0) {
      break;
    }
    // The smallest feasible current line for base line i; none means every longest pairing skips i.
    let match = -1;
    for (let b = j; b < n; b++) {
      if (base[i] === current[b] && 1 + (lcs[(i + 1) * width + b + 1] ?? 0) === remaining) {
        match = b;
        break;
      }
    }
    if (match === -1) {
      i++;
    } else {
      pairs.push({ base: i + 1, current: match + 1 });
      i++;
      j = match + 1;
    }
  }
  return pairs;
}

/** The base workspace of a change set (Section 5.4): each change undone. */
function baseWorkspace(
  termsBytes: Uint8Array,
  documents: ReadonlyMap<string, string>,
  changes: readonly Change[],
): BaseWorkspace {
  const removed = new Set<string>();
  for (const change of changes) {
    removed.add(change.path);
    removed.add(basePathOf(change));
  }
  const baseDocuments = new Map<string, string>();
  for (const [path, text] of documents) {
    if (!removed.has(path)) {
      baseDocuments.set(path, text);
    }
  }
  for (const change of changes) {
    const basePath = basePathOf(change);
    const before = change.before;
    if (before !== null && basePath.endsWith(".md") && !before.includes("\u0000")) {
      baseDocuments.set(basePath, stripBom(before));
    }
  }
  const termsChange = changes.find((change) => change.path === TERMS_PATH);
  let baseTermsBytes: Uint8Array | undefined = termsBytes;
  if (termsChange !== undefined) {
    baseTermsBytes = termsChange.before === null ? undefined : ENCODER.encode(termsChange.before);
  }
  return { termsBytes: baseTermsBytes, documents: baseDocuments };
}

/** A change with its base and current texts, its line pairing, and its changed lines. */
function analyseChange(
  change: Change,
  termsBytes: Uint8Array,
  documents: ReadonlyMap<string, string>,
): ChangeAnalysis {
  const baseText = stripBom(change.before ?? "");
  const currentText =
    change.path === TERMS_PATH ? decodeText(termsBytes) : (documents.get(change.path) ?? "");
  const baseLines = linesOf(baseText);
  const currentLines = linesOf(currentText);
  const pairs = linePairing(baseLines, currentLines);
  const paired = new Set(pairs.map((pair) => pair.current));
  const changed = new Set<number>();
  for (let line = 1; line <= currentLines.length; line++) {
    if (!paired.has(line)) {
      changed.add(line);
    }
  }
  return { change, basePath: basePathOf(change), baseLines, currentLines, pairs, changed };
}

/**
 * The base lines of a finding of a change's file (Section 5.4): the base line of its pair, else the
 * lines of the base region that corresponds to the region holding its line. The last region of the
 * base text also holds every line number past its last line.
 */
function baseRange(analysis: ChangeAnalysis, line: number): LineRange {
  const paired = analysis.pairs.find((pair) => pair.current === line);
  if (paired !== undefined) {
    return { start: paired.base, end: paired.base };
  }
  let k = 0;
  while (k < analysis.pairs.length && (analysis.pairs[k]?.current ?? 0) < line) {
    k++;
  }
  const previous = k === 0 ? 0 : (analysis.pairs[k - 1]?.base ?? 0);
  const next =
    k === analysis.pairs.length
      ? Number.POSITIVE_INFINITY
      : (analysis.pairs[k]?.base ?? Number.POSITIVE_INFINITY);
  return { start: previous + 1, end: next - 1 };
}

/** The key of the group of findings with the same base path, base lines, code, and message. */
function groupKey(basePath: string, range: LineRange, code: string, message: string): string {
  return JSON.stringify([
    basePath,
    range.start,
    range.end === Number.POSITIVE_INFINITY ? "end" : range.end,
    code,
    message,
  ]);
}

/** The base count of a group: base findings at its base path, on its base lines, with its code. */
function countBase(
  baseFindings: readonly CheckFinding[],
  basePath: string,
  range: LineRange,
  code: string,
  message: string,
): number {
  let count = 0;
  for (const finding of baseFindings) {
    if (
      finding.path === basePath &&
      finding.line >= range.start &&
      finding.line <= range.end &&
      finding.code === code &&
      finding.message === message
    ) {
      count++;
    }
  }
  return count;
}

/** Orders label occurrences by id, then path, line, and column (Section 5.4). */
function compareOccurrences(a: LabelOccurrence, b: LabelOccurrence): number {
  return (
    compareUtf16(a.id, b.id) ||
    compareUtf16(a.path, b.path) ||
    a.line - b.line ||
    a.column - b.column
  );
}

/** The label occurrences in changed lines (Section 5.4). */
function labelOccurrences(
  analyses: readonly ChangeAnalysis[],
  termsBytes: Uint8Array,
  documents: ReadonlyMap<string, string>,
  externalOwners: ReadonlyMap<string, string>,
): LabelOccurrence[] {
  const changedDocuments = analyses.filter((analysis) => analysis.change.path !== TERMS_PATH);
  if (changedDocuments.length === 0) {
    return [];
  }
  const ws = analyseWorkspace(parseTermsFile(termsBytes), documents, externalOwners);
  const out: LabelOccurrence[] = [];
  for (const analysis of changedDocuments) {
    const doc = ws.documents.get(analysis.change.path);
    if (doc === undefined) {
      continue;
    }
    for (const occurrence of doc.occurrences) {
      const { kind } = occurrence.variant;
      if (kind !== "label" && kind !== "form") {
        continue;
      }
      if (!analysis.changed.has(occurrence.line)) {
        continue;
      }
      const entry = ws.entries.get(occurrence.variant.entry.id)?.entry;
      if (entry === undefined) {
        continue;
      }
      out.push({
        id: entry.id,
        label: entry.label,
        meaning: entry.meaning,
        path: doc.path,
        line: occurrence.line,
        column: occurrence.column,
        text: normalise(occurrence.source),
      });
    }
  }
  return out.toSorted(compareOccurrences);
}

/**
 * The check of a workspace with a change set (specs/terms.md, Section 5.4): the introduced findings
 * and the label occurrences in changed lines. The change set MUST be valid (see `validateChanges`).
 */
export function checkChanges(
  termsBytes: Uint8Array,
  documents: ReadonlyMap<string, string>,
  externalOwners: ReadonlyMap<string, string>,
  changes: readonly Change[],
): ChangeCheck {
  const current = checkWorkspace(termsBytes, documents, externalOwners);
  const base = baseWorkspace(termsBytes, documents, changes);
  const baseFindings =
    base.termsBytes === undefined
      ? []
      : checkWorkspace(base.termsBytes, base.documents, externalOwners).findings;
  const analyses = changes.map((change) => analyseChange(change, termsBytes, documents));
  const byPath = new Map(analyses.map((analysis) => [analysis.change.path, analysis]));
  const groups = new Map<string, { baseCount: number; seen: number }>();
  const introduced: CheckFinding[] = [];
  for (const finding of current.findings) {
    const analysis = byPath.get(finding.path);
    const basePath = analysis === undefined ? finding.path : analysis.basePath;
    const range =
      analysis === undefined
        ? { start: finding.line, end: finding.line }
        : baseRange(analysis, finding.line);
    const key = groupKey(basePath, range, finding.code, finding.message);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        baseCount: countBase(baseFindings, basePath, range, finding.code, finding.message),
        seen: 0,
      };
      groups.set(key, group);
    }
    group.seen++;
    if (group.seen > group.baseCount) {
      introduced.push(finding);
    }
  }
  return {
    findings: introduced,
    documentCount: current.documentCount,
    termsCount: current.termsCount,
    occurrences: labelOccurrences(analyses, termsBytes, documents, externalOwners),
  };
}
