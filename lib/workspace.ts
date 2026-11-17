/**
 * The I/O of the workspace (specs/terms.md, Section 1; specs/terms-tool.md, Sections 2 and 4.3):
 * the workspace root, the documents, and the terms file, through Git and the file system.
 *
 * The access is an interface, so the tool and the after-edit check take it as a dependency. A
 * failure is a `TermsError` whose message is the tool error text of specs/terms-tool.md, Section 2.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { TERMS_PATH } from "./terms-file.ts";
import { compareUtf16 } from "./text.ts";

/** A failure of the workspace, reported as a tool error whose text is the message. */
export class TermsError extends Error {}

/** The workspace I/O a call or an event needs. */
export interface WorkspaceAccess {
  /** The workspace root of `cwd`; a `TermsError` when there is none or Git fails. */
  root(cwd: string, signal?: AbortSignal): Promise<string>;
  /** The documents of the workspace at `root`, by workspace path, in ascending path order. */
  documents(root: string, signal?: AbortSignal): Promise<ReadonlyMap<string, string>>;
  /**
   * The text of the document at a workspace path, or `undefined` when the path is not a document
   * of the workspace (terms.md, Section 1.2); Git lists only that path, by a literal pathspec.
   */
  document(root: string, path: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * The text of an external owner path (terms.md, Section 1.2) resolved against `root`, or
   * `undefined` when it is unavailable.
   */
  externalOwner(root: string, path: string): Promise<string | undefined>;
  /** The terms file's bytes; `undefined` when there is no terms file. */
  readTerms(root: string): Promise<Uint8Array | undefined>;
  /** Writes the terms file, creating its directory; a `TermsError` on failure. */
  writeTerms(root: string, text: string): Promise<void>;
  /** The file system's resolved path of `path`. */
  realpath(path: string): Promise<string>;
}

/** Git's output limit; a listing beyond it fails as `git failed`. */
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

type GitRun =
  | { readonly ok: true; readonly stdout: Buffer }
  | { readonly ok: false; readonly exited: boolean; readonly message: string };

/** The first line of a text, or `undefined` when it has none. */
function firstLine(text: string): string | undefined {
  const line = text.split("\n", 1)[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
}

/**
 * Runs Git in `cwd`; `exited` tells a failure status from a Git that did not start. An aborted
 * `signal` ends the Git process, and the run fails with the abort's message (Section 2).
 */
function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "buffer", maxBuffer: GIT_OUTPUT_LIMIT, signal },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout });
          return;
        }
        const detail = firstLine(stderr.toString("utf8"));
        resolve({
          ok: false,
          exited: typeof error.code === "number",
          message: detail ?? error.message,
        });
      },
    );
  });
}

/** The error code the file system reports, when it reports one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (typeof error.code === "string") return error.code;
  }
  return undefined;
}

/** The error code the file system reports, else its message. */
function fileProblem(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

/**
 * The file a symbolic link at the terms path resolves to, else the path itself (Section 2); a
 * path that gives `ENOENT` has no file to resolve to.
 */
async function termsTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return path;
    throw error;
  }
}

/** A name no other write of the same directory takes. */
function temporaryName(target: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A document's text, or `undefined` when the file is not one (specs/terms.md, Section 1.2). */
async function readDocument(path: string): Promise<string | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  let text: string;
  try {
    text = UTF8.decode(await readFile(path));
  } catch {
    return undefined;
  }
  if (text.includes("\u0000")) return undefined;
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/**
 * The workspace path of an absolute path below `root` (specs/terms.md, Section 1.1), or
 * `undefined` when the path is not below `root` or has an empty, `.`, or `..` segment.
 */
export function workspacePathOf(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute);
  if (rel === "") return undefined;
  const segments = rel.split(sep);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
}

/** The workspace I/O of a real Git working tree and file system. */
export const realWorkspace: WorkspaceAccess = {
  async root(cwd, signal) {
    const run = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
    if (!run.ok && run.exited) throw new TermsError(`${cwd} is not inside a Git working tree`);
    if (!run.ok) throw new TermsError(`git failed: ${run.message}`);
    return run.stdout.toString("utf8").replace(/\n$/, "");
  },

  async documents(root, signal) {
    const run = await runGit(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      root,
      signal,
    );
    if (!run.ok) throw new TermsError(`git failed: ${run.message}`);
    const paths = new Set(run.stdout.toString("utf8").split("\0"));
    const documents = new Map<string, string>();
    for (const path of paths) {
      if (path === "" || !path.endsWith(".md")) continue;
      const text = await readDocument(join(root, path));
      if (text !== undefined) documents.set(path, text);
    }
    return new Map([...documents].toSorted(([a], [b]) => compareUtf16(a, b)));
  },

  async document(root, path, signal) {
    const run = await runGit(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(literal)${path}`],
      root,
      signal,
    );
    if (!run.ok) throw new TermsError(`git failed: ${run.message}`);
    if (!run.stdout.toString("utf8").split("\0").includes(path)) return;
    return readDocument(join(root, path));
  },

  async externalOwner(root, path) {
    return readDocument(join(root, path));
  },

  async readTerms(root) {
    try {
      return await readFile(join(root, TERMS_PATH));
    } catch (error) {
      // A `.pi` or `.pi/pi-dent` that is a regular file makes the terms file absent (ENOTDIR), as a
      // missing one.
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw new TermsError(`cannot read ${TERMS_PATH}: ${fileProblem(error)}`);
    }
  },

  async writeTerms(root, text) {
    let temporary: string | undefined;
    try {
      await mkdir(join(root, dirname(TERMS_PATH)), { recursive: true });
      // The new text goes to a new file, renamed over the target, so a failed write leaves the
      // previous terms file as it was and removes the new file (Section 2).
      const target = await termsTarget(join(root, TERMS_PATH));
      temporary = temporaryName(target);
      await writeFile(temporary, text, "utf8");
      await rename(temporary, target);
      temporary = undefined;
    } catch (error) {
      if (temporary !== undefined) {
        try {
          await rm(temporary, { force: true });
        } catch {
          // The write's failure is the error reported; removing the new file is best effort.
        }
      }
      throw new TermsError(`cannot write ${TERMS_PATH}: ${fileProblem(error)}`);
    }
  },

  realpath: (path) => realpath(path),
};
