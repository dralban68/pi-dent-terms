/**
 * The terms file (specs/terms.md): parsing of its bytes into a typed model with YAML node
 * positions (Sections 2.1–2.4, and the T001 part of 5.2), and the canonical writer (Section 2.5).
 */

import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parse,
  parseAllDocuments,
  type Document,
  type Node as YamlNode,
  type YAMLMap,
} from "yaml";
import { compareFindings, compareUtf16, normalise, quote, type Finding } from "./text.ts";

/** The workspace path of the terms file (Section 2.1). */
export const TERMS_PATH = ".pi/pi-dent/terms.yaml";

/** A line and a column, both counted from 1; the column in UTF-16 code units (Section 1.2). */
export interface Position {
  readonly line: number;
  readonly column: number;
}

export type Key = "shared" | "confusable" | "local";
export type Status = "active" | "deprecated";
export type Reason = "merged" | "split" | "renamed" | "out-of-scope";
export type Op = "add" | "update" | "import" | "rename" | "merge" | "split" | "deprecate" | "reown";

/** A history item (Section 2.4), one variant per operand set. */
export type HistoryItem =
  | { date: string; op: "add" }
  | { date: string; op: "update" }
  | { date: string; op: "update"; meaning: string }
  | { date: string; op: "update"; status: "deprecated" }
  | { date: string; op: "update"; meaning: string; status: "deprecated" }
  | { date: string; op: "import"; from: string }
  | { date: string; op: "rename"; from: string; to: string }
  | { date: string; op: "merge"; into: string }
  | { date: string; op: "merge"; from: string }
  | { date: string; op: "split"; into: string[] }
  | { date: string; op: "split"; from: string }
  | { date: string; op: "deprecate"; reason: Reason; replacedBy?: string[] }
  | { date: string; op: "deprecate"; from: string }
  | { date: string; op: "reown"; from: string; to: string };

/** The file-level settings (Section 2.2). */
export interface Settings {
  checkAfterEdit?: boolean;
}

/** An entry (Section 2.3). An absent list is an empty list. */
export interface Entry {
  id: string;
  label: string;
  meaning: string;
  owner: string;
  group: string;
  key: Key;
  status: Status;
  reject: string[];
  distinguish: string[];
  forms: string[];
  replacedBy: string[];
  reason?: Reason;
  history: HistoryItem[];
}

/** An entry that is not left out (Section 2.3), with its place in the `terms` sequence. */
export interface EntryRecord {
  readonly index: number;
  /** The value path of the entry, `terms[<index>]`. */
  readonly path: string;
  readonly entry: Entry;
}

/** A T001 finding; `valuePath` is its `<value path>` as Section 5.2 writes it. */
export interface T001Finding extends Finding {
  readonly valuePath: string;
}

/** The result of parsing the terms file bytes. */
export interface TermsFile {
  readonly settings: Settings;
  /** The entries that are not left out, in file order. */
  readonly entries: readonly EntryRecord[];
  /** Every string `id` of a mapping in `terms`, left-out entries included. */
  readonly existingIds: ReadonlySet<string>;
  /** The number of items of `terms`; 0 when `terms` is not a sequence. */
  readonly termsCount: number;
  /**
   * The string `id` of each item of `terms` by index, left-out entries included; undefined when the
   * item is not a mapping or has no string `id`.
   */
  readonly idsByIndex: readonly (string | undefined)[];
  /** The T001 findings, in finding order. */
  readonly t001: readonly T001Finding[];
  /**
   * The start of the YAML node of each value, keyed by its value path (`terms[0].label`); the
   * root value is keyed by the empty string.
   */
  readonly positions: ReadonlyMap<string, Position>;
}

/** The model the canonical writer takes: the file's settings and its entries in file order. */
export interface TermsModel {
  readonly settings: Settings;
  readonly entries: readonly Entry[];
}

const KEY_VALUES: readonly Key[] = ["shared", "confusable", "local"];
const STATUS_VALUES: readonly Status[] = ["active", "deprecated"];
/** The one value of the `status` operand of an `update` history item (Section 2.4). */
const OLD_STATUS_VALUES: readonly "deprecated"[] = ["deprecated"];
const REASON_VALUES: readonly Reason[] = ["merged", "split", "renamed", "out-of-scope"];
const OP_VALUES: readonly Op[] = [
  "add",
  "update",
  "import",
  "rename",
  "merge",
  "split",
  "deprecate",
  "reown",
];

const ROOT_KEYS = ["settings", "terms"];
const SETTINGS_KEYS = ["checkAfterEdit"];
const ENTRY_KEYS = [
  "id",
  "label",
  "meaning",
  "owner",
  "group",
  "key",
  "status",
  "reject",
  "distinguish",
  "forms",
  "replacedBy",
  "reason",
  "history",
];

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const LINE_BREAK_RE = /[\r\n]/;
const PLAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9 ._/-]*[A-Za-z0-9._/])?$/;

const MAP_TYPE = "a mapping";
const SEQ_TYPE = "a sequence";
const BOOL_TYPE = "true or false";
const STRING_TYPE = "a string";
const ID_TYPE = "an id matching ^[a-z0-9]+(-[a-z0-9]+)*$";
const PHRASE_TYPE = "a phrase (one trimmed line holding a letter, mark, or digit)";
const LINE_TYPE = "one non-empty line";
const PATH_TYPE = "a workspace path ending with .md";
const OWNER_PATH_TYPE = "an owner path ending with .md";
const DATE_TYPE = "a date YYYY-MM-DD";

type Check<T> = (value: unknown) => T | undefined;

function oneOfCheck<T extends string>(values: readonly T[]): Check<T> {
  return (value) => values.find((candidate) => candidate === value);
}

function oneOfType(values: readonly string[]): string {
  return `one of ${values.join(", ")}`;
}

function isLine(s: string): boolean {
  return !LINE_BREAK_RE.test(s) && /[^\p{White_Space}]/u.test(s);
}

function isPhrase(s: string): boolean {
  return (
    !LINE_BREAK_RE.test(s) &&
    !/^\p{White_Space}|\p{White_Space}$/u.test(s) &&
    /[\p{L}\p{M}\p{N}]/u.test(s)
  );
}

function isWorkspacePathMd(s: string): boolean {
  return (
    s.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    s.endsWith(".md")
  );
}

function isOwnerPathMd(s: string): boolean {
  const segments = s.split("/");
  let first = 0;
  while (segments[first] === "..") first++;
  return (
    first < segments.length &&
    segments
      .slice(first)
      .every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    s.endsWith(".md")
  );
}

function isCalendarDate(s: string): boolean {
  const match = DATE_RE.exec(s);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const asString: Check<string> = (value) => (typeof value === "string" ? value : undefined);
const asId: Check<string> = (value) =>
  typeof value === "string" && ID_RE.test(value) ? value : undefined;
const asLine: Check<string> = (value) =>
  typeof value === "string" && isLine(value) ? value : undefined;
const asPhrase: Check<string> = (value) =>
  typeof value === "string" && isPhrase(value) ? value : undefined;
const asPath: Check<string> = (value) =>
  typeof value === "string" && isWorkspacePathMd(value) ? value : undefined;
const asOwnerPath: Check<string> = (value) =>
  typeof value === "string" && isOwnerPathMd(value) ? value : undefined;
const asDate: Check<string> = (value) =>
  typeof value === "string" && isCalendarDate(value) ? value : undefined;
const asBool: Check<boolean> = (value) => (typeof value === "boolean" ? value : undefined);

/** Printable characters of [YAML 1.2.2], Section 5.1. */
function isPrintable(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0x7e) ||
    cp === 0x85 ||
    (cp >= 0xa0 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function escapeUnprintable(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isPrintable(cp) ? ch : `\\u${cp.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** Whether the escaped text holds `\"` and no other backslash (Section 2.5, rule 6). */
function onlyQuoteEscapes(escaped: string): boolean {
  const backslashes = escaped.split("\\").length - 1;
  const quotes = escaped.split('\\"').length - 1;
  return quotes > 0 && backslashes === quotes;
}

/** A string as the canonical form writes it (Section 2.5, rule 6). */
function scalar(s: string): string {
  if (PLAIN_RE.test(s) && typeof parse(s, { schema: "core" }) === "string") {
    return s;
  }
  const escaped = escapeUnprintable(JSON.stringify(s));
  return onlyQuoteEscapes(escaped) ? `'${s.split("'").join("''")}'` : escaped;
}

function listLines(out: string[], field: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  out.push(`    ${field}:`);
  for (const item of items) {
    out.push(`      - ${scalar(item)}`);
  }
}

/** A history item as a block mapping (Section 2.5, rule 5); no flow collection is written. */
function historyLines(item: HistoryItem): string[] {
  const out = [`      - date: ${scalar(item.date)}`, `        op: ${scalar(item.op)}`];
  const add = (name: string, value: string): void => {
    out.push(`        ${name}: ${value}`);
  };
  const list = (name: string, values: readonly string[]): void => {
    out.push(`        ${name}:`);
    for (const value of values) {
      out.push(`          - ${scalar(value)}`);
    }
  };
  switch (item.op) {
    case "add":
      break;
    case "update":
      if ("meaning" in item) {
        add("meaning", scalar(item.meaning));
      }
      if ("status" in item) {
        add("status", scalar(item.status));
      }
      break;
    case "import":
      add("from", scalar(item.from));
      break;
    case "rename":
      add("from", scalar(item.from));
      add("to", scalar(item.to));
      break;
    case "merge":
      if ("into" in item) {
        add("into", scalar(item.into));
      } else {
        add("from", scalar(item.from));
      }
      break;
    case "split":
      if ("into" in item) {
        list("into", item.into);
      } else {
        add("from", scalar(item.from));
      }
      break;
    case "deprecate":
      if ("reason" in item) {
        add("reason", scalar(item.reason));
        if (item.replacedBy !== undefined && item.replacedBy.length > 0) {
          list("replacedBy", item.replacedBy);
        }
      } else {
        add("from", scalar(item.from));
      }
      break;
    case "reown":
      add("from", scalar(item.from));
      add("to", scalar(item.to));
      break;
  }
  return out;
}

function entryLines(entry: Entry): string[] {
  const out = [
    `  - id: ${scalar(entry.id)}`,
    `    label: ${scalar(entry.label)}`,
    `    meaning: ${scalar(entry.meaning)}`,
    `    owner: ${scalar(entry.owner)}`,
    `    group: ${scalar(entry.group)}`,
    `    key: ${scalar(entry.key)}`,
    `    status: ${scalar(entry.status)}`,
  ];
  listLines(out, "reject", entry.reject);
  listLines(out, "distinguish", entry.distinguish);
  listLines(out, "forms", entry.forms);
  listLines(out, "replacedBy", entry.replacedBy);
  if (entry.reason !== undefined) {
    out.push(`    reason: ${scalar(entry.reason)}`);
  }
  out.push("    history:");
  for (const item of entry.history) {
    out.push(...historyLines(item));
  }
  return out;
}

/**
 * The canonical form of the terms file (Section 2.5): entries are written in the order given.
 */
export function writeTermsFile(model: TermsModel): string {
  const lines: string[] = [];
  if (model.settings.checkAfterEdit !== undefined) {
    lines.push(
      "settings:",
      `  checkAfterEdit: ${model.settings.checkAfterEdit ? "true" : "false"}`,
    );
  }
  if (model.entries.length === 0) {
    lines.push("terms: []");
  } else {
    lines.push("terms:");
    for (const entry of model.entries) {
      lines.push(...entryLines(entry));
    }
  }
  return lines.map((line) => `${line}\n`).join("");
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

interface Problem {
  /** The value path, `""` for the root, or `null` for `(file)`. */
  readonly path: string | null;
  readonly reason: string;
  /** Unknown-key problems do not leave their entry out (Section 2.3). */
  readonly unknownKeys: boolean;
  readonly pos: Position | undefined;
}

interface Ctx {
  readonly doc: Document;
  /** The parsed text, with line feeds only: the offsets of the nodes are offsets in it. */
  readonly src: string;
  readonly lc: LineCounter;
  readonly positions: Map<string, Position>;
  readonly problems: Problem[];
  readonly ids: Set<string>;
  lastId: string | undefined;
}

interface Field {
  readonly name: string;
  readonly value: unknown;
}

type Reader<T> = (ctx: Ctx, path: string, node: unknown) => T | undefined;

function fail(ctx: Ctx, path: string | null, reason: string, unknownKeys = false, pos?: Position) {
  ctx.problems.push({ path, reason, unknownKeys, pos });
}

function deref(ctx: Ctx, node: unknown): YamlNode | undefined {
  if (isAlias(node)) {
    return node.resolve(ctx.doc);
  }
  return isNode(node) ? node : undefined;
}

function isWhite(c: string): boolean {
  return /\s/u.test(c);
}

/** The offset of the first property (anchor or tag) before a node that starts at `start`. */
function propsStart(src: string, start: number): number {
  let s = start;
  for (;;) {
    let k = s;
    while (k > 0 && isWhite(src.charAt(k - 1))) {
      k--;
    }
    if (k === s) {
      return s;
    }
    let j = k;
    while (j > 0 && !isWhite(src.charAt(j - 1))) {
      j--;
    }
    const token = src.slice(j, k);
    if (!token.startsWith("&") && !token.startsWith("!")) {
      return s;
    }
    s = j;
  }
}

/**
 * The offset a value's finding is placed at (Section 5.2): an alias at its own `*`, a node with an
 * anchor or a tag at the start of its properties, and any other node at its start.
 */
function positionOffset(ctx: Ctx, node: unknown): number | undefined {
  if (isAlias(node)) {
    return node.range?.[0];
  }
  if (!isNode(node)) {
    return undefined;
  }
  const start = node.range?.[0];
  if (start === undefined) {
    return undefined;
  }
  return node.anchor === undefined && node.tag === undefined ? start : propsStart(ctx.src, start);
}

function recordPosition(ctx: Ctx, path: string, node: unknown): void {
  const at = positionOffset(ctx, node);
  if (at !== undefined) {
    const { line, col } = ctx.lc.linePos(at);
    ctx.positions.set(path, { line, column: col });
  }
}

function scalarValue(ctx: Ctx, node: unknown): unknown {
  const resolved = deref(ctx, node);
  return isScalar(resolved) ? resolved.value : undefined;
}

function keyName(key: unknown): string {
  return isScalar(key) ? String(key.value) : "(complex key)";
}

function fieldsOf(map: YAMLMap): Field[] {
  return map.items.map((pair) => ({ name: keyName(pair.key), value: pair.value }));
}

function checkUnknownKeys(
  ctx: Ctx,
  path: string,
  fields: readonly Field[],
  known: readonly string[],
) {
  const unknown = fields.map((field) => field.name).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    fail(ctx, path, `unknown keys ${unknown.map(quote).join(", ")}`, true);
  }
}

function scalarReader<T>(check: Check<T>, type: string): Reader<T> {
  return (ctx, path, node) => {
    recordPosition(ctx, path, node);
    const value = check(scalarValue(ctx, node));
    if (value === undefined) {
      fail(ctx, path, `must be ${type}`);
    }
    return value;
  };
}

function listReader<T extends string>(check: Check<T>, type: string, unique: boolean): Reader<T[]> {
  return (ctx, path, node) => {
    recordPosition(ctx, path, node);
    const seq = deref(ctx, node);
    if (!isSeq(seq)) {
      fail(ctx, path, `must be ${SEQ_TYPE}`);
      return;
    }
    const out: T[] = [];
    let valid = true;
    for (const [i, item] of seq.items.entries()) {
      const itemPath = `${path}[${i}]`;
      recordPosition(ctx, itemPath, item);
      const value = check(scalarValue(ctx, item));
      if (value === undefined) {
        fail(ctx, itemPath, `must be ${type}`);
        valid = false;
      } else if (unique && out.some((previous) => normalise(previous) === normalise(value))) {
        fail(ctx, itemPath, `repeats ${quote(value)}`);
        valid = false;
      } else {
        out.push(value);
      }
    }
    return valid ? out : undefined;
  };
}

function requiredField<T>(
  ctx: Ctx,
  path: string,
  fields: readonly Field[],
  name: string,
  read: Reader<T>,
): T | undefined {
  const field = fields.find((candidate) => candidate.name === name);
  if (field === undefined) {
    fail(ctx, path, `missing ${name}`);
    return;
  }
  return read(ctx, `${path}.${name}`, field.value);
}

function isUnder(path: string, entryPath: string): boolean {
  return path === entryPath || path.startsWith(`${entryPath}.`) || path.startsWith(`${entryPath}[`);
}

/** True when a T001 finding that is not for unknown keys is at or under the entry (Section 2.3). */
function isLeftOut(ctx: Ctx, entryPath: string): boolean {
  return ctx.problems.some(
    (problem) => !problem.unknownKeys && problem.path !== null && isUnder(problem.path, entryPath),
  );
}

/** The `update` history item with the operands it holds (Section 2.4). */
function updateHistoryItem(
  date: string,
  meaning: string | undefined,
  status: "deprecated" | undefined,
): HistoryItem {
  if (meaning === undefined) {
    return status === undefined ? { date, op: "update" } : { date, op: "update", status };
  }
  return status === undefined
    ? { date, op: "update", meaning }
    : { date, op: "update", meaning, status };
}

function readHistoryItem(ctx: Ctx, path: string, node: unknown): HistoryItem | undefined {
  recordPosition(ctx, path, node);
  const map = deref(ctx, node);
  if (!isMap(map)) {
    fail(ctx, path, `must be ${MAP_TYPE}`);
    return;
  }
  const fields = fieldsOf(map);
  const used = ["date", "op"];
  const date = requiredField(ctx, path, fields, "date", scalarReader(asDate, DATE_TYPE));
  const op = requiredField(
    ctx,
    path,
    fields,
    "op",
    scalarReader(oneOfCheck(OP_VALUES), oneOfType(OP_VALUES)),
  );
  if (op === undefined) {
    return;
  }
  const operand = <T>(name: string, read: Reader<T>): T | undefined => {
    used.push(name);
    return requiredField(ctx, path, fields, name, read);
  };
  const has = (name: string): boolean => fields.some((field) => field.name === name);
  const idOrString = scalarReader(asString, STRING_TYPE);
  const pathOperand = scalarReader(asPath, PATH_TYPE);
  const phraseOperand = scalarReader(asPhrase, PHRASE_TYPE);

  let item: HistoryItem | undefined;
  switch (op) {
    case "add":
      item = date === undefined ? undefined : { date, op: "add" };
      break;
    case "update": {
      const meaning = has("meaning")
        ? operand("meaning", scalarReader(asString, STRING_TYPE))
        : undefined;
      const status = has("status")
        ? operand(
            "status",
            scalarReader(oneOfCheck(OLD_STATUS_VALUES), oneOfType(OLD_STATUS_VALUES)),
          )
        : undefined;
      const present =
        (!has("meaning") || meaning !== undefined) && (!has("status") || status !== undefined);
      if (date !== undefined && present) item = updateHistoryItem(date, meaning, status);
      break;
    }
    case "import": {
      const from = operand("from", pathOperand);
      item = date === undefined || from === undefined ? undefined : { date, op: "import", from };
      break;
    }
    case "rename": {
      const from = operand("from", phraseOperand);
      const to = operand("to", phraseOperand);
      item =
        date === undefined || from === undefined || to === undefined
          ? undefined
          : { date, op: "rename", from, to };
      break;
    }
    case "merge": {
      if (has("into")) {
        const into = operand("into", idOrString);
        item = date === undefined || into === undefined ? undefined : { date, op: "merge", into };
      } else {
        const from = operand("from", idOrString);
        item = date === undefined || from === undefined ? undefined : { date, op: "merge", from };
      }
      break;
    }
    case "split": {
      if (has("into")) {
        const into = operand("into", listReader(asString, STRING_TYPE, false));
        item = date === undefined || into === undefined ? undefined : { date, op: "split", into };
      } else {
        const from = operand("from", idOrString);
        item = date === undefined || from === undefined ? undefined : { date, op: "split", from };
      }
      break;
    }
    case "deprecate": {
      if (has("reason")) {
        const reason = operand(
          "reason",
          scalarReader(oneOfCheck(REASON_VALUES), oneOfType(REASON_VALUES)),
        );
        let replacedBy: string[] | undefined;
        if (has("replacedBy")) {
          replacedBy = operand("replacedBy", listReader(asString, STRING_TYPE, false));
        }
        const replacedByValid = !has("replacedBy") || replacedBy !== undefined;
        item =
          date === undefined || reason === undefined || !replacedByValid
            ? undefined
            : replacedBy === undefined
              ? { date, op: "deprecate", reason }
              : { date, op: "deprecate", reason, replacedBy };
      } else {
        const from = operand("from", idOrString);
        item =
          date === undefined || from === undefined ? undefined : { date, op: "deprecate", from };
      }
      break;
    }
    case "reown": {
      const ownerOperand = scalarReader(asOwnerPath, OWNER_PATH_TYPE);
      const from = operand("from", ownerOperand);
      const to = operand("to", ownerOperand);
      item =
        date === undefined || from === undefined || to === undefined
          ? undefined
          : { date, op: "reown", from, to };
      break;
    }
  }
  checkUnknownKeys(ctx, path, fields, used);
  return item;
}

function readHistory(ctx: Ctx, path: string, node: unknown): HistoryItem[] | undefined {
  recordPosition(ctx, path, node);
  const seq = deref(ctx, node);
  if (!isSeq(seq)) {
    fail(ctx, path, `must be ${SEQ_TYPE}`);
    return;
  }
  if (seq.items.length === 0) {
    fail(ctx, path, "must hold at least one item");
    return;
  }
  const out: HistoryItem[] = [];
  let valid = true;
  for (const [i, item] of seq.items.entries()) {
    const read = readHistoryItem(ctx, `${path}[${i}]`, item);
    if (read === undefined) {
      valid = false;
    } else {
      out.push(read);
    }
  }
  return valid ? out : undefined;
}

/** Reads one entry mapping at `path`; returns it, or undefined when it is left out. */
function readEntry(ctx: Ctx, path: string, map: YAMLMap): Entry | undefined {
  const fields = fieldsOf(map);
  checkUnknownKeys(ctx, path, fields, ENTRY_KEYS);
  const field = (name: string): Field | undefined =>
    fields.find((candidate) => candidate.name === name);
  const required = <T>(name: string, read: Reader<T>): T | undefined =>
    requiredField(ctx, path, fields, name, read);
  const optionalList = <T extends string>(name: string, read: Reader<T[]>): T[] | undefined => {
    const found = field(name);
    return found === undefined ? [] : read(ctx, `${path}.${name}`, found.value);
  };

  let id: string | undefined;
  const idField = field("id");
  if (idField === undefined) {
    fail(ctx, path, "missing id");
  } else {
    recordPosition(ctx, `${path}.id`, idField.value);
    const value = scalarValue(ctx, idField.value);
    if (typeof value === "string") {
      ctx.ids.add(value);
      if (ctx.lastId !== undefined && compareUtf16(value, ctx.lastId) <= 0) {
        fail(ctx, `${path}.id`, `must come after ${ctx.lastId}`);
      }
      ctx.lastId = value;
    }
    id = scalarReader(asId, ID_TYPE)(ctx, `${path}.id`, idField.value);
  }

  const label = required("label", scalarReader(asPhrase, PHRASE_TYPE));
  const meaning = required("meaning", scalarReader(asLine, LINE_TYPE));
  const owner = required("owner", scalarReader(asOwnerPath, OWNER_PATH_TYPE));
  const group = required("group", scalarReader(asLine, LINE_TYPE));
  const key = required("key", scalarReader(oneOfCheck(KEY_VALUES), oneOfType(KEY_VALUES)));
  const status = required(
    "status",
    scalarReader(oneOfCheck(STATUS_VALUES), oneOfType(STATUS_VALUES)),
  );
  const reject = optionalList("reject", listReader(asPhrase, PHRASE_TYPE, true));
  const distinguish = optionalList("distinguish", listReader(asId, ID_TYPE, true));
  const forms = optionalList("forms", listReader(asPhrase, PHRASE_TYPE, true));
  const replacedBy = optionalList("replacedBy", listReader(asId, ID_TYPE, true));
  const reasonField = field("reason");
  const reason =
    reasonField === undefined
      ? undefined
      : scalarReader(oneOfCheck(REASON_VALUES), oneOfType(REASON_VALUES))(
          ctx,
          `${path}.reason`,
          reasonField.value,
        );
  const historyField = field("history");
  if (historyField === undefined) {
    fail(ctx, path, "missing history");
  }
  const history =
    historyField === undefined
      ? undefined
      : readHistory(ctx, `${path}.history`, historyField.value);

  if (isLeftOut(ctx, path)) {
    return;
  }
  if (
    id === undefined ||
    label === undefined ||
    meaning === undefined ||
    owner === undefined ||
    group === undefined ||
    key === undefined ||
    status === undefined ||
    reject === undefined ||
    distinguish === undefined ||
    forms === undefined ||
    replacedBy === undefined ||
    history === undefined ||
    (reasonField !== undefined && reason === undefined)
  ) {
    return;
  }
  return {
    id,
    label,
    meaning,
    owner,
    group,
    key,
    status,
    reject,
    distinguish,
    forms,
    replacedBy,
    ...(reason === undefined ? {} : { reason }),
    history,
  };
}

/** The string `id` of an entry mapping, or undefined when it has none (Section 2.3). */
function stringIdOf(ctx: Ctx, map: YAMLMap): string | undefined {
  const idField = fieldsOf(map).find((field) => field.name === "id");
  const value = idField === undefined ? undefined : scalarValue(ctx, idField.value);
  return typeof value === "string" ? value : undefined;
}

function readSettings(ctx: Ctx, fields: readonly Field[]): Settings {
  const found = fields.find((field) => field.name === "settings");
  if (found === undefined) {
    return {};
  }
  recordPosition(ctx, "settings", found.value);
  const map = deref(ctx, found.value);
  if (!isMap(map)) {
    fail(ctx, "settings", `must be ${MAP_TYPE}`);
    return {};
  }
  const settingsFields = fieldsOf(map);
  checkUnknownKeys(ctx, "settings", settingsFields, SETTINGS_KEYS);
  const checkAfterEdit = settingsFields.find((field) => field.name === "checkAfterEdit");
  if (checkAfterEdit === undefined) {
    return {};
  }
  const value = scalarReader(asBool, BOOL_TYPE)(
    ctx,
    "settings.checkAfterEdit",
    checkAfterEdit.value,
  );
  return value === undefined ? {} : { checkAfterEdit: value };
}

function toFinding(positions: ReadonlyMap<string, Position>, problem: Problem): T001Finding {
  const valuePath =
    problem.path === null ? "(file)" : problem.path === "" ? "(root)" : problem.path;
  const pos = problem.pos ??
    (problem.path === null ? undefined : positions.get(problem.path)) ?? { line: 1, column: 1 };
  return {
    path: TERMS_PATH,
    line: pos.line,
    column: pos.column,
    code: "T001",
    message: `${valuePath}: ${problem.reason}`,
    valuePath,
  };
}

function finish(
  ctx: Ctx,
  settings: Settings,
  entries: EntryRecord[],
  termsCount: number,
  idsByIndex: readonly (string | undefined)[],
): TermsFile {
  return {
    settings,
    entries,
    existingIds: ctx.ids,
    termsCount,
    idsByIndex,
    t001: ctx.problems
      .map((problem) => toFinding(ctx.positions, problem))
      .toSorted(compareFindings),
    positions: ctx.positions,
  };
}

/** The result of a failure that leaves no settings and no entries (Section 2.1). */
function fileFailure(reason: string, pos?: Position): TermsFile {
  const problem: Problem = { path: null, reason, unknownKeys: false, pos };
  return {
    settings: {},
    entries: [],
    existingIds: new Set(),
    termsCount: 0,
    idsByIndex: [],
    t001: [toFinding(new Map(), problem)],
    positions: new Map(),
  };
}

/** The parser's message without its position and code snippet. */
function parserMessage(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, "").trim();
}

/**
 * Parses the terms file bytes (specs/terms.md, Sections 2.1–2.4 and the T001 part of 5.2).
 */
export function parseTermsFile(bytes: Uint8Array): TermsFile {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fileFailure("not valid UTF-8");
  }
  const lc = new LineCounter();
  // Line breaks are normalised to line feeds: the same lines and columns, and the parser
  // (yaml) takes only line feeds as breaks.
  const src = text.replace(/\r\n?/g, "\n");
  const docs = parseAllDocuments(src, {
    schema: "core",
    uniqueKeys: true,
    lineCounter: lc,
  });
  const [doc, ...rest] = docs;
  if (doc === undefined || rest.length > 0) {
    return fileFailure(`holds ${docs.length} YAML documents`);
  }
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    if (firstError.code === "DUPLICATE_KEY") {
      return fileFailure("duplicate key");
    }
    const at = firstError.linePos?.[0];
    return fileFailure(
      parserMessage(firstError.message),
      at === undefined ? undefined : { line: at.line, column: at.col },
    );
  }

  const ctx: Ctx = {
    doc,
    src,
    lc,
    positions: new Map(),
    problems: [],
    ids: new Set(),
    lastId: undefined,
  };
  recordPosition(ctx, "", doc.contents);
  const root = deref(ctx, doc.contents);
  if (!isMap(root)) {
    fail(ctx, "", `must be ${MAP_TYPE}`);
    return finish(ctx, {}, [], 0, []);
  }
  const fields = fieldsOf(root);
  checkUnknownKeys(ctx, "", fields, ROOT_KEYS);
  const settings = readSettings(ctx, fields);

  const entries: EntryRecord[] = [];
  const idsByIndex: (string | undefined)[] = [];
  let termsCount = 0;
  const termsField = fields.find((field) => field.name === "terms");
  if (termsField === undefined) {
    fail(ctx, "", "missing terms");
  } else {
    recordPosition(ctx, "terms", termsField.value);
    const seq = deref(ctx, termsField.value);
    if (isSeq(seq)) {
      termsCount = seq.items.length;
      for (const [index, item] of seq.items.entries()) {
        const path = `terms[${index}]`;
        recordPosition(ctx, path, item);
        const map = deref(ctx, item);
        idsByIndex.push(isMap(map) ? stringIdOf(ctx, map) : undefined);
        if (!isMap(map)) {
          fail(ctx, path, `must be ${MAP_TYPE}`);
          continue;
        }
        const entry = readEntry(ctx, path, map);
        if (entry !== undefined) {
          entries.push({ index, path, entry });
        }
      }
    } else {
      fail(ctx, "terms", `must be ${SEQ_TYPE}`);
    }
  }
  return finish(ctx, settings, entries, termsCount, idsByIndex);
}
