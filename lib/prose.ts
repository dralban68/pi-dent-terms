/**
 * Prose of a document: runs of characters with source positions, suppression comments, tables,
 * and headings. See specs/terms.md, Sections 1.2, 3.1, 3.2, 3.3, and 6.8.
 *
 * Approach: the document is parsed with mdast (CommonMark plus the GFM table extension). mdast
 * gives the block and inline structure and exact UTF-16 source offsets of every node, but merges
 * escapes and character references into text values. So each text node is re-scanned in its
 * source slice: a backslash escape yields the escaped character at the backslash, a character
 * reference that decodes yields its characters at the reference, a line ending yields one space
 * at the break, and the container prefixes (`>`) and indentation that CommonMark strips at the
 * start of a continuation line contribute nothing. Front matter is masked with spaces before
 * parsing, so every offset stays the offset in the document text.
 */

import type { Html, Nodes, PhrasingContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { decodeString } from "micromark-util-decode-string";
import { normalise } from "./text.ts";

export interface ProseChar {
  readonly kind: "char";
  /** One Unicode scalar value. */
  readonly char: string;
  /** Line and column (UTF-16) of the source start. */
  readonly line: number;
  readonly column: number;
  /** UTF-16 offsets of the source start and end in the document text. */
  readonly start: number;
  readonly end: number;
}

export interface ProseBarrier {
  readonly kind: "barrier";
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

export type ProseItem = ProseChar | ProseBarrier;

export interface ProseRun {
  readonly kind: "heading" | "paragraph" | "cell";
  readonly items: readonly ProseItem[];
}

export interface ProseCell {
  readonly line: number;
  readonly column: number;
  /** The cell text (Section 6.8): normalised, code span content and image descriptions included. */
  readonly text: string;
  /** Destinations of the links in the cell, in document order. */
  readonly links: readonly string[];
}

export interface ProseRow {
  readonly line: number;
  readonly cells: readonly ProseCell[];
}

export interface ProseTable {
  readonly line: number;
  /** Whether the header cell texts are `Term`, `Meaning`, `Owner`, `Avoid or distinguish` (Section 6.8). */
  readonly thesaurus: boolean;
  readonly header: ProseRow;
  readonly body: readonly ProseRow[];
}

export interface ProseHeading {
  readonly line: number;
  readonly column: number;
  /** The heading text, as the cell text of Section 6.8. */
  readonly text: string;
}

export interface ProseSuppression {
  readonly line: number;
  readonly column: number;
  /** The target line; absent when no nonblank line follows the comment's block (Section 3.3). */
  readonly targetLine?: number;
  readonly valid: boolean;
  readonly code?: "P001" | "P002";
}

export interface ProseDocument {
  readonly runs: readonly ProseRun[];
  readonly headings: readonly ProseHeading[];
  readonly tables: readonly ProseTable[];
  readonly suppressions: readonly ProseSuppression[];
  /** The raw values of the code spans of the document, in document order (Section 4.3). */
  readonly codeSpans: readonly string[];
}

/** The prose runs of a document, in document order. */
export function proseRuns(text: string): readonly ProseRun[] {
  return parseProse(text).runs;
}

/** The suppression comments of a document, in document order. */
export function suppressionComments(text: string): readonly ProseSuppression[] {
  return parseProse(text).suppressions;
}

/** Parses a document (its text without a leading U+FEFF) into its prose, tables, and headings. */
export function parseProse(text: string): ProseDocument {
  const masked = maskFrontMatter(text);
  const tree = fromMarkdown(masked, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const ctx: Ctx = {
    masked,
    locate: lineLocator(text),
    definitions: definitionsOf(tree),
    containers: [],
    quoteEnds: [],
  };
  const doc: Document = { runs: [], headings: [], tables: [], suppressions: [], codeSpans: [] };
  visitBlock(ctx, tree, doc);
  codeSpansOf(tree, doc.codeSpans);
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Internals

interface Ctx {
  /** The document text with front matter blanked; same length, same offsets. */
  readonly masked: string;
  readonly locate: (offset: number) => { line: number; column: number };
  /** Link reference identifier to destination; the first definition wins. */
  readonly definitions: ReadonlyMap<string, string>;
  /** The containers enclosing the node being visited, outermost first. */
  readonly containers: readonly Container[];
  /** Last source line of each enclosing block quote, outermost first. */
  readonly quoteEnds: readonly number[];
}

/**
 * A container enclosing a prose block (Section 3.2): its prefix is stripped from the start of a
 * continuation line before the prose resumes.
 */
type Container =
  | { readonly kind: "quote" }
  /** A list item: the indentation of its content from the enclosing container's content. */
  | { readonly kind: "item"; readonly indent: number };

interface Document {
  runs: ProseRun[];
  headings: ProseHeading[];
  tables: ProseTable[];
  suppressions: ProseSuppression[];
  codeSpans: string[];
}

type Mode = "prose" | "text";

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/u;
const ENTITY = /&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[\da-zA-Z]{1,31});/y;
const TRIM = /^\p{White_Space}+|\p{White_Space}+$/gu;
const TERMS_IGNORE = /^terms-ignore(?:\p{White_Space}|$)/u;
const SUPPRESSION = /^terms-ignore[ \t]+(P001|P002):[ \t]+\S/u;
const THESAURUS_HEADER = ["Term", "Meaning", "Owner", "Avoid or distinguish"];

function maskFrontMatter(text: string): string {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(/\r\n|\r|\n/gu)) {
    lines.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  lines.push({ start, end: text.length });
  const first = lines[0];
  if (first === undefined || text.slice(first.start, first.end) !== "---") {
    return text;
  }
  const close = lines.findIndex((line, k) => k > 0 && text.slice(line.start, line.end) === "---");
  if (close < 0) {
    return text;
  }
  const last = lines[close];
  if (last === undefined) {
    return text;
  }
  const blanked = text.slice(first.start, last.end).replace(/[^\r\n]/g, " ");
  return text.slice(0, first.start) + blanked + text.slice(last.end);
}

function lineLocator(text: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "\r" && text.charAt(i + 1) === "\n") {
      i++;
      starts.push(i + 1);
    } else if (c === "\r" || c === "\n") {
      starts.push(i + 1);
    }
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
  };
}

/** The values of the code spans under a node, in document order; code blocks hold none. */
function codeSpansOf(node: Nodes, out: string[]): void {
  if (node.type === "inlineCode") {
    out.push(node.value);
    return;
  }
  if ("children" in node) {
    for (const child of node.children) {
      codeSpansOf(child, out);
    }
  }
}

/** The first nonblank line after the block, ignoring its enclosing quote markers (Section 3.3). */
function nextNonblankLine(
  text: string,
  after: number,
  quoteEnds: readonly number[],
): number | undefined {
  const lines = text.split(/\r\n|\r|\n/u);
  for (let k = after; k < lines.length; k++) {
    let content = lines[k] ?? "";
    for (const endLine of quoteEnds) {
      if (k + 1 > endLine) break;
      // List indentation can place an enclosing quote marker beyond column four.
      content = content.replace(/^\p{White_Space}*>[ \t]?/u, "");
    }
    if (/[^\p{White_Space}]/u.test(content)) {
      return k + 1;
    }
  }
  return undefined;
}

function definitionsOf(tree: Nodes): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: Nodes): void => {
    if (node.type === "definition" && !map.has(node.identifier)) {
      map.set(node.identifier, node.url);
    }
    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(tree);
  return map;
}

function visitBlock(ctx: Ctx, node: Nodes, doc: Document): void {
  switch (node.type) {
    case "heading": {
      const { line, column } = ctx.locate(offsetOf(node.position?.start));
      const items: ProseItem[] = [];
      inline(ctx, node.children, "prose", items, doc.suppressions);
      doc.runs.push({ kind: "heading", items });
      doc.headings.push({ line, column, text: plainText(ctx, node.children) });
      return;
    }
    case "paragraph": {
      const items: ProseItem[] = [];
      inline(ctx, node.children, "prose", items, doc.suppressions);
      doc.runs.push({ kind: "paragraph", items });
      return;
    }
    case "table":
      visitTable(ctx, node, doc);
      return;
    case "html":
      blockComment(ctx, node, doc.suppressions);
      return;
    case "code":
    case "definition":
    case "thematicBreak":
      return;
    default:
      if ("children" in node) {
        const inner = containerCtx(ctx, node);
        for (const child of node.children) {
          visitBlock(inner, child, doc);
        }
      }
  }
}

/** The context of a node's children: the node's own container prefix is now enclosing. */
function containerCtx(ctx: Ctx, node: Nodes): Ctx {
  const start = node.position?.start;
  if (node.type === "blockquote") {
    return {
      ...ctx,
      containers: [...ctx.containers, { kind: "quote" }],
      quoteEnds: [...ctx.quoteEnds, node.position?.end.line ?? 0],
    };
  }
  if (node.type === "listItem" && start !== undefined) {
    const indent = listItemIndent(ctx.masked, start.offset ?? 0, start.column);
    return { ...ctx, containers: [...ctx.containers, { kind: "item", indent }] };
  }
  return ctx;
}

/**
 * The indentation of a list item's content from its enclosing container's content (CommonMark
 * 0.31.2, Section 5.2): the marker's width plus the columns that follow it, one when there are none
 * or more than four, the rest being content indentation.
 */
function listItemIndent(t: string, offset: number, column: number): number {
  let k = offset;
  let width = 0;
  const first = t.charAt(k);
  if (first === "-" || first === "*" || first === "+") {
    width = 1;
    k++;
  } else {
    while (/[0-9]/u.test(t.charAt(k))) {
      width++;
      k++;
    }
    if (t.charAt(k) === "." || t.charAt(k) === ")") {
      width++;
      k++;
    }
  }
  // Tab stops are counted from the start of the line, so the marker's column sets them.
  let at = column - 1 + width;
  const afterMarker = at;
  while (k < t.length && isBlank(t.charAt(k))) {
    at += t.charAt(k) === "\t" ? 4 - (at % 4) : 1;
    k++;
  }
  const spaces = at - afterMarker;
  return width + (spaces >= 1 && spaces <= 4 ? spaces : 1);
}

function visitTable(ctx: Ctx, node: Table, doc: Document): void {
  const rows = node.children;
  const headerNode = rows[0];
  if (headerNode === undefined) {
    return;
  }
  const headerTexts = headerNode.children.map((cell) => plainText(ctx, cell.children));
  const thesaurus =
    headerTexts.length === THESAURUS_HEADER.length &&
    headerTexts.every((text, k) => text === THESAURUS_HEADER[k]);
  const rowsOut: ProseRow[] = [];
  for (const row of rows) {
    const cells: ProseCell[] = row.children.map((cell, c) => {
      const { line, column } = ctx.locate(offsetOf(cell.position?.start));
      const links: string[] = [];
      linkDestinations(ctx, cell.children, links);
      // Section 3.2: the Term and Avoid or distinguish cells of a thesaurus table hold no prose.
      const excluded = thesaurus && (c === 0 || c === 3);
      const items: ProseItem[] = [];
      inline(ctx, cell.children, "prose", items, excluded ? undefined : doc.suppressions);
      if (!excluded) {
        doc.runs.push({ kind: "cell", items });
      }
      return { line, column, text: plainText(ctx, cell.children), links };
    });
    rowsOut.push({ line: ctx.locate(offsetOf(row.position?.start)).line, cells });
  }
  const headerRow = rowsOut[0];
  if (headerRow === undefined) {
    return;
  }
  doc.tables.push({
    line: ctx.locate(offsetOf(node.position?.start)).line,
    thesaurus,
    header: headerRow,
    body: rowsOut.slice(1),
  });
}

type Point = NonNullable<Nodes["position"]>["start"];

function offsetOf(point: Point | undefined): number {
  return point?.offset ?? 0;
}

/** The inline content of a node in one mode: prose items, or the cell text's characters. */
function inline(
  ctx: Ctx,
  nodes: readonly PhrasingContent[],
  mode: Mode,
  out: ProseItem[],
  comments?: ProseSuppression[],
): void {
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    switch (node.type) {
      case "text":
        rescan(ctx, start, end, out);
        break;
      case "break":
        out.push(charItem(ctx, " ", start, end));
        break;
      case "emphasis":
      case "strong":
      case "linkReference":
        inline(ctx, node.children, mode, out, comments);
        break;
      case "link":
        if (isAutolink(ctx, start)) {
          barrierOrNothing(ctx, mode, start, end, out);
        } else {
          inline(ctx, node.children, mode, out, comments);
        }
        break;
      case "inlineCode":
        if (mode === "text") {
          for (const ch of node.value) {
            out.push(charItem(ctx, ch, start, end));
          }
        } else {
          out.push(barrier(ctx, start, end));
        }
        break;
      case "image":
      case "imageReference":
        if (mode === "text") {
          const alt = node.alt ?? "";
          for (const ch of alt) {
            out.push(charItem(ctx, ch, start, end));
          }
        } else {
          out.push(barrier(ctx, start, end));
        }
        break;
      case "html":
        if (comments !== undefined) {
          inlineComment(ctx, node.value, start, comments);
        }
        barrierOrNothing(ctx, mode, start, end, out);
        break;
      default:
        out.push(barrier(ctx, start, end));
    }
  }
}

function barrierOrNothing(
  ctx: Ctx,
  mode: Mode,
  start: number,
  end: number,
  out: ProseItem[],
): void {
  if (mode === "prose") {
    out.push(barrier(ctx, start, end));
  }
}

function isAutolink(ctx: Ctx, start: number): boolean {
  return ctx.masked.charAt(start) === "<";
}

/** Destinations of the links of a cell, in document order; reference links use their definition. */
function linkDestinations(ctx: Ctx, nodes: readonly PhrasingContent[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === "link" && !isAutolink(ctx, offsetOf(node.position?.start))) {
      out.push(node.url);
    } else if (node.type === "linkReference") {
      const url = ctx.definitions.get(node.identifier);
      if (url !== undefined) {
        out.push(url);
      }
    }
    if ("children" in node) {
      linkDestinations(ctx, node.children, out);
    }
  }
}

function plainText(ctx: Ctx, nodes: readonly PhrasingContent[]): string {
  const items: ProseItem[] = [];
  inline(ctx, nodes, "text", items);
  return normalise(items.map((item) => (item.kind === "char" ? item.char : "")).join(""));
}

function charItem(ctx: Ctx, char: string, start: number, end: number): ProseChar {
  const { line, column } = ctx.locate(start);
  return { kind: "char", char, line, column, start, end };
}

function barrier(ctx: Ctx, start: number, end: number): ProseBarrier {
  const { line, column } = ctx.locate(start);
  return { kind: "barrier", line, column, start, end };
}

function isLineEnd(c: string): boolean {
  return c === "\r" || c === "\n";
}

function isBlank(c: string): boolean {
  return c === " " || c === "\t";
}

/**
 * The end of a block quote marker at `i`, or undefined when there is none: up to three spaces of
 * indentation, `>`, and one optional space or tab. A tab is four columns, so it is never indentation.
 */
function quoteMarkerEnd(t: string, i: number, end: number): number | undefined {
  let k = i;
  while (k < end && k - i < 3 && t.charAt(k) === " ") {
    k++;
  }
  if (k >= end || t.charAt(k) !== ">") {
    return undefined;
  }
  k++;
  return k < end && isBlank(t.charAt(k)) ? k + 1 : k;
}

/**
 * Skips the container prefix and indentation of a line, which CommonMark strips: each enclosing
 * container's prefix in turn, from the content column of the one before it, then any leading white
 * space. A `>` past the containers' markers is paragraph text.
 */
function skipPrefix(t: string, i: number, end: number, containers: readonly Container[]): number {
  let k = i;
  for (const container of containers) {
    const next =
      container.kind === "quote"
        ? quoteMarkerEnd(t, k, end)
        : itemIndentEnd(t, i, k, end, container.indent);
    if (next === undefined) {
      break;
    }
    k = next;
  }
  while (k < end && isBlank(t.charAt(k))) {
    k++;
  }
  return k;
}

/**
 * The end of a list item's content indentation at `from`, or undefined when the line is indented by
 * less: `indent` columns of blanks, a tab advancing to the next tab stop of the line at `lineStart`.
 */
function itemIndentEnd(
  t: string,
  lineStart: number,
  from: number,
  end: number,
  indent: number,
): number | undefined {
  let k = from;
  let at = from - lineStart;
  while (at < indent) {
    const c = k < end ? t.charAt(k) : "";
    if (c === " ") {
      at++;
    } else if (c === "\t") {
      at += 4 - (at % 4);
    } else {
      return undefined;
    }
    k++;
  }
  return k;
}

/**
 * Where the re-scan of a text node starting at `s` begins. When only prefix characters precede `s`
 * on its line, the node starts a line and its line's prefix is skipped, unless the node starts later.
 */
function scanStart(ctx: Ctx, s: number, end: number): number {
  const t = ctx.masked;
  let lineStart = s;
  while (lineStart > 0 && !isLineEnd(t.charAt(lineStart - 1))) {
    lineStart--;
  }
  for (let k = lineStart; k < s; k++) {
    const c = t.charAt(k);
    if (!isBlank(c) && c !== ">") {
      return s;
    }
  }
  return Math.max(s, skipPrefix(t, lineStart, end, ctx.containers));
}

/** Re-scans the source of a text node in [s, e) into prose items. */
function rescan(ctx: Ctx, s: number, e: number, out: ProseItem[]): void {
  const t = ctx.masked;
  let i = scanStart(ctx, s, e);
  while (i < e) {
    const c = t.charAt(i);
    if (c === " " || c === "\t") {
      let j = i;
      while (j < e && (t.charAt(j) === " " || t.charAt(j) === "\t")) {
        j++;
      }
      // Spaces before a line ending are stripped; the others are content.
      if (j < e && isLineEnd(t.charAt(j))) {
        i = j;
        continue;
      }
      for (let k = i; k < j; k++) {
        out.push(charItem(ctx, t.charAt(k), k, k + 1));
      }
      i = j;
      continue;
    }
    if (isLineEnd(c)) {
      const len = c === "\r" && i + 1 < e && t.charAt(i + 1) === "\n" ? 2 : 1;
      out.push(charItem(ctx, " ", i, i + len));
      i = skipPrefix(t, i + len, e, ctx.containers);
      continue;
    }
    if (c === "\\" && i + 1 < e && ASCII_PUNCTUATION.test(t.charAt(i + 1))) {
      out.push(charItem(ctx, t.charAt(i + 1), i, i + 2));
      i += 2;
      continue;
    }
    if (c === "&") {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(t);
      if (m !== null && i + m[0].length <= e) {
        const raw = m[0];
        const decoded = decodeString(raw);
        if (decoded !== raw) {
          for (const ch of decoded) {
            out.push(charItem(ctx, ch, i, i + raw.length));
          }
          i += raw.length;
          continue;
        }
      }
    }
    const cp = t.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    const ch = String.fromCodePoint(cp);
    out.push(charItem(ctx, ch, i, i + ch.length));
    i += ch.length;
  }
}

function trimWhite(s: string): string {
  return s.replace(TRIM, "");
}

/** The text of a suppression comment's candidate, when `raw` is exactly one HTML comment. */
function commentText(raw: string): string | undefined {
  const t = trimWhite(raw);
  if (!t.startsWith("<!--") || !t.endsWith("-->") || t.indexOf("-->", 4) !== t.length - 3) {
    return undefined;
  }
  return trimWhite(t.slice(4, -3));
}

/** Classifies a comment text: undefined when it is not a suppression comment (Section 3.3). */
function suppressionOf(text: string): { valid: boolean; code?: "P001" | "P002" } | undefined {
  if (!TERMS_IGNORE.test(text)) {
    return undefined;
  }
  const code = SUPPRESSION.exec(text)?.[1];
  const oneLine = !/[\r\n]/u.test(text);
  if (code === "P001" || code === "P002") {
    return oneLine ? { valid: true, code } : { valid: false };
  }
  return { valid: false };
}

function inlineComment(ctx: Ctx, raw: string, start: number, comments: ProseSuppression[]): void {
  const text = commentText(raw);
  if (text === undefined) {
    return;
  }
  const verdict = suppressionOf(text);
  if (verdict === undefined) {
    return;
  }
  const { line, column } = ctx.locate(start);
  comments.push({ line, column, targetLine: line, ...verdict });
}

function blockComment(ctx: Ctx, node: Html, comments: ProseSuppression[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    return;
  }
  const text = commentText(node.value);
  if (text === undefined) {
    return;
  }
  const verdict = suppressionOf(text);
  if (verdict === undefined) {
    return;
  }
  const open = ctx.masked.indexOf("<", start);
  const { line, column } = ctx.locate(open);
  const target = nextNonblankLine(ctx.masked, ctx.locate(end).line, ctx.quoteEnds);
  comments.push({
    line,
    column,
    ...(target === undefined ? {} : { targetLine: target }),
    ...verdict,
  });
}
