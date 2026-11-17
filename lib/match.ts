/**
 * Matching of entries in prose: variants, occurrences, and uses. See specs/terms.md, Section 4.
 */

import type { ProseItem, ProseRun } from "./prose.ts";
import { compareUtf16, isWhiteSpace, isWordChar, normalise } from "./text.ts";

export type Reason = "merged" | "split" | "renamed" | "out-of-scope";

/** The fields of an entry that matching reads; the entries passed have passed Section 2. */
export interface MatchEntry {
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "deprecated";
  readonly reject?: readonly string[];
  readonly forms?: readonly string[];
  readonly replacedBy?: readonly string[];
  readonly reason?: Reason;
}

export type VariantKind = "label" | "form" | "deprecated" | "reject";

/** A normalised string an entry is found by (Section 4.1). */
export interface Variant {
  readonly entry: MatchEntry;
  readonly kind: VariantKind;
  /** The normalised phrase the variant derives from. */
  readonly phrase: string;
  readonly text: string;
  readonly plural: boolean;
  readonly capitalised: boolean;
}

/** A place in a prose run where a variant is found (Section 4.2). */
export interface Occurrence {
  readonly variant: Variant;
  /** UTF-16 offsets of the source text, in the document text. */
  readonly start: number;
  readonly end: number;
  /** Line and column (UTF-16) of the first character. */
  readonly line: number;
  readonly column: number;
  /** The source text of the occurrence. */
  readonly source: string;
  /** The spelled prose text, normalised. */
  readonly spelled: string;
}

const KIND_ORDER: readonly VariantKind[] = ["label", "form", "deprecated", "reject"];

/** The plural of a phrase whose last character is a letter, else undefined (Section 4.1). */
export function pluralOf(phrase: string): string | undefined {
  const chars = [...phrase];
  const last = chars.at(-1);
  if (last === undefined || !/^\p{L}$/u.test(last)) {
    return undefined;
  }
  let k = chars.length;
  while (k > 0 && isWordChar(chars[k - 1] ?? "")) {
    k--;
  }
  const head = chars.slice(0, k).join("");
  const word = chars.slice(k).join("");
  const beforeLast = chars.at(-2) ?? "";
  if (/(?:s|x|z|ch|sh)$/u.test(word)) {
    return `${head}${word}es`;
  }
  if (word.endsWith("y") && /^\p{L}$/u.test(beforeLast) && !"aeiou".includes(beforeLast)) {
    return `${head}${word.slice(0, -1)}ies`;
  }
  return `${head}${word}s`;
}

/** The capitalised variant of a string whose first character is of category Ll, else undefined. */
export function capitalisedOf(s: string): string | undefined {
  const first = [...s][0];
  if (first === undefined || !/^\p{Ll}$/u.test(first)) {
    return undefined;
  }
  return `${first.toUpperCase()}${s.slice(first.length)}`;
}

/** The variants of the entries, per Section 4.1. */
export function variantsOf(entries: readonly MatchEntry[]): Variant[] {
  const out: Variant[] = [];
  const add = (entry: MatchEntry, kind: VariantKind, phrase: string, withPlural: boolean): void => {
    const base = normalise(phrase);
    const forms: { text: string; plural: boolean }[] = [{ text: base, plural: false }];
    const plural = withPlural ? pluralOf(base) : undefined;
    if (plural !== undefined) {
      forms.push({ text: plural, plural: true });
    }
    for (const form of forms) {
      out.push({
        entry,
        kind,
        phrase: base,
        text: form.text,
        plural: form.plural,
        capitalised: false,
      });
      const cap = capitalisedOf(form.text);
      if (cap !== undefined) {
        out.push({ entry, kind, phrase: base, text: cap, plural: form.plural, capitalised: true });
      }
    }
  };
  for (const entry of entries) {
    if (entry.status === "active") {
      add(entry, "label", entry.label, true);
      for (const form of entry.forms ?? []) {
        add(entry, "form", form, false);
      }
      for (const reject of entry.reject ?? []) {
        add(entry, "reject", reject, true);
      }
    } else {
      add(entry, "deprecated", entry.label, true);
      for (const form of entry.forms ?? []) {
        add(entry, "deprecated", form, false);
      }
    }
  }
  return out;
}

interface Prepared {
  readonly variant: Variant;
  readonly chars: readonly string[];
}

interface Found {
  readonly variant: Variant;
  readonly end: number;
  readonly spelled: string;
}

/** Finds the occurrences of the variants in the runs of a document, per Section 4.2. */
export function findOccurrences(
  text: string,
  runs: readonly ProseRun[],
  variants: readonly Variant[],
): Occurrence[] {
  const prepared: Prepared[] = variants.map((variant) => ({
    variant,
    chars: [...variant.text],
  }));
  const byFirst = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const first = p.chars[0];
    if (first !== undefined) {
      const list = byFirst.get(first);
      if (list === undefined) {
        byFirst.set(first, [p]);
      } else {
        list.push(p);
      }
    }
  }
  const out: Occurrence[] = [];
  for (const run of runs) {
    const items = run.items;
    let i = 0;
    while (i < items.length) {
      const best = bestAt(items, i, byFirst);
      if (best === undefined) {
        i++;
        continue;
      }
      const first = items[i];
      const last = items[best.end - 1];
      if (first?.kind === "char" && last?.kind === "char") {
        out.push({
          variant: best.variant,
          start: first.start,
          end: last.end,
          line: first.line,
          column: first.column,
          source: text.slice(first.start, last.end),
          spelled: normalise(best.spelled),
        });
      }
      i = best.end;
    }
  }
  return out;
}

/** The ids of the entries used by the occurrences, ascending (Section 4.3). */
export function usedEntryIds(occurrences: readonly Occurrence[]): string[] {
  const ids = new Set<string>();
  for (const occ of occurrences) {
    if (occ.variant.kind === "label" || occ.variant.kind === "form") {
      ids.add(occ.variant.entry.id);
    }
  }
  return [...ids].toSorted(compareUtf16);
}

/** The variant found at position i that wins the order of Section 4.2, if any. */
function bestAt(
  items: readonly ProseItem[],
  i: number,
  byFirst: ReadonlyMap<string, readonly Prepared[]>,
): Found | undefined {
  const head = items[i];
  if (head?.kind !== "char") {
    return undefined;
  }
  let best: Found | undefined;
  for (const p of byFirst.get(head.char) ?? []) {
    const found = matchAt(items, i, p);
    if (found !== undefined && (best === undefined || precedes(found, best))) {
      best = found;
    }
  }
  return best;
}

/** Whether `a` comes before `b` in the order of Section 4.2. */
function precedes(a: Found, b: Found): boolean {
  if (a.spelled.length !== b.spelled.length) {
    return a.spelled.length > b.spelled.length;
  }
  const activeA = a.variant.kind === "label" || a.variant.kind === "form";
  const activeB = b.variant.kind === "label" || b.variant.kind === "form";
  if (activeA !== activeB && (a.variant.kind === "deprecated" || b.variant.kind === "deprecated")) {
    return activeA;
  }
  if (a.variant.capitalised !== b.variant.capitalised) {
    return !a.variant.capitalised;
  }
  if (a.variant.plural !== b.variant.plural) {
    return !a.variant.plural;
  }
  const kindA = KIND_ORDER.indexOf(a.variant.kind);
  const kindB = KIND_ORDER.indexOf(b.variant.kind);
  if (kindA !== kindB) {
    return kindA < kindB;
  }
  return compareUtf16(a.variant.entry.id, b.variant.entry.id) < 0;
}

function matchAt(items: readonly ProseItem[], i: number, p: Prepared): Found | undefined {
  const { chars } = p;
  const first = chars[0];
  const last = chars.at(-1);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  if (isWordChar(first) && i > 0) {
    const before = items[i - 1];
    if (before?.kind === "char" && isWordChar(before.char)) {
      return undefined;
    }
  }
  let j = i;
  for (const want of chars) {
    const item = items[j];
    if (item?.kind !== "char") {
      return undefined;
    }
    if (want === " ") {
      if (!isWhiteSpace(item.char)) {
        return undefined;
      }
      j++;
      while (true) {
        const next = items[j];
        if (next?.kind === "char" && isWhiteSpace(next.char)) {
          j++;
        } else {
          break;
        }
      }
    } else {
      if (item.char !== want) {
        return undefined;
      }
      j++;
    }
  }
  if (isWordChar(last)) {
    const after = items[j];
    if (after?.kind === "char" && isWordChar(after.char)) {
      return undefined;
    }
  }
  let spelled = "";
  for (let k = i; k < j; k++) {
    const item = items[k];
    if (item?.kind === "char") {
      spelled += item.char;
    }
  }
  return { variant: p.variant, end: j, spelled };
}
