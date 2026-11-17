/**
 * Import of thesaurus tables into entries (specs/terms.md, Section 6.8): row problems, ids,
 * owners, groups, distinguish ids, and reject candidates.
 */

import { analyseDocument, isExternalOwner } from "./checks.ts";
import { variantsOf } from "./match.ts";
import { parseProse, type ProseCell, type ProseRow } from "./prose.ts";
import type { Entry } from "./terms-file.ts";
import { compareUtf16, normalise } from "./text.ts";

/** An item of an Avoid or distinguish cell that gives no `distinguish` id, with its entry id. */
export interface RejectCandidate {
  readonly id: string;
  readonly item: string;
}

/** The result of reading a document's thesaurus table: a refusal, or the entries and candidates. */
export type ThesaurusImport =
  | { readonly refusal: string }
  | { readonly entries: readonly Entry[]; readonly candidates: readonly RejectCandidate[] };

/** One body row of a thesaurus table, after its problems were ruled out. */
interface Row {
  readonly id: string;
  readonly term: string;
  readonly meaning: string;
  readonly owner: string;
  readonly group: string;
  readonly items: readonly string[];
}

/**
 * Reads the thesaurus tables of one document (`text`, the document at `path`) into active entries
 * dated `date` (Section 6.8, refusals 3 and 4 of the table rows). The caller has checked the
 * terms file and that `path` is a document.
 */
export function readThesaurus(
  path: string,
  text: string,
  date: string,
  documents: ReadonlyMap<string, string>,
): ThesaurusImport {
  const doc = parseProse(text);
  const tables = doc.tables.filter((table) => table.thesaurus);
  if (tables.length === 0) {
    return { refusal: `${path} has no thesaurus table` };
  }
  const sources = tables
    .flatMap((table) => {
      const group = doc.headings.filter((heading) => heading.line < table.line).at(-1)?.text;
      return table.body.map((row) => ({ row, group }));
    })
    .toSorted((a, b) => a.row.line - b.row.line);

  const used = new Set<string>();
  const rows: Row[] = [];
  for (const { row, group } of sources) {
    const at = `${path}:${row.line}`;
    const term = cellText(row, 0);
    if (term === "") {
      return { refusal: `${at}: the Term cell is empty` };
    }
    const base = baseId(term);
    if (base === "") {
      return { refusal: `${at}: the label gives no id` };
    }
    if (group === undefined) {
      return { refusal: `${at}: no heading precedes the table` };
    }
    const owner = ownerOf(path, row.cells[2]);
    if (owner === undefined) {
      return { refusal: `${at}: the Owner cell gives no owner path` };
    }
    const id = freshId(base, used);
    used.add(id);
    rows.push({
      id,
      term,
      meaning: cellText(row, 1),
      owner,
      group,
      items: itemsOf(cellText(row, 3)),
    });
  }

  const entries = rows
    .map((row): Entry => ({
      id: row.id,
      label: row.term,
      meaning: row.meaning,
      owner: row.owner,
      group: row.group,
      key: "shared",
      status: "active",
      reject: [],
      distinguish: distinguishOf(row, rows),
      forms: [],
      replacedBy: [],
      history: [{ date, op: "import", from: path }],
    }))
    .toSorted((a, b) => compareUtf16(a.id, b.id));
  const candidates = rows.flatMap((row) =>
    row.items
      .filter((item) => !labelOfOther(row, rows, item))
      .map((item): RejectCandidate => ({ id: row.id, item })),
  );
  return { entries: deriveKeys(entries, documents), candidates };
}

/** Derives keys from uses in the complete proposed matching (Section 6.8). */
function deriveKeys(entries: readonly Entry[], documents: ReadonlyMap<string, string>): Entry[] {
  const variants = variantsOf(entries);
  const users = new Map<string, Set<string>>();
  for (const [path, text] of documents) {
    for (const id of analyseDocument(path, text, variants).usedIds) {
      const paths = users.get(id) ?? new Set<string>();
      paths.add(path);
      users.set(id, paths);
    }
  }
  return entries.map((entry): Entry => {
    const paths = users.get(entry.id);
    const local =
      !isExternalOwner(entry.owner) &&
      documents.has(entry.owner) &&
      paths?.size === 1 &&
      paths.has(entry.owner);
    return { ...entry, key: local ? "local" : "shared" };
  });
}

/** The cell text of a column, normalised; a missing cell is empty (Section 6.8). */
function cellText(row: ProseRow, column: number): string {
  return normalise(row.cells[column]?.text ?? "");
}

/** The label in lower case with each maximal run of other characters as `-`, trimmed of `-`. */
function baseId(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The base id, or the base id with the smallest `-<n>` from 2 that is not yet used. */
function freshId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) {
    n++;
  }
  return `${base}-${n}`;
}

/** The parts of the Avoid or distinguish cell text split at `;`, normalised, empty parts left out. */
function itemsOf(text: string): string[] {
  return text
    .split(";")
    .map((part) => normalise(part))
    .filter((part) => part !== "");
}

/** Whether another row's label equals the item. */
function labelOfOther(row: Row, rows: readonly Row[], item: string): boolean {
  return rows.some((other) => other !== row && other.term === item);
}

/** The ids of the other rows whose label equals an item of the row, without repeats (Section 6.8). */
function distinguishOf(row: Row, rows: readonly Row[]): string[] {
  const out: string[] = [];
  for (const item of row.items) {
    for (const other of rows) {
      if (other !== row && other.term === item && !out.includes(other.id)) {
        out.push(other.id);
      }
    }
  }
  return out;
}

/** The directory of a workspace path, empty for the workspace root. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The owner path of a row (Section 6.8), or undefined when the Owner cell gives no owner path.
 */
function ownerOf(path: string, cell: ProseCell | undefined): string | undefined {
  const link = cell?.links[0];
  const raw = link ?? normalise(cell?.text ?? "");
  const hash = raw.indexOf("#");
  const text = hash < 0 ? raw : raw.slice(0, hash);
  if (text === "" || text.startsWith("/")) {
    return;
  }
  const slash = text.indexOf("/");
  const head = slash < 0 ? text : text.slice(0, slash);
  if (head.includes(":")) {
    return;
  }
  const dir = directoryOf(path);
  const joined = dir === "" ? text : `${dir}/${text}`;
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push("..");
      }
    } else {
      segments.push(segment);
    }
  }
  const owner = segments.join("/");
  let leadingParents = 0;
  while (segments[leadingParents] === "..") leadingParents++;
  if (
    segments
      .slice(leadingParents)
      .some((segment) => segment === "" || segment === "." || segment === "..") ||
    !owner.endsWith(".md")
  ) {
    return;
  }
  return owner;
}
