/**
 * Operations on the terms file (specs/terms.md, Section 6): each takes the terms file's bytes, the
 * documents, the date, and its parameters, and gives a refusal or the new file text with its edit
 * list. Pure: no I/O and no clock.
 */

import {
  analyseWorkspace,
  fileFindings,
  isSuppressed,
  type FileFinding,
  type Workspace,
} from "./checks.ts";
import { readThesaurus, type RejectCandidate } from "./import.ts";
import { capitalisedOf, pluralOf, type Occurrence } from "./match.ts";
import {
  TERMS_PATH,
  parseTermsFile,
  writeTermsFile,
  type Entry,
  type HistoryItem,
  type Key,
  type TermsModel,
} from "./terms-file.ts";
import { compareUtf16, findingText, normalise, quote, trimWhiteSpace } from "./text.ts";

export type { RejectCandidate } from "./import.ts";

/** The parameters of each operation (Sections 6.2 to 6.8). Optional lists may be omitted. */
export interface AddParams {
  readonly op: "add";
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
  readonly owner: string;
  readonly group: string;
  /** One of `shared` and `confusable`, normalised (Section 6.1). */
  readonly key: string;
  readonly reject?: readonly string[] | undefined;
  readonly distinguish?: readonly string[] | undefined;
  readonly forms?: readonly string[] | undefined;
}

export interface UpdateParams {
  readonly op: "update";
  readonly id: string;
  /** The one value `active`, normalised (Section 6.1); returns a deprecated entry to active. */
  readonly status?: string | undefined;
  readonly key?: string | undefined;
  readonly meaning?: string | undefined;
  readonly addReject?: readonly string[] | undefined;
  readonly removeReject?: readonly string[] | undefined;
  readonly addDistinguish?: readonly string[] | undefined;
  readonly removeDistinguish?: readonly string[] | undefined;
}

export interface RenameParams {
  readonly op: "rename";
  readonly id: string;
  readonly label: string;
  readonly forms?: readonly string[] | undefined;
}

export interface MergeParams {
  readonly op: "merge";
  readonly id: string;
  readonly into: string;
}

export interface SplitParams {
  readonly op: "split";
  readonly id: string;
  readonly into: readonly string[];
}

export interface DeprecateParams {
  readonly op: "deprecate";
  readonly id: string;
  /** One of `renamed` and `out-of-scope`, normalised (Section 6.1). */
  readonly reason: string;
  readonly replacedBy?: readonly string[] | undefined;
}

export interface ReownParams {
  readonly op: "reown";
  readonly id: string;
  readonly owner: string;
}

export interface ImportParams {
  readonly op: "import";
  readonly path: string;
}

export type OperationParams =
  | AddParams
  | UpdateParams
  | RenameParams
  | MergeParams
  | SplitParams
  | DeprecateParams
  | ReownParams
  | ImportParams;

export interface OperationInput {
  /** The terms file's bytes; undefined when there is no terms file. */
  readonly termsBytes: Uint8Array | undefined;
  /** The documents, by workspace path, each text decoded as UTF-8 without a leading U+FEFF. */
  readonly documents: ReadonlyMap<string, string>;
  /** The date of the history items, a calendar date `YYYY-MM-DD`. */
  readonly date: string;
  readonly op: OperationParams;
}

/** One suggested change of an occurrence (Section 6.1); `new` is null when none is suggested. */
export interface Edit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly old: string;
  readonly new: string | null;
}

/** The data a caller needs beyond the text: the old label, the old owner, or the imported count. */
export type OperationSummary =
  | { readonly op: "add" | "update" | "merge" | "split" | "deprecate" }
  | { readonly op: "rename"; readonly oldLabel: string }
  | { readonly op: "reown"; readonly oldOwner: string }
  | { readonly op: "import"; readonly imported: number; readonly localIds: readonly string[] };

export type OperationResult =
  | { readonly ok: false; readonly refusal: string }
  | {
      readonly ok: true;
      /** The new terms file text in canonical form (Section 2.5). */
      readonly text: string;
      readonly edits: readonly Edit[];
      /** The reject candidates of an `import`; empty for other operations. */
      readonly candidates: readonly RejectCandidate[];
      readonly summary: OperationSummary;
    };

/** The planned change of an operation that passed its refusals (Sections 6.2 to 6.8). */
interface Plan {
  /** The new model; its entries are in ascending `id` order. */
  readonly model: TermsModel;
  /** The ids of the entries the operation changed. */
  readonly changed: ReadonlySet<string>;
  readonly summary: OperationSummary;
  readonly candidates: readonly RejectCandidate[];
  /**
   * Whether the occurrence is in the edit list, with its suggested text (null for none), or null
   * when it is not.
   */
  readonly pick: (occurrence: Occurrence) => Hold | null;
}

/** An occurrence in the edit list, with its suggested text. */
interface Hold {
  readonly to: string | null;
}

const hold = (to: string | null): Hold => ({ to });

type Step = Plan | { readonly refusal: string };

interface Context {
  readonly documents: ReadonlyMap<string, string>;
  readonly date: string;
}

type Update = readonly [id: string, change: (entry: Entry) => Entry];

/** Runs an operation (Section 6.1): the refusals, the new file, and its edit list. */
export function runOperation(input: OperationInput): OperationResult {
  const { op } = input;
  let model: TermsModel;
  if (input.termsBytes === undefined) {
    if (op.op !== "add" && op.op !== "import") {
      return { ok: false, refusal: `no terms file at ${TERMS_PATH}` };
    }
    model = { settings: {}, entries: [] };
  } else {
    const parsed = parseTermsFile(input.termsBytes);
    const first = parsed.t001[0];
    if (first !== undefined) {
      return {
        ok: false,
        refusal: `${TERMS_PATH} has T001 findings; fix them first: ${findingText(first)}`,
      };
    }
    model = { settings: parsed.settings, entries: parsed.entries.map((record) => record.entry) };
  }

  const step = plan(model, { documents: input.documents, date: input.date }, op);
  if ("refusal" in step) {
    return { ok: false, refusal: step.refusal };
  }
  const text = writeTermsFile(step.model);
  const next = parseTermsFile(new TextEncoder().encode(text));
  const ws = analyseWorkspace(next, input.documents);
  const failure = refusalFour(step, ws);
  if (failure !== undefined) {
    return { ok: false, refusal: `${op.op} refused: ${findingText(failure)}` };
  }
  return {
    ok: true,
    text,
    edits: editsOf(ws, step.pick),
    candidates: step.candidates,
    summary: step.summary,
  };
}

function plan(model: TermsModel, ctx: Context, op: OperationParams): Step {
  switch (op.op) {
    case "add":
      return planAdd(model, ctx, op);
    case "update":
      return planUpdate(model, ctx, op);
    case "rename":
      return planRename(model, ctx, op);
    case "merge":
      return planMerge(model, ctx, op);
    case "split":
      return planSplit(model, ctx, op);
    case "deprecate":
      return planDeprecate(model, ctx, op);
    case "reown":
      return planReown(model, ctx, op);
    case "import":
      return planImport(model, ctx, op);
  }
}

// ---------------------------------------------------------------------------------------------
// Operations (Sections 6.2 to 6.8)

/** Section 6.2. */
function planAdd(model: TermsModel, ctx: Context, p: AddParams): Step {
  const id = normalise(p.id);
  if (findEntry(model, id) !== undefined) {
    return refuse(`${id} is already an entry`);
  }
  const entry: Entry = {
    id,
    label: normalise(p.label),
    meaning: normalise(p.meaning),
    owner: trimWhiteSpace(p.owner),
    group: normalise(p.group),
    key: keyOf(p.key),
    status: "active",
    reject: listOf(p.reject),
    distinguish: listOf(p.distinguish),
    forms: listOf(p.forms),
    replacedBy: [],
    history: [{ date: ctx.date, op: "add" }],
  };
  return {
    model: { settings: model.settings, entries: [...model.entries, entry].toSorted(byId) },
    changed: new Set([id]),
    summary: { op: "add" },
    candidates: [],
    pick: (occurrence) =>
      isKind(occurrence, "reject", id) ? hold(suggest(entry.label, occurrence)) : null,
  };
}

/** Section 6.9. */
function planUpdate(model: TermsModel, ctx: Context, p: UpdateParams): Step {
  const id = normalise(p.id);
  const status = p.status === undefined ? undefined : statusOf(p.status);
  const blocked = updateIdRefusal(model, id, status !== undefined);
  if (blocked !== undefined) return refuse(blocked);
  const entry = entryOf(model, id);
  const addReject = listOf(p.addReject);
  const removeReject = listOf(p.removeReject);
  const addDistinguish = listOf(p.addDistinguish);
  const removeDistinguish = listOf(p.removeDistinguish);
  const lists: readonly (readonly [string, readonly string[]])[] = [
    ["addReject", addReject],
    ["removeReject", removeReject],
    ["addDistinguish", addDistinguish],
    ["removeDistinguish", removeDistinguish],
  ];
  for (const [field, values] of lists) {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) return refuse(`${field} repeats ${quote(value)}`);
      seen.add(value);
    }
  }
  for (const phrase of addReject) {
    if (removeReject.includes(phrase))
      return refuse(`update cannot add and remove reject ${quote(phrase)}`);
  }
  for (const other of addDistinguish) {
    if (removeDistinguish.includes(other))
      return refuse(`update cannot add and remove distinguish ${other}`);
  }
  for (const phrase of removeReject) {
    if (!entry.reject.some((value) => normalise(value) === phrase))
      return refuse(`${id} does not reject ${quote(phrase)}`);
  }
  for (const phrase of addReject) {
    if (entry.reject.some((value) => normalise(value) === phrase))
      return refuse(`${id} already rejects ${quote(phrase)}`);
  }
  for (const other of [...addDistinguish, ...removeDistinguish]) {
    const target = model.entries.find((candidate) => candidate.id === other);
    if (target === undefined) return refuse(`no entry ${other}`);
    if (other === id) return refuse(`cannot distinguish ${id} from itself`);
  }
  const related = (other: string): boolean =>
    entry.distinguish.includes(other) ||
    (findEntry(model, other)?.distinguish.includes(id) ?? false);
  for (const other of removeDistinguish) {
    if (!related(other)) return refuse(`${id} is not distinguished from ${other}`);
  }
  for (const other of addDistinguish) {
    if (related(other)) return refuse(`${id} is already distinguished from ${other}`);
  }
  const key = p.key === undefined ? entry.key : keyOf(p.key);
  const meaning = p.meaning === undefined ? entry.meaning : normalise(p.meaning);
  const reactivate = status === "active" && entry.status === "deprecated";
  const nextReject = entry.reject.filter((value) => !removeReject.includes(normalise(value)));
  nextReject.push(...addReject);
  const updates: Update[] = [];
  const changed = new Set<string>();
  const alter = (targetId: string, change: (current: Entry) => Entry): void => {
    const current = entryOf(model, targetId);
    const updated = change(current);
    if (
      updated.status !== current.status ||
      updated.key !== current.key ||
      updated.meaning !== current.meaning ||
      updated.reject.some((value, index) => value !== current.reject[index]) ||
      updated.reject.length !== current.reject.length ||
      updated.distinguish.some((value, index) => value !== current.distinguish[index]) ||
      updated.distinguish.length !== current.distinguish.length
    ) {
      changed.add(targetId);
      const meaningChanged = updated.meaning !== current.meaning;
      const statusChanged = updated.status !== current.status;
      const item: HistoryItem =
        meaningChanged && statusChanged
          ? { date: ctx.date, op: "update", meaning: current.meaning, status: "deprecated" }
          : meaningChanged
            ? { date: ctx.date, op: "update", meaning: current.meaning }
            : statusChanged
              ? { date: ctx.date, op: "update", status: "deprecated" }
              : { date: ctx.date, op: "update" };
      updates.push([targetId, (value) => ({ ...updated, history: [...value.history, item] })]);
    }
  };
  const nextDistinguish = entry.distinguish.filter((other) => !removeDistinguish.includes(other));
  for (const other of addDistinguish)
    if (!nextDistinguish.includes(other)) nextDistinguish.push(other);
  alter(id, (current) => {
    const updated: Entry = {
      ...current,
      key,
      meaning,
      reject: nextReject,
      distinguish: nextDistinguish,
    };
    return reactivate ? returnedToActive(updated) : updated;
  });
  for (const other of [...removeDistinguish, ...addDistinguish]) {
    const current = entryOf(model, other);
    const relation = current.distinguish.includes(id);
    const desired = addDistinguish.includes(other);
    alter(other, (value) => ({
      ...value,
      distinguish: desired
        ? relation
          ? value.distinguish
          : [...value.distinguish, id]
        : value.distinguish.filter((item) => item !== id),
    }));
  }
  if (changed.size === 0) return refuse(`update makes no changes to ${id}`);
  const next = updateEntries(model, updates);
  return {
    model: next,
    changed,
    summary: { op: "update" },
    candidates: [],
    pick: (occurrence) =>
      isKind(occurrence, "reject", id) && addReject.includes(occurrence.variant.phrase)
        ? hold(suggest(entry.label, occurrence))
        : null,
  };
}

/** Section 6.3. */
function planRename(model: TermsModel, ctx: Context, p: RenameParams): Step {
  const id = normalise(p.id);
  const blocked = activeRefusal(model, [id]);
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  const entry = entryOf(model, id);
  const label = normalise(p.label);
  // The old label is the entry's label as written (Section 6.3).
  const oldLabel = entry.label;
  if (normalise(oldLabel) === label) {
    return refuse(`${id} is already labelled ${quote(label)}`);
  }
  const forms = listOf(p.forms);
  const excluded = new Set([label, ...forms]);
  const reject = [...entry.reject];
  // The phrases appended to reject, by normalised text, mapped to whether one is the old label.
  const appended = new Map<string, boolean>();
  const oldPhrases: [string, boolean][] = [
    [oldLabel, true],
    ...entry.forms.map((form): [string, boolean] => [form, false]),
  ];
  for (const [phrase, fromLabel] of oldPhrases) {
    const text = normalise(phrase);
    if (excluded.has(text) || reject.some((item) => normalise(item) === text)) {
      continue;
    }
    reject.push(phrase);
    appended.set(text, fromLabel);
  }
  const next: Entry = {
    ...entry,
    label,
    forms,
    reject: reject.filter((item) => !excluded.has(normalise(item))),
    history: [...entry.history, { date: ctx.date, op: "rename", from: oldLabel, to: label }],
  };
  return {
    model: updateEntries(model, [[id, () => next]]),
    changed: new Set([id]),
    summary: { op: "rename", oldLabel },
    candidates: [],
    pick: (occurrence) => {
      if (!isKind(occurrence, "reject", id)) {
        return null;
      }
      const fromLabel = appended.get(occurrence.variant.phrase);
      if (fromLabel === undefined) {
        return null;
      }
      return hold(fromLabel ? suggest(label, occurrence) : null);
    },
  };
}

/** Section 6.4. */
function planMerge(model: TermsModel, ctx: Context, p: MergeParams): Step {
  const id = normalise(p.id);
  const into = normalise(p.into);
  const blocked = activeRefusal(model, [id, into]);
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  if (id === into) {
    return refuse(`cannot merge ${id} into itself`);
  }
  const from = entryOf(model, id);
  const target = entryOf(model, into);
  const movedSet = new Set(movePhrases(from, target).moved);
  return {
    model: updateEntries(model, [
      [
        id,
        (entry) => ({
          ...entry,
          status: "deprecated",
          reason: "merged",
          replacedBy: [into],
          reject: [],
          history: [...entry.history, { date: ctx.date, op: "merge", into }],
        }),
      ],
      [
        into,
        (entry) => ({
          ...entry,
          reject: movePhrases(from, entry).reject,
          history: [...entry.history, { date: ctx.date, op: "merge", from: id }],
        }),
      ],
    ]),
    changed: new Set([id, into]),
    summary: { op: "merge" },
    candidates: [],
    pick: (occurrence) => {
      if (isKind(occurrence, "deprecated", id)) {
        return hold(suggest(target.label, occurrence));
      }
      if (isKind(occurrence, "reject", into) && movedSet.has(occurrence.variant.phrase)) {
        return hold(suggest(target.label, occurrence));
      }
      return null;
    },
  };
}

/** Section 6.5. */
function planSplit(model: TermsModel, ctx: Context, p: SplitParams): Step {
  const id = normalise(p.id);
  const into = listOf(p.into);
  const blocked = activeRefusal(model, [id, ...into]);
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  return {
    model: updateEntries(model, [
      [
        id,
        (entry) => ({
          ...entry,
          status: "deprecated",
          reason: "split",
          replacedBy: into,
          history: [...entry.history, { date: ctx.date, op: "split", into }],
        }),
      ],
      ...into.map((target): Update => [
        target,
        (entry) => ({
          ...entry,
          history: [...entry.history, { date: ctx.date, op: "split", from: id }],
        }),
      ]),
    ]),
    changed: new Set([id, ...into]),
    summary: { op: "split" },
    candidates: [],
    pick: (occurrence) => (isKind(occurrence, "deprecated", id) ? hold(null) : null),
  };
}

/** Section 6.6. */
function planDeprecate(model: TermsModel, ctx: Context, p: DeprecateParams): Step {
  const id = normalise(p.id);
  const replacedBy = listOf(p.replacedBy);
  const blocked = activeRefusal(model, [id, ...replacedBy]);
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  const from = entryOf(model, id);
  const reason = reasonOf(p.reason);
  const single = replacedBy.length === 1 ? replacedBy[0] : undefined;
  const updates: Update[] = [
    [
      id,
      (entry) => ({
        ...entry,
        status: "deprecated",
        reason,
        replacedBy,
        reject: single === undefined ? entry.reject : [],
        history: [
          ...entry.history,
          {
            date: ctx.date,
            op: "deprecate",
            reason,
            ...(replacedBy.length > 0 ? { replacedBy } : {}),
          },
        ],
      }),
    ],
  ];
  let moved = new Set<string>();
  if (single !== undefined) {
    moved = new Set(movePhrases(from, entryOf(model, single)).moved);
    updates.push([
      single,
      (entry) => ({
        ...entry,
        reject: movePhrases(from, entry).reject,
        history: [...entry.history, { date: ctx.date, op: "deprecate", from: id }],
      }),
    ]);
  }
  const next = updateEntries(model, updates);
  const replacement = single === undefined ? undefined : findEntry(next, single);
  return {
    model: next,
    changed: new Set(single === undefined ? [id] : [id, single]),
    summary: { op: "deprecate" },
    candidates: [],
    pick: (occurrence) => {
      if (isKind(occurrence, "deprecated", id)) {
        return hold(replacement === undefined ? null : suggest(replacement.label, occurrence));
      }
      if (
        replacement !== undefined &&
        isKind(occurrence, "reject", replacement.id) &&
        moved.has(occurrence.variant.phrase)
      ) {
        return hold(suggest(replacement.label, occurrence));
      }
      return null;
    },
  };
}

/** Section 6.7. */
function planReown(model: TermsModel, ctx: Context, p: ReownParams): Step {
  const id = normalise(p.id);
  const owner = trimWhiteSpace(p.owner);
  const blocked = activeRefusal(model, [id]);
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  const entry = entryOf(model, id);
  if (entry.owner === owner) {
    return refuse(`${id} is already owned by ${owner}`);
  }
  return {
    model: updateEntries(model, [
      [
        id,
        (current) => ({
          ...current,
          owner,
          history: [
            ...current.history,
            { date: ctx.date, op: "reown", from: current.owner, to: owner },
          ],
        }),
      ],
    ]),
    changed: new Set([id]),
    summary: { op: "reown", oldOwner: entry.owner },
    candidates: [],
    pick: () => null,
  };
}

/** Section 6.8. */
function planImport(model: TermsModel, ctx: Context, p: ImportParams): Step {
  if (model.entries.length > 0) {
    return refuse(
      `import needs a terms file without entries; ${TERMS_PATH} has ${model.entries.length}`,
    );
  }
  const path = trimWhiteSpace(p.path);
  const text = ctx.documents.get(path);
  if (text === undefined) {
    return refuse(`${path} is not a document`);
  }
  const result = readThesaurus(path, text, ctx.date, ctx.documents);
  if ("refusal" in result) {
    return refuse(result.refusal);
  }
  return {
    model: { settings: model.settings, entries: result.entries },
    changed: new Set(result.entries.map((entry) => entry.id)),
    summary: {
      op: "import",
      imported: result.entries.length,
      localIds: result.entries.filter((entry) => entry.key === "local").map((entry) => entry.id),
    },
    candidates: result.candidates,
    pick: () => null,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function refuse(refusal: string): Step {
  return { refusal };
}

function byId(a: Entry, b: Entry): number {
  return compareUtf16(a.id, b.id);
}

function findEntry(model: TermsModel, id: string): Entry | undefined {
  return model.entries.find((entry) => entry.id === id);
}

/** The entry with the id; the callers have checked that it exists. */
function entryOf(model: TermsModel, id: string): Entry {
  const entry = findEntry(model, id);
  if (entry === undefined) {
    throw new Error(`internal: no entry ${id}`);
  }
  return entry;
}

/**
 * The refusal 3 of Section 6.1 for the ids a parameter list names, in order: `no entry <x>`, or
 * `<x> is deprecated`; undefined when every id names an active entry.
 */
function activeRefusal(model: TermsModel, ids: readonly string[]): string | undefined {
  for (const id of ids) {
    const entry = findEntry(model, id);
    if (entry === undefined) {
      return `no entry ${id}`;
    }
    if (entry.status === "deprecated") {
      return `${id} is deprecated`;
    }
  }
  return;
}

/**
 * Refusal 3 of Section 6.1 for the id of `update` (Section 6.9): a deprecated entry is refused only
 * when `status` is absent.
 */
function updateIdRefusal(model: TermsModel, id: string, statusGiven: boolean): string | undefined {
  const entry = findEntry(model, id);
  if (entry === undefined) {
    return `no entry ${id}`;
  }
  if (!statusGiven && entry.status === "deprecated") {
    return `${id} is deprecated`;
  }
  return;
}

/** The entry returned to active: `reason` and `replacedBy` removed (Section 6.9). */
function returnedToActive(entry: Entry): Entry {
  const next: Entry = { ...entry, status: "active", replacedBy: [] };
  delete next.reason;
  return next;
}

/** The `status` parameter of `update`, normalised (Section 6.1); the schema admits one value. */
function statusOf(value: string): "active" {
  const status = normalise(value);
  if (status === "active") return status;
  throw new Error(`internal: no status ${status}`);
}

/** The `key` parameter, normalised (Section 6.1); the tool's schema admits its three values. */
function keyOf(value: string): Key {
  const key = normalise(value);
  if (key === "shared" || key === "confusable" || key === "local") return key;
  throw new Error(`internal: no key ${key}`);
}

/** The `reason` parameter of `deprecate`, normalised (Section 6.1). */
function reasonOf(value: string): "renamed" | "out-of-scope" {
  const reason = normalise(value);
  if (reason === "renamed" || reason === "out-of-scope") return reason;
  throw new Error(`internal: no reason ${reason}`);
}

/** The normalised strings of an optional list parameter (Section 6.1). */
function listOf(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => normalise(value));
}

/** Applies each update to the entry with its id, in order. */
function updateEntries(model: TermsModel, updates: readonly Update[]): TermsModel {
  let entries = model.entries;
  for (const [id, change] of updates) {
    entries = entries.map((entry) => (entry.id === id ? change(entry) : entry));
  }
  return { settings: model.settings, entries };
}

/**
 * The phrases of `from` that `to` does not have, appended to the reject list of `to`
 * (Sections 6.4 and 6.6), with the phrases appended.
 */
function movePhrases(from: Entry, to: Entry): { moved: string[]; reject: string[] } {
  const have = new Set(to.reject.map((phrase) => normalise(phrase)));
  const moved: string[] = [];
  for (const phrase of from.reject.map((item) => normalise(item))) {
    if (!have.has(phrase)) {
      have.add(phrase);
      moved.push(phrase);
    }
  }
  return { moved, reject: [...to.reject, ...moved] };
}

function isKind(occurrence: Occurrence, kind: Occurrence["variant"]["kind"], id: string): boolean {
  return occurrence.variant.kind === kind && occurrence.variant.entry.id === id;
}

/**
 * The suggested text of an occurrence for a label (Section 6.1): its plural when the variant is
 * plural, none when the label has no plural, then its capitalised variant when the variant is
 * capitalised and the label has one.
 */
function suggest(label: string, occurrence: Occurrence): string | null {
  if (occurrence.variant.kind === "deprecated" && fromForm(occurrence)) {
    return null;
  }
  const plural = occurrence.variant.plural ? pluralOf(label) : label;
  if (plural === undefined) {
    return null;
  }
  return occurrence.variant.capitalised ? (capitalisedOf(plural) ?? plural) : plural;
}

/** Whether the variant of an occurrence came from a `forms` phrase rather than the label (Section 6.1). */
function fromForm(occurrence: Occurrence): boolean {
  const { entry, phrase } = occurrence.variant;
  return (
    (entry.forms ?? []).some((form) => normalise(form) === phrase) &&
    normalise(entry.label) !== phrase
  );
}

function editsOf(ws: Workspace, pick: Plan["pick"]): Edit[] {
  const edits: Edit[] = [];
  for (const doc of ws.documents.values()) {
    for (const occurrence of doc.occurrences) {
      if (isSuppressed(doc, occurrence)) {
        continue;
      }
      const held = pick(occurrence);
      if (held !== null) {
        edits.push({
          path: doc.path,
          line: occurrence.line,
          column: occurrence.column,
          old: occurrence.source,
          new: held.to,
        });
      }
    }
  }
  return edits.toSorted(
    (a, b) => compareUtf16(a.path, b.path) || a.line - b.line || a.column - b.column,
  );
}

/**
 * The first finding of refusal 4 of Section 6.1: a T001, T002, T003, or T004 finding that concerns
 * a changed entry.
 */
function refusalFour(planned: Plan, ws: Workspace): FileFinding | undefined {
  return fileFindings(ws).find(
    (finding) =>
      (finding.code === "T001" ||
        finding.code === "T002" ||
        finding.code === "T003" ||
        finding.code === "T004") &&
      finding.concerns.some((id) => planned.changed.has(id)),
  );
}
