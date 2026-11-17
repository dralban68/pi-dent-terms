/**
 * The `Terms` tool (specs/terms-tool.md, Sections 1 to 3): its parameter schema (1.1), its
 * model-facing texts (1.3), the validation of a call (1.2), and its actions over the terms file
 * (2 and 3).
 *
 * `runTerms` is the core. It takes the workspace access and the date as dependencies, so it needs
 * neither a host nor a clock; `createTermsTool` registers it with the host.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { checkWorkspace, isExternalOwner } from "./checks.ts";
import { checkChanges, validateChanges, type Change, type LabelOccurrence } from "./changes.ts";
import {
  runOperation,
  type Edit,
  type OperationParams,
  type OperationSummary,
  type RejectCandidate,
} from "./operations.ts";
import {
  TERMS_PATH,
  parseTermsFile,
  type Entry,
  type EntryRecord,
  type Key,
  type Status,
  type TermsFile,
} from "./terms-file.ts";
import { compareUtf16, findingText, normalise, quote } from "./text.ts";
import { TermsError, type WorkspaceAccess } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Schema (Section 1.1) and model-facing texts (Section 1.3)
// ---------------------------------------------------------------------------

/** The model-facing `description` of the tool (Section 1.3). */
export const TERMS_DESCRIPTION = `Manage this workspace's thesaurus in .pi/pi-dent/terms.yaml, one preferred label per concept and no synonyms, and check the workspace's Markdown documents against it. find looks entries up by id, label, reject phrase, form, or meaning, optionally filtered by status, key, group, or owner (a filter alone lists every entry it admits), and lists each match with its meaning, status, owner, and related entries; use it to learn what a term means and before writing a domain term you are unsure of. check reports findings for the terms file and for every Markdown document not ignored by git; with changes, each the changed file's path, its text before the change (null when new), and from when moved, it reports only the findings the changes introduced and lists label occurrences on changed lines, to confirm each means its entry; list every file you changed, .pi/pi-dent/terms.yaml included after an operation, and keep each before text the same across checks. add, update, rename, merge, split, deprecate, and reown change the terms file and record the change in each changed entry's history; ids are never removed. update changes an active entry's key, meaning, reject phrases, or symmetric distinguish relations, recording a replaced meaning in history, and with status active returns a deprecated entry to active; give at least one effective change. local entries are used only by their owner. An entire normalised code span matching an active label or form, or its capitalised variant, counts as a use, never an occurrence to rewrite. Owners can be workspace-relative paths with leading ../ for external files. import fills an empty terms file from a Markdown table with the columns Term, Meaning, Owner, and Avoid or distinguish. No action edits a document: the result lists the occurrences to rewrite, with a suggested text where there is one; apply them with your edit tool. To keep one occurrence on purpose, put <!-- terms-ignore P001: reason --> (or P002) on its line or as a standalone comment before it; a standalone comment targets the first nonblank line after its block.`;

/** The model-facing `promptSnippet` of the tool (Section 1.3). */
export const TERMS_PROMPT_SNIPPET = "Look up, check, and change the workspace's thesaurus of terms";

const ACTION_DESCRIPTION =
  "find: look entries up. check: report findings. add, update, rename, merge, split, deprecate, reown, import: change the terms file.";

const FIELD_DESCRIPTIONS = {
  query:
    "For find: text to look for in ids, labels, reject phrases, forms, and meanings, ignoring case; optional when a filter (status, key, group, owner) is given.",
  id: 'The entry\'s id, a lowercase slug such as "rendered-view"; for add, the new id.',
  label: "For add and rename: the one preferred term, in base form, lowercase unless a name.",
  meaning: "For add (required) or update (optional): one sentence saying what the concept is.",
  owner:
    "For add and reown: the owner path of the Markdown file that defines the term, relative to the workspace root; leading ../ is allowed. For find: list only entries with this owner.",
  group: "For add: the group the entry is listed under. For find: list only entries in this group.",
  key: "For add (required) or update (optional): shared for use by two or more documents, confusable for one or more, local for use only by the owner. For find: list only entries with this key.",
  status:
    "For find: list only active or only deprecated entries. For update: active returns a deprecated entry to active; the other update fields apply as well.",
  addReject: "For update: specific reject phrases to add; already-present phrases are refused.",
  removeReject: "For update: reject phrases to remove; missing phrases are refused.",
  addDistinguish:
    "For update: existing ids to distinguish from, on both entries; self and existing relations are refused.",
  removeDistinguish:
    "For update: ids to stop distinguishing from, on both entries; missing relations are refused.",
  reject: "For add: specific phrases that must not be used for this concept; never ordinary words.",
  distinguish: "For add: ids of neighbouring concepts a reader could confuse with this one.",
  forms:
    "For add and rename: irregular inflections of the label only; regular plurals are derived.",
  into: "For merge: the one id that absorbs the entry. For split: the two or more ids that replace it; add them first.",
  reason: "For deprecate: renamed (with one replacedBy) or out-of-scope (with none).",
  replacedBy: "For deprecate: the id of the entry that replaces it.",
  path: "For import: the workspace-relative path of the Markdown thesaurus.",
  changes:
    "For check: the changed files, each { path, before, from }: before is the text before the change, null for a new file; from is the old path of a moved file.",
} as const;

const optionalString = (description: string) =>
  Type.Optional(Type.Union([Type.String(), Type.Null()], { description }));

const optionalStrings = (description: string) =>
  Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()], { description }));

/** The parameter schema of the tool (Section 1.1). */
export const TermsSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("find"),
        Type.Literal("check"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("rename"),
        Type.Literal("merge"),
        Type.Literal("split"),
        Type.Literal("deprecate"),
        Type.Literal("reown"),
        Type.Literal("import"),
      ],
      { description: ACTION_DESCRIPTION },
    ),
    query: optionalString(FIELD_DESCRIPTIONS.query),
    id: optionalString(FIELD_DESCRIPTIONS.id),
    label: optionalString(FIELD_DESCRIPTIONS.label),
    meaning: optionalString(FIELD_DESCRIPTIONS.meaning),
    owner: optionalString(FIELD_DESCRIPTIONS.owner),
    group: optionalString(FIELD_DESCRIPTIONS.group),
    key: Type.Optional(
      Type.Union(
        [Type.Literal("shared"), Type.Literal("confusable"), Type.Literal("local"), Type.Null()],
        {
          description: FIELD_DESCRIPTIONS.key,
        },
      ),
    ),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("deprecated"), Type.Null()], {
        description: FIELD_DESCRIPTIONS.status,
      }),
    ),
    reject: optionalStrings(FIELD_DESCRIPTIONS.reject),
    distinguish: optionalStrings(FIELD_DESCRIPTIONS.distinguish),
    addReject: optionalStrings(FIELD_DESCRIPTIONS.addReject),
    removeReject: optionalStrings(FIELD_DESCRIPTIONS.removeReject),
    addDistinguish: optionalStrings(FIELD_DESCRIPTIONS.addDistinguish),
    removeDistinguish: optionalStrings(FIELD_DESCRIPTIONS.removeDistinguish),
    forms: optionalStrings(FIELD_DESCRIPTIONS.forms),
    into: optionalStrings(FIELD_DESCRIPTIONS.into),
    reason: Type.Optional(
      Type.Union([Type.Literal("renamed"), Type.Literal("out-of-scope"), Type.Null()], {
        description: FIELD_DESCRIPTIONS.reason,
      }),
    ),
    replacedBy: optionalStrings(FIELD_DESCRIPTIONS.replacedBy),
    path: optionalString(FIELD_DESCRIPTIONS.path),
    changes: Type.Optional(
      Type.Union(
        [
          Type.Array(
            Type.Object(
              {
                path: Type.String(),
                before: Type.Union([Type.String(), Type.Null()]),
                from: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              },
              { additionalProperties: false },
            ),
          ),
          Type.Null(),
        ],
        { description: FIELD_DESCRIPTIONS.changes },
      ),
    ),
  },
  { additionalProperties: false },
);

/** The parameters of a call, as the schema admits them. */
export type TermsParams = Static<typeof TermsSchema>;

export type Action = TermsParams["action"];

/** The operations of Section 3.3, the actions that change the terms file. */
export type OperationAction = Exclude<Action, "find" | "check">;

/** The parameter fields, in the table order of Section 1.1. */
type Field =
  | "query"
  | "id"
  | "label"
  | "meaning"
  | "owner"
  | "group"
  | "key"
  | "status"
  | "reject"
  | "distinguish"
  | "addReject"
  | "removeReject"
  | "addDistinguish"
  | "removeDistinguish"
  | "forms"
  | "into"
  | "reason"
  | "replacedBy"
  | "path"
  | "changes";

const FIELDS: readonly Field[] = [
  "query",
  "id",
  "label",
  "meaning",
  "owner",
  "group",
  "key",
  "status",
  "reject",
  "distinguish",
  "addReject",
  "removeReject",
  "addDistinguish",
  "removeDistinguish",
  "forms",
  "into",
  "reason",
  "replacedBy",
  "path",
  "changes",
];

const STRING_FIELDS: readonly Field[] = [
  "query",
  "id",
  "label",
  "meaning",
  "owner",
  "group",
  "path",
];

const LIST_FIELDS = [
  "reject",
  "distinguish",
  "addReject",
  "removeReject",
  "addDistinguish",
  "removeDistinguish",
  "forms",
  "into",
  "replacedBy",
] as const;

/** The fields each action accepts (Section 1.1). */
const ACCEPTS: Record<Action, readonly Field[]> = {
  find: ["query", "status", "key", "group", "owner"],
  check: ["changes"],
  add: ["id", "label", "meaning", "owner", "group", "key", "reject", "distinguish", "forms"],
  update: [
    "id",
    "status",
    "key",
    "meaning",
    "addReject",
    "removeReject",
    "addDistinguish",
    "removeDistinguish",
  ],
  rename: ["id", "label", "forms"],
  merge: ["id", "into"],
  split: ["id", "into"],
  deprecate: ["id", "reason", "replacedBy"],
  reown: ["id", "owner"],
  import: ["path"],
};

/** The fields each action requires (Section 1.1). */
const REQUIRED: Record<Action, readonly Field[]> = {
  find: [],
  check: [],
  add: ["id", "label", "meaning", "owner", "group", "key"],
  update: ["id"],
  rename: ["id", "label"],
  merge: ["id", "into"],
  split: ["id", "into"],
  deprecate: ["id", "reason"],
  reown: ["id", "owner"],
  import: ["path"],
};

// ---------------------------------------------------------------------------
// Arguments and validation (Section 1.2)
// ---------------------------------------------------------------------------

/** A call's arguments with null counted as absent and strings other than `before` trimmed. */
interface Args {
  readonly action: Action;
  readonly query?: string | undefined;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  readonly meaning?: string | undefined;
  readonly owner?: string | undefined;
  readonly group?: string | undefined;
  readonly key?: Key | undefined;
  readonly status?: Status | undefined;
  readonly reject?: readonly string[] | undefined;
  readonly distinguish?: readonly string[] | undefined;
  readonly addReject?: readonly string[] | undefined;
  readonly removeReject?: readonly string[] | undefined;
  readonly addDistinguish?: readonly string[] | undefined;
  readonly removeDistinguish?: readonly string[] | undefined;
  readonly forms?: readonly string[] | undefined;
  readonly into?: readonly string[] | undefined;
  readonly reason?: "renamed" | "out-of-scope" | undefined;
  readonly replacedBy?: readonly string[] | undefined;
  readonly path?: string | undefined;
  readonly changes?: readonly Change[] | undefined;
}

/** Removes leading and trailing white space (specs/terms.md, Section 4.1). */
function trimmed(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** A value with null made absent. */
function given<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function trimmedText(value: string | null | undefined): string | undefined {
  const present = given(value);
  return present === undefined ? undefined : trimmed(present);
}

function list(value: readonly string[] | null | undefined): string[] | undefined {
  const present = given(value);
  return present === undefined ? undefined : present.map((item) => trimmed(item));
}

/** Nulls made absent and strings other than `before` trimmed (Sections 1.1 and 1.2). */
export function cleanArgs(params: TermsParams): Args {
  return {
    action: params.action,
    query: trimmedText(params.query),
    id: trimmedText(params.id),
    label: trimmedText(params.label),
    meaning: trimmedText(params.meaning),
    owner: trimmedText(params.owner),
    group: trimmedText(params.group),
    key: given(params.key),
    status: given(params.status),
    reject: list(params.reject),
    distinguish: list(params.distinguish),
    addReject: list(params.addReject),
    removeReject: list(params.removeReject),
    addDistinguish: list(params.addDistinguish),
    removeDistinguish: list(params.removeDistinguish),
    forms: list(params.forms),
    into: list(params.into),
    reason: given(params.reason),
    replacedBy: list(params.replacedBy),
    path: trimmedText(params.path),
    changes: given(params.changes)?.map((change) => ({
      path: trimmed(change.path),
      before: change.before,
      ...(change.from == null ? {} : { from: trimmed(change.from) }),
    })),
  };
}

/** The error text of the first failing check of Section 1.2, or `undefined` when none fails. */
export function validate(args: Args): string | undefined {
  const { action } = args;
  for (const field of FIELDS) {
    if (args[field] !== undefined && !ACCEPTS[action].includes(field)) {
      return `${field} is not valid for action ${action}`;
    }
  }
  for (const field of FIELDS) {
    if (REQUIRED[action].includes(field) && args[field] === undefined) {
      return `action ${action} requires ${field}`;
    }
  }
  for (const field of STRING_FIELDS) {
    if (args[field] === "") return `${field} must be a non-empty string`;
  }
  for (const field of LIST_FIELDS) {
    const items = args[field];
    if (items !== undefined && items.includes("")) {
      return `${field} must hold non-empty strings`;
    }
  }
  if (action === "merge" && args.into?.length !== 1) {
    return "merge takes exactly one id in into";
  }
  if (
    action === "find" &&
    args.query === undefined &&
    args.status === undefined &&
    args.key === undefined &&
    args.group === undefined &&
    args.owner === undefined
  ) {
    return "action find requires query or a filter";
  }
  if (action === "update" && args.status === "deprecated") {
    return "update takes status active only; use deprecate";
  }
  return args.changes === undefined ? undefined : validateChanges(args.changes);
}

/** A value that validation has shown to be present. */
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("a validated argument is absent");
  return value;
}

// ---------------------------------------------------------------------------
// Outcomes and details (Section 3)
// ---------------------------------------------------------------------------

/** The details of a finding in `check` (Section 3.2). */
export interface FindingDetail {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

/** The details of an edit list item (Section 3.3). */
export interface EditDetail {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly old: string;
  readonly new: string | null;
}

/** The details of a result (Section 3). */
export type TermsDetails =
  | { readonly action: "find"; readonly ids: readonly string[] }
  | {
      readonly action: "check";
      readonly findings: readonly FindingDetail[];
      readonly occurrences?: readonly Pick<
        LabelOccurrence,
        "id" | "path" | "line" | "column" | "text"
      >[];
    }
  | {
      readonly action: OperationAction;
      readonly edits: readonly EditDetail[];
      readonly candidates?: readonly { readonly id: string; readonly text: string }[];
      readonly localIds?: readonly string[];
    };

/** The outcome of a call: a tool error with its text, or a result with its text and details. */
export type TermsOutcome =
  | { readonly isError: true; readonly text: string }
  | { readonly isError: false; readonly text: string; readonly details: TermsDetails };

/** The inputs of a call beyond its parameters (Section 2). */
export interface TermsDependencies {
  /** The invoking session's working directory. */
  readonly cwd: string;
  readonly io: WorkspaceAccess;
  /** The current calendar date in the local time zone, `YYYY-MM-DD`. */
  readonly today: () => string;
  /** The call's abort signal; a Git command it fires while running ends the call (Section 2). */
  readonly signal?: AbortSignal | undefined;
}

const NO_TERMS_FILE = `no terms file at ${TERMS_PATH}`;

function failure(text: string): TermsOutcome {
  return { isError: true, text };
}

function success(lines: readonly string[], details: TermsDetails): TermsOutcome {
  return { isError: false, text: lines.join("\n"), details };
}

/** A call's outcome as the host's tool result (Section 1). */
export function toToolResult(outcome: TermsOutcome): AgentToolResult<TermsDetails | undefined> {
  if (outcome.isError) {
    return { content: [{ type: "text", text: outcome.text }], details: undefined, isError: true };
  }
  return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
}

// ---------------------------------------------------------------------------
// Core (Sections 2 and 3)
// ---------------------------------------------------------------------------

/** Runs a call (Sections 1.2, 2, and 3): validation first, then the workspace and the action. */
export async function runTerms(
  params: TermsParams,
  dependencies: TermsDependencies,
): Promise<TermsOutcome> {
  const args = cleanArgs(params);
  const problem = validate(args);
  if (problem !== undefined) return failure(problem);
  try {
    return await perform(args, dependencies);
  } catch (error) {
    if (error instanceof TermsError) return failure(error.message);
    throw error;
  }
}

async function perform(args: Args, dependencies: TermsDependencies): Promise<TermsOutcome> {
  const { cwd, io, signal } = dependencies;
  const root = await io.root(cwd, signal);
  const documents: ReadonlyMap<string, string> =
    args.action === "find" ? new Map() : await io.documents(root, signal);
  const bytes = await io.readTerms(root);

  if (args.action === "find") {
    if (bytes === undefined) return failure(NO_TERMS_FILE);
    return find(args, parseTermsFile(bytes));
  }
  if (args.action === "check") {
    if (bytes === undefined) return failure(NO_TERMS_FILE);
    return check(bytes, documents, await gatherExternalOwners(bytes, root, io), args.changes);
  }
  return operate(args, args.action, root, bytes, documents, dependencies);
}

// --- find (Section 3.1) ----------------------------------------------------

function find(args: Args, terms: TermsFile): TermsOutcome {
  const query = args.query === undefined ? undefined : normalise(args.query);
  const group = args.group === undefined ? undefined : normalise(args.group);
  const byId = new Map<string, Entry>(
    terms.entries.map((record) => [record.entry.id, record.entry]),
  );
  const matching = terms.entries
    .map((record) => record.entry)
    .filter((entry) => matches(entry, args, query, group));
  const ordered = query === undefined ? matching.toSorted(byIdOrder) : labelFirst(matching, query);
  const search = searchText(args, query, group);

  const lines: string[] = [];
  if (ordered.length === 0) {
    lines.push(`No entry matches ${search}`);
  } else {
    lines.push(`${ordered.length} entries match ${search}:`);
    for (const entry of ordered) lines.push(...entryLines(entry, terms, byId));
  }
  if (terms.t001.length > 0) {
    lines.push(`${TERMS_PATH} has ${terms.t001.length} T001 findings; run check`);
  }
  return success(lines, { action: "find", ids: ordered.map((entry) => entry.id) });
}

/** True when every condition of Section 3.1 that is present holds for an entry. */
function matches(
  entry: Entry,
  args: Args,
  query: string | undefined,
  group: string | undefined,
): boolean {
  if (query !== undefined && !searched(entry, query.toLowerCase())) return false;
  if (args.status !== undefined && entry.status !== args.status) return false;
  if (args.key !== undefined && entry.key !== args.key) return false;
  if (group !== undefined && normalise(entry.group) !== group) return false;
  if (args.owner !== undefined && entry.owner !== args.owner) return false;
  return true;
}

/** The matches with the label-equal ones first, each part in ascending id order (Section 3.1). */
function labelFirst(entries: readonly Entry[], query: string): Entry[] {
  const needle = query.toLowerCase();
  const isExact = (entry: Entry): boolean => normalise(entry.label).toLowerCase() === needle;
  return [
    ...entries.filter(isExact).toSorted(byIdOrder),
    ...entries.filter((entry) => !isExact(entry)).toSorted(byIdOrder),
  ];
}

/** `<search>`: the present parts joined by `, `, in the order of Section 3.1. */
function searchText(args: Args, query: string | undefined, group: string | undefined): string {
  const parts: string[] = [];
  if (query !== undefined) parts.push(quote(query));
  if (args.status !== undefined) parts.push(`status ${args.status}`);
  if (args.key !== undefined) parts.push(`key ${args.key}`);
  if (group !== undefined) parts.push(`group ${quote(group)}`);
  if (args.owner !== undefined) parts.push(`owner ${args.owner}`);
  return parts.join(", ");
}

function byIdOrder(a: Entry, b: Entry): number {
  return compareUtf16(a.id, b.id);
}

/** True when `<query>`, lower-cased, is a substring of one of an entry's texts (Section 3.1). */
function searched(entry: Entry, needle: string): boolean {
  return searchTexts(entry).some((text) => text.includes(needle));
}

/** The texts an entry is searched by: id, label, meaning, reject and form phrases (Section 3.1). */
function searchTexts(entry: Entry): string[] {
  return [entry.id, entry.label, entry.meaning, ...entry.reject, ...entry.forms].map((item) =>
    normalise(item).toLowerCase(),
  );
}

/** The lines of one matching entry: its header, then its indented details (Section 3.1). */
function entryLines(entry: Entry, terms: TermsFile, byId: ReadonlyMap<string, Entry>): string[] {
  const reference = (id: string): string => {
    const target = byId.get(id);
    return target === undefined ? `${id} (not an entry)` : `${id} ${quote(target.label)}`;
  };
  const lines = [
    `${entry.id} ${quote(entry.label)} · ${entry.status} · ${entry.key} · ${entry.group} · owner ${entry.owner}`,
    `  meaning: ${entry.meaning}`,
  ];
  if (entry.reject.length > 0) {
    lines.push(`  reject: ${entry.reject.map((phrase) => quote(phrase)).join(", ")}`);
  }
  if (entry.forms.length > 0) {
    lines.push(`  forms: ${entry.forms.map((phrase) => quote(phrase)).join(", ")}`);
  }
  const related = distinguishIds(entry, terms.entries);
  if (related.length > 0) {
    lines.push(`  distinguish: ${related.map((id) => reference(id)).join(", ")}`);
  }
  if (entry.replacedBy.length > 0) {
    lines.push(`  replacedBy: ${entry.replacedBy.map((id) => reference(id)).join(", ")}`);
  }
  if (entry.reason !== undefined) lines.push(`  reason: ${entry.reason}`);
  return lines;
}

/** The ids in the `distinguish` relation with an entry, in ascending order (Section 2.3). */
function distinguishIds(entry: Entry, records: readonly EntryRecord[]): string[] {
  const ids = new Set<string>(entry.distinguish);
  for (const record of records) {
    if (record.entry.distinguish.includes(entry.id)) ids.add(record.entry.id);
  }
  return [...ids].toSorted(compareUtf16);
}

// --- check (Section 3.2) ---------------------------------------------------

function check(
  bytes: Uint8Array,
  documents: ReadonlyMap<string, string>,
  externalOwners: ReadonlyMap<string, string>,
  changes?: readonly Change[],
): TermsOutcome {
  const result =
    changes === undefined
      ? { ...checkWorkspace(bytes, documents, externalOwners), occurrences: undefined }
      : checkChanges(bytes, documents, externalOwners, changes);
  const header =
    changes === undefined
      ? `${result.findings.length} findings · ${documents.size} documents · ${result.termsCount} entries`
      : `${result.findings.length} findings introduced · ${changes.length} changes · ${documents.size} documents · ${result.termsCount} entries`;
  const findings: FindingDetail[] = result.findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    column: finding.column,
    code: finding.code,
    message: finding.message,
  }));
  const lines = [header, ...result.findings.map((finding) => findingText(finding))];
  if (result.occurrences === undefined) return success(lines, { action: "check", findings });
  if (result.occurrences.length > 0) {
    lines.push(
      "",
      `${result.occurrences.length} label occurrences in changed lines; confirm each means its entry:`,
    );
    let previousId: string | undefined;
    for (const occurrence of result.occurrences) {
      if (occurrence.id !== previousId) {
        lines.push(`${occurrence.id} ${quote(occurrence.label)}: ${occurrence.meaning}`);
        previousId = occurrence.id;
      }
      lines.push(
        `  ${occurrence.path}:${occurrence.line}:${occurrence.column} ${quote(occurrence.text)}`,
      );
    }
  }
  return success(lines, {
    action: "check",
    findings,
    occurrences: result.occurrences.map(({ id, path, line, column, text }) => ({
      id,
      path,
      line,
      column,
      text,
    })),
  });
}

// --- operations (Section 3.3) ----------------------------------------------

/** The operation parameters of a validated call (Sections 6.2 to 6.8). */
function toOperation(args: Args): OperationParams {
  switch (args.action) {
    case "add":
      return {
        op: "add",
        id: need(args.id),
        label: need(args.label),
        meaning: need(args.meaning),
        owner: need(args.owner),
        group: need(args.group),
        key: need(args.key),
        reject: args.reject,
        distinguish: args.distinguish,
        forms: args.forms,
      };
    case "update":
      return {
        op: "update",
        id: need(args.id),
        status: args.status,
        key: args.key,
        meaning: args.meaning,
        addReject: args.addReject,
        removeReject: args.removeReject,
        addDistinguish: args.addDistinguish,
        removeDistinguish: args.removeDistinguish,
      };
    case "rename":
      return { op: "rename", id: need(args.id), label: need(args.label), forms: args.forms };
    case "merge":
      return { op: "merge", id: need(args.id), into: need(args.into)[0] ?? "" };
    case "split":
      return { op: "split", id: need(args.id), into: need(args.into) };
    case "deprecate":
      return {
        op: "deprecate",
        id: need(args.id),
        reason: need(args.reason),
        replacedBy: args.replacedBy,
      };
    case "reown":
      return { op: "reown", id: need(args.id), owner: need(args.owner) };
    case "import":
      return { op: "import", path: need(args.path) };
    case "find":
    case "check":
      throw new Error("find and check are not operations");
  }
}

async function operate(
  args: Args,
  action: OperationAction,
  root: string,
  bytes: Uint8Array | undefined,
  documents: ReadonlyMap<string, string>,
  dependencies: TermsDependencies,
): Promise<TermsOutcome> {
  const date = dependencies.today();
  const result = runOperation({
    termsBytes: bytes,
    documents,
    date,
    op: toOperation(args),
  });
  if (!result.ok) return failure(result.refusal);
  await dependencies.io.writeTerms(root, result.text);

  const lines = [
    `${summaryLine(args, result.summary)} · ${TERMS_PATH} written`,
    ...editLines(result.edits),
  ];
  const edits = result.edits.map((edit) => editDetail(edit));
  if (result.summary.op !== "import") return success(lines, { action, edits });
  lines.push(...candidateLines(result.candidates));
  return success(lines, {
    action,
    edits,
    candidates: result.candidates.map((candidate) => ({ id: candidate.id, text: candidate.item })),
    localIds: result.summary.localIds,
  });
}

async function gatherExternalOwners(
  bytes: Uint8Array,
  root: string,
  io: WorkspaceAccess,
): Promise<ReadonlyMap<string, string>> {
  const paths = new Set<string>();
  for (const { entry } of parseTermsFile(bytes).entries) {
    if (entry.status === "active" && isExternalOwner(entry.owner)) paths.add(entry.owner);
  }
  const owners = new Map<string, string>();
  for (const path of paths) {
    const text = await io.externalOwner(root, path);
    if (text !== undefined) owners.set(path, text);
  }
  return owners;
}

function editDetail(edit: Edit): EditDetail {
  return {
    path: edit.path,
    line: edit.line,
    column: edit.column,
    old: edit.old,
    new: edit.new,
  };
}

/** The summary line of an operation (Section 3.3). */
function summaryLine(args: Args, summary: OperationSummary): string {
  switch (summary.op) {
    case "add":
      return `Added ${need(args.id)} ${quote(normalise(need(args.label)))}`;
    case "update":
      return `Updated ${need(args.id)}`;
    case "rename":
      return `Renamed ${need(args.id)} ${quote(summaryOld(summary))} → ${quote(normalise(need(args.label)))}`;
    case "merge":
      return `Merged ${need(args.id)} into ${need(args.into)[0] ?? ""}`;
    case "split":
      return `Split ${need(args.id)} into ${need(args.into).join(", ")}`;
    case "deprecate": {
      const replacements = args.replacedBy ?? [];
      const arrow = replacements.length > 0 ? ` → ${replacements.join(", ")}` : "";
      return `Deprecated ${need(args.id)} (${need(args.reason)})${arrow}`;
    }
    case "reown":
      return `Moved the owner of ${need(args.id)} from ${summaryOld(summary)} to ${need(args.owner)}`;
    case "import": {
      const locals =
        summary.localIds.length === 0 ? "" : `; key local: ${summary.localIds.join(", ")}`;
      return `Imported ${summary.imported} entries from ${need(args.path)}${locals}`;
    }
  }
}

/** The old label or owner a summary carries; the operation gives one per its kind. */
function summaryOld(summary: OperationSummary): string {
  if (summary.op === "rename") return summary.oldLabel;
  if (summary.op === "reown") return summary.oldOwner;
  throw new Error("the summary carries no old value");
}

/** The edit list block (Section 3.3). */
function editLines(edits: readonly Edit[]): string[] {
  if (edits.length === 0) return ["No occurrences to edit."];
  return [
    `${edits.length} occurrences to edit with your edit tool; no document was changed:`,
    ...edits.map((edit) => {
      const suggestion = edit.new === null ? "no suggestion, rewrite by hand" : quote(edit.new);
      return `${edit.path}:${edit.line}:${edit.column} ${quote(edit.old)} → ${suggestion}`;
    }),
  ];
}

/** The reject candidate block of an import, absent when there is none (Section 3.3). */
function candidateLines(candidates: readonly RejectCandidate[]): string[] {
  if (candidates.length === 0) return [];
  return [
    `${candidates.length} reject candidates; use update with addReject for specific phrases and drop ordinary words:`,
    ...candidates.map((candidate) => `${candidate.id}: ${quote(candidate.item)}`),
  ];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The local calendar date of a point in time, `YYYY-MM-DD` (Section 2). */
export function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The `Terms` tool definition (Section 1), over the given workspace access. */
export function createTermsTool(
  io: WorkspaceAccess,
  today: () => string = () => localDate(new Date()),
): ToolDefinition<typeof TermsSchema, TermsDetails | undefined> {
  return {
    name: "Terms",
    label: "Terms",
    description: TERMS_DESCRIPTION,
    promptSnippet: TERMS_PROMPT_SNIPPET,
    parameters: TermsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return toToolResult(await runTerms(params, { cwd: ctx.cwd, io, today, signal }));
    },
  };
}
