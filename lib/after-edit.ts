/**
 * The after-edit check (specs/terms-tool.md, Section 4): the effective setting (4.1) and the
 * handler that checks a document the host's `edit` or `write` tool changed (4.3).
 */

import { basename, dirname, join, resolve } from "node:path";

import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

import { proseChecks, type ProseFinding } from "./checks.ts";
import type { TermsConfig } from "./config.ts";
import { parseTermsFile } from "./terms-file.ts";
import { findingText } from "./text.ts";
import { workspacePathOf, type WorkspaceAccess } from "./workspace.ts";

/** The content of a tool result (specs/terms-tool.md, Section 4.3). */
export type ResultContent = ToolResultEvent["content"];

/** The fields of a `tool_result` event the check reads. */
export interface ToolResultFields {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: ResultContent;
  readonly isError: boolean;
}

/** The inputs of the handler (specs/terms-tool.md, Section 4.3). */
export interface AfterEditDependencies {
  readonly io: WorkspaceAccess;
  /** The user's home directory, for a leading `~`. */
  readonly homeDir: string;
  /** The configuration, once read at the first `session_start`; `undefined` before. */
  readonly config: () => TermsConfig | undefined;
}

/**
 * The effective after-edit setting of a workspace whose terms file exists (Section 4.1): the
 * file's `settings.checkAfterEdit` when present, else the configuration's, else off.
 */
export function effectiveCheckAfterEdit(
  settings: boolean | undefined,
  configured: boolean | undefined,
): boolean {
  return settings ?? configured ?? false;
}

/**
 * The absolute target of an event's `path` (Section 4.3): one leading `@` removed, `~` or a
 * leading `~/` read as `homeDir`, resolved against `cwd` when relative.
 */
export function targetPath(raw: string, cwd: string, homeDir: string): string {
  let path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~") {
    path = homeDir;
  } else if (path.startsWith("~/")) {
    path = join(homeDir, path.slice(2));
  }
  return resolve(cwd, path);
}

/** The appended text of a check (Section 4.3): its header, then one line per finding. */
export function checkBlockText(path: string, findings: readonly ProseFinding[]): string {
  return [
    `Terms check of ${path}: ${findings.length} findings`,
    ...findings.map((finding) => findingText(finding)),
  ].join("\n");
}

/**
 * The `tool_result` handler for `edit` and `write` (Section 4.3). It returns the event's content
 * with the check block appended when findings remain, and `undefined` (the result unchanged) in
 * every other case, a failure to run Git or read a file included.
 */
export function createAfterEdit(
  dependencies: AfterEditDependencies,
): (event: ToolResultFields, cwd: string) => Promise<ToolResultEventResult | undefined> {
  return async (event, cwd) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const raw = event.input.path;
    if (typeof raw !== "string") return;
    // Only a `.md` target can be a document, so nothing else is looked at (terms.md, Section 1.2).
    const target = targetPath(raw, cwd, dependencies.homeDir);
    if (!basename(target).endsWith(".md")) return;
    try {
      return await checkWritten(dependencies, event.content, target, cwd);
    } catch {
      return;
    }
  };
}

async function checkWritten(
  { io, config }: AfterEditDependencies,
  content: ResultContent,
  target: string,
  cwd: string,
): Promise<ToolResultEventResult | undefined> {
  const root = await io.root(cwd);
  const bytes = await io.readTerms(root);
  if (bytes === undefined) return;
  const terms = parseTermsFile(bytes);
  if (!effectiveCheckAfterEdit(terms.settings.checkAfterEdit, config()?.checkAfterEdit)) {
    return;
  }

  // The directory is resolved, so that a symbolic link in `cwd` does not hide the document.
  const absolute = join(await io.realpath(dirname(target)), basename(target));
  const path = workspacePathOf(root, absolute);
  if (path === undefined) return;
  const text = await io.document(root, path);
  if (text === undefined) return;

  const findings = proseChecks(path, text, terms);
  if (findings.length === 0) return;
  return {
    content: [...content, { type: "text", text: checkBlockText(path, findings) }],
  };
}
