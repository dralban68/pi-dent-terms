import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  checkBlockText,
  createAfterEdit,
  effectiveCheckAfterEdit,
  targetPath,
  type ToolResultFields,
} from "../lib/after-edit.ts";
import type { TermsConfig } from "../lib/config.ts";
import { TermsError, realWorkspace, type WorkspaceAccess } from "../lib/workspace.ts";

const ROOT = "/repo";
const HOME = "/home/u";

const VIEW = "# View\n\nThe rendered view shows the page.\n";
const OTHER = "Use the html preview here.\n";

const RENDERED = `  - id: rendered-view
    label: rendered view
    meaning: How a document looks once rendered.
    owner: docs/view.md
    group: Rendering
    key: confusable
    status: active
    reject:
      - html preview
    history:
      - { date: 2026-01-02, op: add }
`;

const TERMS_ON = `settings:\n  checkAfterEdit: true\nterms:\n${RENDERED}`;
const TERMS_OFF = `settings:\n  checkAfterEdit: false\nterms:\n${RENDERED}`;
const TERMS_UNSET = `terms:\n${RENDERED}`;
const TERMS_WRONG_TYPE = `settings:\n  checkAfterEdit: "yes"\nterms:\n${RENDERED}`;

const DOCUMENTS: Record<string, string> = {
  "docs/view.md": VIEW,
  "docs/other.md": OTHER,
  "docs/clean.md": "Nothing to see.\n",
  "docs/suppressed.md": "<!-- terms-ignore P001: legacy -->\nUse the html preview here.\n",
  "docs/two.md": "Use the html preview and the html preview.\n",
};

const P001 = '"html preview" is rejected: use "rendered view" (rendered-view)';

interface FakeOptions {
  terms?: string | undefined;
  documents?: Record<string, string>;
  gitFails?: boolean;
  readFails?: boolean;
}

/** A workspace with fixed contents; its paths resolve to themselves. */
function workspace(options: FakeOptions): WorkspaceAccess {
  return {
    async root() {
      if (options.gitFails === true) throw new TermsError("git failed: boom");
      return ROOT;
    },
    async documents() {
      return new Map(Object.entries(options.documents ?? DOCUMENTS));
    },
    async document(_root, path) {
      return (options.documents ?? DOCUMENTS)[path];
    },
    async externalOwner() {
      return undefined;
    },
    async readTerms() {
      if (options.readFails === true)
        throw new TermsError("cannot read .pi/pi-dent/terms.yaml: EACCES");
      return options.terms === undefined ? undefined : new TextEncoder().encode(options.terms);
    },
    async writeTerms() {
      throw new Error("the after-edit check writes nothing");
    },
    async realpath(path) {
      return path;
    },
  };
}

function handler(io: WorkspaceAccess, config: TermsConfig | undefined) {
  return createAfterEdit({ io, homeDir: HOME, config: () => config });
}

/** A `tool_result` of a successful `edit` or `write` of `path`. */
function written(path: unknown, toolName = "edit"): ToolResultFields {
  return {
    toolName,
    input: { path },
    content: [{ type: "text", text: "Edited the file." }],
    isError: false,
  };
}

function block(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

const APPENDED_OTHER = `Terms check of docs/other.md: 1 findings\ndocs/other.md:1:9 P001 ${P001}`;

test("4.1 setting: the file's value, else the configuration's, else off", () => {
  assert.equal(effectiveCheckAfterEdit(true, false), true);
  assert.equal(effectiveCheckAfterEdit(false, true), false);
  assert.equal(effectiveCheckAfterEdit(undefined, true), true);
  assert.equal(effectiveCheckAfterEdit(undefined, false), false);
  assert.equal(effectiveCheckAfterEdit(undefined, undefined), false);
  assert.equal(effectiveCheckAfterEdit(true, undefined), true);
});

test("4.1 setting: the file's setting decides over the configuration", async () => {
  const on = handler(workspace({ terms: TERMS_ON }), { checkAfterEdit: false, diagnostics: [] });
  assert.deepEqual(await on(written("@docs/other.md"), ROOT), {
    content: [block("Edited the file."), block(APPENDED_OTHER)],
  });

  const off = handler(workspace({ terms: TERMS_OFF }), { checkAfterEdit: true, diagnostics: [] });
  assert.equal(await off(written("@docs/other.md"), ROOT), undefined);
});

test("4.1 setting: an absent or wrong-typed file setting counts as absent", async () => {
  const configured = { checkAfterEdit: true, diagnostics: [] };
  const appended = [block("Edited the file."), block(APPENDED_OTHER)];
  const unset = handler(workspace({ terms: TERMS_UNSET }), configured);
  assert.deepEqual((await unset(written("@docs/other.md"), ROOT))?.content, appended);

  const wrongType = handler(workspace({ terms: TERMS_WRONG_TYPE }), configured);
  assert.deepEqual((await wrongType(written("@docs/other.md"), ROOT))?.content, appended);
});

test("4.1 setting: no configuration and no file setting is off", async () => {
  const io = workspace({ terms: TERMS_UNSET });
  assert.equal(await handler(io, undefined)(written("@docs/other.md"), ROOT), undefined);
  assert.equal(await handler(io, { diagnostics: [] })(written("@docs/other.md"), ROOT), undefined);
});

test("4.1 setting: a workspace without a terms file is off, whatever the configuration", async () => {
  const io = workspace({});
  assert.equal(
    await handler(io, { checkAfterEdit: true, diagnostics: [] })(written("@docs/other.md"), ROOT),
    undefined,
  );
});

test("4.1 setting: a settings value that is not a mapping counts as absent", async () => {
  const configured = { checkAfterEdit: true, diagnostics: [] };
  const appended = [block("Edited the file."), block(APPENDED_OTHER)];
  const notMapping = handler(workspace({ terms: `settings: 5\n${TERMS_UNSET}` }), configured);
  assert.deepEqual((await notMapping(written("@docs/other.md"), ROOT))?.content, appended);
});

test("4.1 setting: a duplicate settings key leaves the file without settings", async () => {
  const duplicate = `settings:\n  checkAfterEdit: true\n  checkAfterEdit: true\nterms:\n${RENDERED}`;
  assert.equal(
    await handler(workspace({ terms: duplicate }), undefined)(written("@docs/other.md"), ROOT),
    undefined,
  );
});

test("4.1 setting: a file without a terms key still reads its settings", async () => {
  const off = handler(workspace({ terms: "settings:\n  checkAfterEdit: false\n" }), {
    checkAfterEdit: true,
    diagnostics: [],
  });
  assert.equal(await off(written("@docs/other.md"), ROOT), undefined);
});

test("4.1 setting: before the configuration is read, the file setting still decides", async () => {
  const io = workspace({ terms: TERMS_ON });
  assert.deepEqual((await handler(io, undefined)(written("@docs/other.md"), ROOT))?.content, [
    block("Edited the file."),
    block(APPENDED_OTHER),
  ]);
});

test("4.3 target: one leading @, ~ and ~/ as the home directory, relative to the working directory", () => {
  assert.equal(targetPath("@docs/other.md", ROOT, HOME), "/repo/docs/other.md");
  assert.equal(targetPath("docs/other.md", ROOT, HOME), "/repo/docs/other.md");
  assert.equal(targetPath("/repo/docs/other.md", ROOT, HOME), "/repo/docs/other.md");
  assert.equal(targetPath("@~/notes.md", ROOT, HOME), "/home/u/notes.md");
  assert.equal(targetPath("~/notes.md", ROOT, HOME), "/home/u/notes.md");
  assert.equal(targetPath("~", ROOT, HOME), "/home/u");
  assert.equal(targetPath("@@docs/other.md", ROOT, HOME), "/repo/@docs/other.md");
});

test("4.3 target: each spelling of a document's path gives the check block", async () => {
  const io = workspace({ terms: TERMS_ON });
  for (const path of ["@docs/other.md", "docs/other.md", "/repo/docs/other.md"]) {
    const result = await handler(io, undefined)(written(path), ROOT);
    assert.deepEqual(result?.content, [block("Edited the file."), block(APPENDED_OTHER)], path);
  }
});

test("4.3 target: a relative path resolves against the working directory it is given", async () => {
  const io = workspace({ terms: TERMS_ON });
  assert.equal(await handler(io, undefined)(written("docs/other.md"), "/repo/docs"), undefined);
  const fromDocs = await handler(io, undefined)(written("other.md"), "/repo/docs");
  assert.deepEqual(fromDocs?.content, [block("Edited the file."), block(APPENDED_OTHER)]);
});

test("4.3 block: the header and one line per finding, in order", async () => {
  const io = workspace({ terms: TERMS_ON });
  const result = await handler(io, undefined)(written("docs/two.md"), ROOT);
  assert.deepEqual(result?.content, [
    block("Edited the file."),
    block(
      [
        "Terms check of docs/two.md: 2 findings",
        `docs/two.md:1:9 P001 ${P001}`,
        `docs/two.md:1:30 P001 ${P001}`,
      ].join("\n"),
    ),
  ]);
});

test("4.3 block: checkBlockText is the header and the finding texts", () => {
  assert.equal(
    checkBlockText("docs/other.md", [
      { path: "docs/other.md", line: 1, column: 9, code: "P001", message: P001 },
    ]),
    APPENDED_OTHER,
  );
});

test("4.3 block: a write is checked as an edit is", async () => {
  const io = workspace({ terms: TERMS_ON });
  const result = await handler(io, undefined)(written("docs/other.md", "write"), ROOT);
  assert.deepEqual(result?.content, [block("Edited the file."), block(APPENDED_OTHER)]);
});

test("4.3 unchanged: a failed result, another tool, or a path that is not a string", async () => {
  const io = workspace({ terms: TERMS_ON });
  const check = handler(io, undefined);
  assert.equal(await check({ ...written("docs/other.md"), isError: true }, ROOT), undefined);
  assert.equal(await check(written("docs/other.md", "read"), ROOT), undefined);
  assert.equal(await check(written(undefined), ROOT), undefined);
  assert.equal(await check(written(42), ROOT), undefined);
});

test("4.3 unchanged: a target outside the workspace, a non-document, and a document with no finding", async () => {
  const io = workspace({ terms: TERMS_ON });
  const check = handler(io, undefined);
  assert.equal(await check(written("/elsewhere/other.md"), ROOT), undefined);
  assert.equal(await check(written("~/notes.md"), ROOT), undefined);
  assert.equal(await check(written("docs/notes.txt"), ROOT), undefined);
  assert.equal(await check(written("docs/clean.md"), ROOT), undefined);
  assert.equal(await check(written("docs/missing.md"), ROOT), undefined);
});

test("4.3 unchanged: a finding a valid suppression comment suppresses", async () => {
  const io = workspace({ terms: TERMS_ON });
  assert.equal(await handler(io, undefined)(written("docs/suppressed.md"), ROOT), undefined);
});

test("4.3 unchanged: a target that is not a .md file is not looked at", async () => {
  // The workspace answers for these paths, so only the .md test keeps them unchecked.
  const io = workspace({
    terms: TERMS_ON,
    documents: { "docs/other.txt": OTHER, "docs/other.md.bak": OTHER },
  });
  const check = handler(io, undefined);
  assert.equal(await check(written("docs/other.txt"), ROOT), undefined);
  assert.equal(await check(written("docs/other.md.bak"), ROOT), undefined);
  assert.equal(await check(written("@~/notes.txt"), ROOT), undefined);
});

const run = promisify(execFile);

/** A fresh Git working tree in the system's temporary directory; its real path. */
async function newRepo(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-dent-terms-after-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await run("git", ["init", "-q"], { cwd: dir });
  return realpath(dir);
}

test("4.3 real workspace: a document is read by its literal path, a * in its name included", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, ".pi", "pi-dent"), { recursive: true });
  await writeFile(join(repo, ".pi", "pi-dent", "terms.yaml"), TERMS_ON);
  await writeFile(join(repo, "a*b.md"), "Use the html preview here.\n");
  await writeFile(join(repo, "aXb.md"), "Use the html preview there.\n");
  const check = handler(realWorkspace, undefined);

  assert.deepEqual((await check(written("a*b.md"), repo))?.content, [
    block("Edited the file."),
    block(`Terms check of a*b.md: 1 findings\na*b.md:1:9 P001 ${P001}`),
  ]);
  assert.deepEqual((await check(written("aXb.md"), repo))?.content, [
    block("Edited the file."),
    block(`Terms check of aXb.md: 1 findings\naXb.md:1:9 P001 ${P001}`),
  ]);

  // The pattern a*b.md matches aXb.md, but the literal path names no file of that name.
  await rm(join(repo, "a*b.md"));
  assert.equal(await check(written("a*b.md"), repo), undefined);
});

test("4.3 target: the target's directory is resolved through symbolic links", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-dent-terms-link-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const repo = join(fixture, "repo");
  await mkdir(join(repo, ".pi", "pi-dent"), { recursive: true });
  await run("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, ".pi", "pi-dent", "terms.yaml"), TERMS_ON);
  await writeFile(join(repo, "other.md"), OTHER);
  const link = join(fixture, "link");
  await symlink(await realpath(repo), link);

  const result = await handler(realWorkspace, undefined)(written("other.md"), link);
  assert.deepEqual(result?.content, [
    block("Edited the file."),
    block(`Terms check of other.md: 1 findings\nother.md:1:9 P001 ${P001}`),
  ]);
});

test("4.3 unchanged: a failure to run Git or to read the terms file", async () => {
  const check = handler(workspace({ terms: TERMS_ON, gitFails: true }), undefined);
  assert.equal(await check(written("@docs/other.md"), ROOT), undefined);

  const unreadable = handler(workspace({ terms: TERMS_ON, readFails: true }), undefined);
  assert.equal(await unreadable(written("@docs/other.md"), ROOT), undefined);
});
