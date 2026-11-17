/**
 * Checks of the workspace (specs/terms.md, Section 5): the ordering and suppression of findings
 * (5.1), the file checks T002–T006 (5.2), and the prose checks P001, P002, and S001 (5.3).
 *
 * Each document is parsed and matched once, into a DocumentAnalysis that the file checks T005 and
 * T006 and the prose checks share. The functions are pure: the inputs are the terms file's bytes
 * and the documents' texts, each text decoded as UTF-8 without a leading U+FEFF.
 */

import {
  findOccurrences,
  usedEntryIds,
  variantsOf,
  type Occurrence,
  type Variant,
} from "./match.ts";
import { parseProse, type ProseDocument } from "./prose.ts";
import {
  TERMS_PATH,
  parseTermsFile,
  type EntryRecord,
  type Position,
  type TermsFile,
} from "./terms-file.ts";
import { compareFindings, compareUtf16, normalise, quote, type Finding } from "./text.ts";

export type FileCode = "T001" | "T002" | "T003" | "T004" | "T005" | "T006";
export type ProseCode = "P001" | "P002" | "S001";

/**
 * A file check finding (Section 5.2). `concerns` holds the ids of the entries it concerns, in
 * ascending order: the entry its value path is or lies under, left in or not (T001), or the entry
 * `<id>` and the entries its message names (the other codes). A T001 finding concerns no entry when
 * its item has no string `id`.
 */
export interface FileFinding extends Finding {
  readonly code: FileCode;
  readonly concerns: readonly string[];
}

/** A prose check finding (Section 5.3). */
export interface ProseFinding extends Finding {
  readonly code: ProseCode;
}

export type CheckFinding = FileFinding | ProseFinding;

/** A document parsed and matched once (Sections 3 and 4). */
export interface DocumentAnalysis {
  readonly path: string;
  readonly prose: ProseDocument;
  readonly occurrences: readonly Occurrence[];
  /** The ids of the active entries the document uses (Section 4.3), code-span uses included. */
  readonly usedIds: ReadonlySet<string>;
}

/** The terms file and the analysed documents of a workspace. */
export interface Workspace {
  readonly terms: TermsFile;
  /** The variants of the entries that are not left out (Section 4.1). */
  readonly variants: readonly Variant[];
  /** The entries that are not left out, by id. */
  readonly entries: ReadonlyMap<string, EntryRecord>;
  /** The analysed documents, by workspace path. */
  readonly documents: ReadonlyMap<string, DocumentAnalysis>;
  /** The ids used by each supplied external owner text, by owner path (Section 4.3). */
  readonly externals: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The check of a workspace (Section 5.1), with the counts the `check` action reports. */
export interface WorkspaceCheck {
  readonly findings: readonly CheckFinding[];
  readonly documentCount: number;
  readonly termsCount: number;
}

/** An owner path with leading `../` is external (Section 1.2); every other owner is internal. */
export function isExternalOwner(owner: string): boolean {
  return owner.startsWith("../");
}

/**
 * The ids of the active entries whose normalised label or form, or its capitalised variant, is
 * the normalised whole content of a code span (Section 4.3), by that text.
 */
function codeSpanIndex(variants: readonly Variant[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const variant of variants) {
    if (variant.plural || (variant.kind !== "label" && variant.kind !== "form")) {
      continue;
    }
    const ids = index.get(variant.text) ?? new Set<string>();
    ids.add(variant.entry.id);
    index.set(variant.text, ids);
  }
  return index;
}

/** Parses and matches one document against the variants of a workspace. */
export function analyseDocument(
  path: string,
  text: string,
  variants: readonly Variant[],
): DocumentAnalysis {
  return analyseText(path, text, variants, codeSpanIndex(variants));
}

/** Parses and matches one text against the variants and code-span index of a workspace. */
function analyseText(
  path: string,
  text: string,
  variants: readonly Variant[],
  index: ReadonlyMap<string, ReadonlySet<string>>,
): DocumentAnalysis {
  const prose = parseProse(text);
  const occurrences = findOccurrences(text, prose.runs, variants);
  const usedIds = new Set(usedEntryIds(occurrences));
  for (const span of prose.codeSpans) {
    for (const id of index.get(normalise(span)) ?? []) {
      usedIds.add(id);
    }
  }
  return { path, prose, occurrences, usedIds };
}

/**
 * Analyses the workspace: its variants, each document analysed once, and the uses of each
 * external owner text (`externalOwners`, keyed by owner path; not documents).
 */
export function analyseWorkspace(
  terms: TermsFile,
  documents: ReadonlyMap<string, string>,
  externalOwners: ReadonlyMap<string, string> = new Map(),
): Workspace {
  const variants = variantsOf(terms.entries.map((record) => record.entry));
  const index = codeSpanIndex(variants);
  const entries = new Map<string, EntryRecord>(
    terms.entries.map((record) => [record.entry.id, record]),
  );
  const analysed = new Map<string, DocumentAnalysis>();
  for (const [path, text] of documents) {
    analysed.set(path, analyseText(path, text, variants, index));
  }
  const externals = new Map<string, ReadonlySet<string>>();
  for (const [owner, text] of externalOwners) {
    externals.set(owner, analyseText(owner, text, variants, index).usedIds);
  }
  return { terms, variants, entries, documents: analysed, externals };
}

/** The file checks of the workspace (Section 5.2), in finding order. */
export function fileFindings(ws: Workspace): FileFinding[] {
  return [
    ...t001Findings(ws),
    ...checkT002(ws),
    ...checkT003(ws),
    ...checkT004(ws),
    ...checkT005AndT006(ws),
  ].toSorted(compareFindings);
}

/** The file checks of a terms file and its documents (Section 5.2), in finding order. */
export function fileChecks(
  terms: TermsFile,
  documents: ReadonlyMap<string, string>,
  externalOwners?: ReadonlyMap<string, string>,
): FileFinding[] {
  return fileFindings(analyseWorkspace(terms, documents, externalOwners));
}

/**
 * Whether a valid suppression comment suppresses the occurrence (Section 3.3): its code is the
 * code of the occurrence's kind, its target line is the line the occurrence starts on.
 */
export function isSuppressed(doc: DocumentAnalysis, occurrence: Occurrence): boolean {
  const code = suppressionCodeOf(occurrence);
  return (
    code !== undefined &&
    doc.prose.suppressions.some(
      (suppression) =>
        suppression.valid &&
        suppression.code === code &&
        suppression.targetLine === occurrence.line,
    )
  );
}

/** The prose checks of one analysed document (Section 5.3), suppressions applied, in order. */
export function proseFindings(ws: Workspace, doc: DocumentAnalysis): ProseFinding[] {
  const out: ProseFinding[] = [];
  for (const occurrence of doc.occurrences) {
    if (isSuppressed(doc, occurrence)) {
      continue;
    }
    const { entry } = occurrence.variant;
    if (occurrence.variant.kind === "reject") {
      out.push({
        path: doc.path,
        line: occurrence.line,
        column: occurrence.column,
        code: "P001",
        message: `${quote(occurrence.spelled)} is rejected: use ${quote(entry.label)} (${entry.id})`,
      });
    } else if (occurrence.variant.kind === "deprecated") {
      const reason = entry.reason ?? "none";
      out.push({
        path: doc.path,
        line: occurrence.line,
        column: occurrence.column,
        code: "P002",
        message: `${quote(occurrence.spelled)} is deprecated (${reason})${replacementText(ws, entry.replacedBy ?? [])}`,
      });
    }
  }
  for (const suppression of doc.prose.suppressions) {
    if (!suppression.valid) {
      out.push({
        path: doc.path,
        line: suppression.line,
        column: suppression.column,
        code: "S001",
        message: "terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line",
      });
    }
  }
  return out.toSorted(compareFindings);
}

/** The prose checks of one document (Section 5.3), with valid suppressions applied. */
export function proseChecks(path: string, text: string, terms: TermsFile): ProseFinding[] {
  const ws = analyseWorkspace(terms, new Map([[path, text]]));
  return [...ws.documents.values()].flatMap((doc) => proseFindings(ws, doc));
}

/**
 * The check of a workspace (Section 5.1): the file checks and the prose checks of every document,
 * ordered, with the findings that valid suppressions suppress left out.
 */
export function checkWorkspace(
  termsBytes: Uint8Array,
  documents: ReadonlyMap<string, string>,
  externalOwners?: ReadonlyMap<string, string>,
): WorkspaceCheck {
  const ws = analyseWorkspace(parseTermsFile(termsBytes), documents, externalOwners);
  const findings: CheckFinding[] = [...fileFindings(ws)];
  for (const doc of ws.documents.values()) {
    findings.push(...proseFindings(ws, doc));
  }
  return {
    findings: findings.toSorted(compareFindings),
    documentCount: documents.size,
    termsCount: ws.terms.termsCount,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function suppressionCodeOf(occurrence: Occurrence): "P001" | "P002" | undefined {
  switch (occurrence.variant.kind) {
    case "reject":
      return "P001";
    case "deprecated":
      return "P002";
    default:
      return undefined;
  }
}

/** The recorded position of a value path; a path with none is an internal bug. */
function positionOf(ws: Workspace, path: string): Position {
  const at = ws.terms.positions.get(path);
  if (at === undefined) {
    throw new Error(`internal: no recorded position for ${path}`);
  }
  return at;
}

function fileFinding(
  ws: Workspace,
  path: string,
  code: FileCode,
  message: string,
  concerns: readonly string[],
): FileFinding {
  const at = positionOf(ws, path);
  return {
    path: TERMS_PATH,
    line: at.line,
    column: at.column,
    code,
    message,
    concerns: [...new Set(concerns)].toSorted(compareUtf16),
  };
}

/** The ids that name an entry left in (Section 2.3); other ids are left out. */
function existingOnly(ws: Workspace, ids: readonly string[]): string[] {
  return ids.filter((id) => ws.entries.has(id));
}

function replacementText(ws: Workspace, ids: readonly string[]): string {
  if (ids.length === 0) {
    return "";
  }
  const parts = ids.map((id) => {
    const record = ws.entries.get(id);
    return record === undefined ? id : `${quote(record.entry.label)} (${id})`;
  });
  return `: use ${parts.join(" or ")}`;
}

interface Phrase {
  readonly text: string;
  /** The value path of the label or of the forms item. */
  readonly path: string;
}

/** The label and the forms phrases of a record, normalised (Section 4.1). */
function phrasesOf(record: EntryRecord): Phrase[] {
  const { entry } = record;
  return [
    { text: normalise(entry.label), path: `${record.path}.label` },
    ...entry.forms.map((form, k) => ({
      text: normalise(form),
      path: `${record.path}.forms[${k}]`,
    })),
  ];
}

/**
 * The T001 findings of the terms file, each with the entry it concerns (Section 5.2): the entry
 * of the `terms[<i>]` prefix of its value path, by the id that item has.
 */
function t001Findings(ws: Workspace): FileFinding[] {
  return ws.terms.t001.map((finding): FileFinding => {
    const index = /^terms\[(\d+)\](?:\.|\[|$)/u.exec(finding.valuePath)?.[1];
    const id = index === undefined ? undefined : ws.terms.idsByIndex[Number(index)];
    return {
      path: finding.path,
      line: finding.line,
      column: finding.column,
      code: "T001",
      message: finding.message,
      concerns: id === undefined ? [] : [id],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// File checks (Section 5.2)

/** T002: a label or form equal to a label, form, or reject phrase of another entry. */
function checkT002(ws: Workspace): FileFinding[] {
  const out: FileFinding[] = [];
  const records = ws.terms.entries;
  for (const record of records) {
    const { entry } = record;
    if (entry.status !== "active") {
      continue;
    }
    for (const phrase of phrasesOf(record)) {
      for (const other of records) {
        const o = other.entry;
        if (o.id === entry.id) {
          continue;
        }
        const earlierActive = o.status === "active" && compareUtf16(o.id, entry.id) < 0;
        if (o.status !== "deprecated" && !earlierActive) {
          continue;
        }
        if (phrasesOf(other).some((candidate) => candidate.text === phrase.text)) {
          out.push(
            fileFinding(
              ws,
              phrase.path,
              "T002",
              `${entry.id}: ${quote(phrase.text)} is also a label or form of ${o.id}`,
              [entry.id, o.id],
            ),
          );
        }
      }
      for (const other of records) {
        const o = other.entry;
        if (o.status === "active" && o.reject.some((r) => normalise(r) === phrase.text)) {
          out.push(
            fileFinding(
              ws,
              phrase.path,
              "T002",
              `${entry.id}: ${quote(phrase.text)} is a reject phrase of ${o.id}`,
              [entry.id, o.id],
            ),
          );
        }
      }
    }
  }
  return out;
}

/** The ids reachable from an entry by following replacedBy one or more times (live entries). */
function reachableFrom(ws: Workspace, start: string, memo: Map<string, Set<string>>): Set<string> {
  const known = memo.get(start);
  if (known !== undefined) {
    return known;
  }
  const seen = new Set<string>();
  const successors = (id: string): string[] =>
    existingOnly(ws, ws.entries.get(id)?.entry.replacedBy ?? []);
  const stack = successors(start);
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (!seen.has(next)) {
      seen.add(next);
      stack.push(...successors(next));
    }
  }
  memo.set(start, seen);
  return seen;
}

/** The cycle set of an entry (Section 5.2): the entries it reaches that reach it back. */
function cycleSetOf(ws: Workspace, id: string, memo: Map<string, Set<string>>): string[] {
  const reach = reachableFrom(ws, id, memo);
  return [...reach]
    .filter((other) => reachableFrom(ws, other, memo).has(id))
    .toSorted(compareUtf16);
}

/** T003: ids that are not existing ids, self references, owners that are not documents, cycles. */
function checkT003(ws: Workspace): FileFinding[] {
  const out: FileFinding[] = [];
  const memo = new Map<string, Set<string>>();
  for (const record of ws.terms.entries) {
    const { entry, path } = record;
    for (const field of ["distinguish", "replacedBy"] as const) {
      for (const [k, x] of entry[field].entries()) {
        const itemPath = `${path}.${field}[${k}]`;
        if (x === entry.id) {
          out.push(
            fileFinding(ws, itemPath, "T003", `${entry.id}: ${field} names the entry itself`, [
              entry.id,
            ]),
          );
        } else if (!ws.terms.existingIds.has(x)) {
          out.push(
            fileFinding(
              ws,
              itemPath,
              "T003",
              `${entry.id}: ${field} names ${x}, which is not an entry`,
              [entry.id],
            ),
          );
        }
      }
    }
    if (
      entry.status === "active" &&
      !isExternalOwner(entry.owner) &&
      !ws.documents.has(entry.owner)
    ) {
      out.push(
        fileFinding(
          ws,
          `${path}.owner`,
          "T003",
          `${entry.id}: owner ${entry.owner} is not a document`,
          [entry.id],
        ),
      );
    }
    const cycle = cycleSetOf(ws, entry.id, memo);
    const first = cycle[0];
    if (cycle.length >= 2 && first === entry.id) {
      out.push(
        fileFinding(
          ws,
          `${path}.replacedBy`,
          "T003",
          `${entry.id}: replacedBy cycle through ${cycle.join(", ")}`,
          cycle,
        ),
      );
    }
  }
  return out;
}

/** T004: the reason and replacements of deprecated entries and of active entries. */
function checkT004(ws: Workspace): FileFinding[] {
  const out: FileFinding[] = [];
  for (const record of ws.terms.entries) {
    const { entry, path } = record;
    const { id, reason } = entry;
    const count = entry.replacedBy.length;
    if (entry.status === "deprecated") {
      if (reason === undefined) {
        out.push(fileFinding(ws, path, "T004", `${id}: deprecated without a reason`, [id]));
      } else if ((reason === "merged" || reason === "renamed") && count !== 1) {
        out.push(
          fileFinding(
            ws,
            `${path}.reason`,
            "T004",
            `${id}: reason ${reason} needs exactly one replacement, has ${count}`,
            [id],
          ),
        );
      } else if (reason === "split" && count < 2) {
        out.push(
          fileFinding(
            ws,
            `${path}.reason`,
            "T004",
            `${id}: reason split needs at least two replacements, has ${count}`,
            [id],
          ),
        );
      } else if (reason === "out-of-scope" && count > 0) {
        out.push(
          fileFinding(
            ws,
            `${path}.reason`,
            "T004",
            `${id}: reason out-of-scope takes no replacement, has ${count}`,
            [id],
          ),
        );
      }
    } else {
      if (reason !== undefined) {
        out.push(
          fileFinding(ws, `${path}.reason`, "T004", `${id}: reason is set on an active entry`, [
            id,
          ]),
        );
      }
      if (count > 0) {
        out.push(
          fileFinding(
            ws,
            `${path}.replacedBy`,
            "T004",
            `${id}: replacedBy is set on an active entry`,
            [id],
          ),
        );
      }
    }
  }
  return out;
}

/**
 * The uses of an entry's owner text (Section 5.2): its document, or its supplied external owner
 * text; undefined when that text is unavailable.
 */
function ownerUsedIds(ws: Workspace, owner: string): ReadonlySet<string> | undefined {
  if (isExternalOwner(owner)) {
    return ws.externals.get(owner);
  }
  return ws.documents.get(owner)?.usedIds;
}

/** T005 (use of active entries) and T006 (owner text uses its entry), per active entry. */
function checkT005AndT006(ws: Workspace): FileFinding[] {
  const out: FileFinding[] = [];
  const docs = [...ws.documents.values()];
  for (const record of ws.terms.entries) {
    const { entry, path } = record;
    if (entry.status !== "active") {
      continue;
    }
    const users = docs
      .filter((doc) => doc.usedIds.has(entry.id))
      .map((doc) => doc.path)
      .toSorted(compareUtf16);
    const label = quote(entry.label);
    if (entry.key === "local") {
      for (const user of users.filter((doc) => doc !== entry.owner)) {
        out.push(
          fileFinding(
            ws,
            `${path}.label`,
            "T005",
            `${entry.id}: ${label} is local but used by ${user}`,
            [entry.id],
          ),
        );
      }
    } else if (users.length === 0) {
      out.push(
        fileFinding(ws, `${path}.label`, "T005", `${entry.id}: ${label} is used by no document`, [
          entry.id,
        ]),
      );
    } else if (entry.key === "shared" && users.length === 1) {
      out.push(
        fileFinding(
          ws,
          `${path}.label`,
          "T005",
          `${entry.id}: ${label} is shared but used only by ${users.join(", ")}`,
          [entry.id],
        ),
      );
    }
    const owner = ownerUsedIds(ws, entry.owner);
    if (owner !== undefined && !owner.has(entry.id)) {
      out.push(
        fileFinding(
          ws,
          `${path}.owner`,
          "T006",
          `${entry.id}: owner ${entry.owner} does not use ${label}`,
          [entry.id],
        ),
      );
    }
  }
  return out;
}
