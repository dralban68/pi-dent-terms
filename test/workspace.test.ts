import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import { runTerms } from "../lib/tool.ts";
import { TermsError, realWorkspace, workspacePathOf } from "../lib/workspace.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

/** A fresh Git working tree in the system's temporary directory; its real path. */
async function newRepo(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-dent-terms-ws-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q"]);
  return realpath(dir);
}

/** A fresh directory of the system's temporary directory, outside any Git working tree. */
async function outsideRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-dent-terms-plain-"));
}

test("Terms skips unavailable external owner files without treating them as workspace documents", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "terms-owners-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  await mkdir(root);
  await git(root, ["init", "-q"]);
  const owner = join(fixture, "owner.md");
  const deps = { cwd: root, io: realWorkspace, today: () => "2026-11-14" };
  const added = await runTerms(
    {
      action: "add",
      id: "remote-concept",
      label: "remote concept",
      meaning: "A remote concept.",
      owner: "../owner.md",
      group: "Remote",
      key: "local",
    },
    deps,
  );
  assert.equal(added.isError, false, added.text);
  const unavailable: Array<[string, () => Promise<unknown>]> = [
    ["missing", async () => {}],
    ["directory", () => mkdir(owner)],
    ["symlink", () => symlink(join(root, ".pi/pi-dent/terms.yaml"), owner)],
    ["invalid UTF-8", () => writeFile(owner, Buffer.from([0xff]))],
    ["NUL", () => writeFile(owner, "No matching label.\u0000")],
  ];
  for (const [kind, prepare] of unavailable) {
    await rm(owner, { recursive: true, force: true });
    await prepare();
    const result = await runTerms({ action: "check" }, deps);
    assert.equal(result.text, "0 findings · 0 documents · 1 entries", kind);
  }
  await writeFile(owner, "No matching label.\n");
  const unused = await runTerms({ action: "check" }, deps);
  assert.ok(
    unused.text.includes('T006 remote-concept: owner ../owner.md does not use "remote concept"'),
  );
  assert.match(unused.text, /1 findings · 0 documents · 1 entries/);
});

test("1.1 root: the top level of the working tree that contains the directory", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, "sub", "deeper"), { recursive: true });
  assert.equal(await realWorkspace.root(repo), repo);
  assert.equal(await realWorkspace.root(join(repo, "sub", "deeper")), repo);
});

test("2 root: a directory outside every Git working tree is the tool error", async () => {
  const plain = await outsideRepo();
  await assert.rejects(realWorkspace.root(plain), (error: unknown) => {
    assert.ok(error instanceof TermsError);
    assert.equal(error.message, `${plain} is not inside a Git working tree`);
    return true;
  });
  await rm(plain, { recursive: true, force: true });
});

test("2 root: a Git that cannot be started is `git failed`", async (t) => {
  const repo = await newRepo(t);
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent-pi-dent-terms-path";
  try {
    await assert.rejects(realWorkspace.root(repo), (error: unknown) => {
      assert.ok(error instanceof TermsError);
      assert.ok(error.message.startsWith("git failed: "), error.message);
      return true;
    });
  } finally {
    process.env.PATH = saved;
  }
});

test("2 abort: an aborted call ends its Git command and is a git failure", async (t) => {
  const repo = await newRepo(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(realWorkspace.documents(repo, controller.signal), (error: unknown) => {
    assert.ok(error instanceof TermsError);
    assert.ok(error.message.startsWith("git failed: "), error.message);
    return true;
  });
  const outcome = await runTerms(
    { action: "check" },
    { cwd: repo, io: realWorkspace, today: () => "2026-11-14", signal: controller.signal },
  );
  assert.equal(outcome.isError, true);
  assert.ok(outcome.text.startsWith("git failed: "), outcome.text);
});

test("2 git failure: the message is the first line of what Git wrote", async (t) => {
  const plain = await outsideRepo();
  t.after(() => rm(plain, { recursive: true, force: true }));
  await assert.rejects(realWorkspace.documents(plain), (error: unknown) => {
    assert.ok(error instanceof TermsError);
    assert.ok(error.message.startsWith("git failed: fatal:"), error.message);
    assert.equal(error.message.includes("\n"), false);
    return true;
  });
});

test("1.2 documents: the .md regular files git lists, valid and NUL-free, BOM stripped, sorted", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, "docs"), { recursive: true });
  await mkdir(join(repo, "sub"), { recursive: true });

  await writeFile(join(repo, "docs", "a.md"), "# A\n");
  await writeFile(join(repo, "sub", "nested.md"), "nested");
  await writeFile(join(repo, "note.txt"), "not markdown");
  await writeFile(join(repo, "ignored.md"), "ignored");
  await writeFile(join(repo, ".gitignore"), "ignored.md\n");
  await writeFile(join(repo, "b.md"), "bee");
  await writeFile(join(repo, "bom.md"), "\uFEFFtext");
  await writeFile(join(repo, "bad.md"), Buffer.from([0x61, 0xff]));
  await writeFile(join(repo, "nul.md"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(repo, "gone.md"), "gone");
  await symlink(join("docs", "a.md"), join(repo, "link.md"));
  await git(repo, ["add", "docs/a.md", "sub/nested.md", "gone.md"]);
  await unlink(join(repo, "gone.md"));

  const documents = await realWorkspace.documents(repo);
  assert.deepEqual(
    [...documents.entries()],
    [
      ["b.md", "bee"],
      ["bom.md", "text"],
      ["docs/a.md", "# A\n"],
      ["sub/nested.md", "nested"],
    ],
  );
});

test("1.2 documents: a file in a subdirectory of the root is listed with its workspace path", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, "deep", "er"), { recursive: true });
  await writeFile(join(repo, "deep", "er", "x.md"), "x");
  const documents = await realWorkspace.documents(repo);
  assert.deepEqual([...documents.keys()], ["deep/er/x.md"]);
});

test("1.2 documents: CRLF and a lone carriage return are kept as they are in the text", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, "eol.md"), "one\r\ntwo\rthree\n");
  const documents = await realWorkspace.documents(repo);
  assert.equal(documents.get("eol.md"), "one\r\ntwo\rthree\n");
});

test("2 readTerms: absent gives undefined; present gives the bytes; a directory is the tool error", async (t) => {
  const repo = await newRepo(t);
  assert.equal(await realWorkspace.readTerms(repo), undefined);

  await mkdir(join(repo, ".pi", "pi-dent"), { recursive: true });
  await writeFile(join(repo, ".pi", "pi-dent", "terms.yaml"), "terms: []\n");
  const bytes = await realWorkspace.readTerms(repo);
  assert.ok(bytes !== undefined);
  assert.equal(new TextDecoder().decode(bytes), "terms: []\n");

  await unlink(join(repo, ".pi", "pi-dent", "terms.yaml"));
  await mkdir(join(repo, ".pi", "pi-dent", "terms.yaml"));
  await assert.rejects(realWorkspace.readTerms(repo), (error: unknown) => {
    assert.ok(error instanceof TermsError);
    assert.equal(error.message, "cannot read .pi/pi-dent/terms.yaml: EISDIR");
    return true;
  });
});

test("2 writeTerms: creates the .pi and .pi/pi-dent directories and writes the text", async (t) => {
  const repo = await newRepo(t);
  await realWorkspace.writeTerms(repo, "terms: []\n");
  assert.equal(await readFile(join(repo, ".pi", "pi-dent", "terms.yaml"), "utf8"), "terms: []\n");
});

test("2 writeTerms: a symbolic link at the terms path is written through and kept", async (t) => {
  const repo = await newRepo(t);
  const target = join(repo, "shared-terms.yaml");
  await writeFile(target, "terms: []\n");
  await mkdir(join(repo, ".pi", "pi-dent"), { recursive: true });
  await symlink(target, join(repo, ".pi", "pi-dent", "terms.yaml"));

  await realWorkspace.writeTerms(repo, "settings: {}\nterms: []\n");

  assert.equal(await readFile(target, "utf8"), "settings: {}\nterms: []\n");
  const link = await lstat(join(repo, ".pi", "pi-dent", "terms.yaml"));
  assert.equal(link.isSymbolicLink(), true);
  assert.deepEqual(
    (await readdir(repo)).filter((name) => name.endsWith(".tmp")),
    [],
    "no new file is left behind",
  );
});

test("2 writeTerms: a failed write leaves the previous text and no new file", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes into a directory without its write permission");
    return;
  }
  const repo = await newRepo(t);
  const directory = join(repo, ".pi", "pi-dent");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "terms.yaml"), "terms: []\n");
  await chmod(directory, 0o555);
  try {
    await assert.rejects(
      realWorkspace.writeTerms(repo, "terms:\n  - id: x\n"),
      (error: unknown) => {
        assert.ok(error instanceof TermsError);
        assert.equal(error.message, "cannot write .pi/pi-dent/terms.yaml: EACCES");
        return true;
      },
    );
    assert.equal(await readFile(join(directory, "terms.yaml"), "utf8"), "terms: []\n");
    assert.deepEqual(await readdir(directory), ["terms.yaml"]);
  } finally {
    await chmod(directory, 0o755);
  }
});

test("2 writeTerms: a failed write is the tool error with the error code", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, ".pi"), "not a directory");
  await assert.rejects(realWorkspace.writeTerms(repo, "terms: []\n"), (error: unknown) => {
    assert.ok(error instanceof TermsError);
    assert.match(error.message, /^cannot write \.pi\/pi-dent\/terms\.yaml: E[A-Z]+$/);
    return true;
  });
});

test("2 readTerms: a .pi that is a regular file makes the terms file absent (ENOTDIR)", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, ".pi"), "not a directory");
  assert.equal(await realWorkspace.readTerms(repo), undefined);
});

test("2 workspace: with a .pi that is a regular file, find says there is no terms file and add fails writing it", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, ".pi"), "not a directory");
  await writeFile(join(repo, "view.md"), "How the rendered view looks.\n");
  const dependencies = { cwd: repo, io: realWorkspace, today: () => "2026-11-14" };
  assert.deepEqual(await runTerms({ action: "find", query: "term" }, dependencies), {
    isError: true,
    text: "no terms file at .pi/pi-dent/terms.yaml",
  });
  const added = await runTerms(
    {
      action: "add",
      id: "rendered-view",
      label: "rendered view",
      meaning: "How a document looks.",
      owner: "view.md",
      group: "Rendering",
      key: "confusable",
    },
    dependencies,
  );
  assert.equal(added.isError, true);
  assert.match(added.text, /^cannot write \.pi\/pi-dent\/terms\.yaml: E[A-Z]+$/);
});

test("imported external owners, code-span uses, local updates, and blank-line suppression compose through Terms", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-dent-terms-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(fixture, "sibling"));
  await git(root, ["init", "-q"]);
  await writeFile(join(fixture, "sibling/spec.md"), "`AskUserQuestion`\n");
  await writeFile(
    join(root, "docs/thesaurus.md"),
    "# Tools\n\n| Term | Meaning | Owner | Avoid or distinguish |\n| --- | --- | --- | --- |\n" +
      "| AskUserQuestion | A tool that asks the user. | [Owner](../../sibling/spec.md) | human prompt |\n",
  );
  await writeFile(
    join(root, "docs/request.md"),
    "`AskUserQuestion`\n\n<!-- terms-ignore P001: intentional -->\n\n# human prompt\n\n`human prompt`\n\nhuman prompt\n",
  );
  const deps = { cwd: root, io: realWorkspace, today: () => "2026-11-14" };
  const imported = await runTerms({ action: "import", path: "docs/thesaurus.md" }, deps);
  assert.equal(imported.isError, false, imported.text);
  assert.match(imported.text, /use update with addReject for specific phrases/);
  assert.ok(
    (await readFile(join(root, ".pi/pi-dent/terms.yaml"), "utf8")).includes(
      'owner: "../sibling/spec.md"',
    ),
  );
  const updated = await runTerms(
    { action: "update", id: "askuserquestion", key: "local", addReject: ["human prompt"] },
    deps,
  );
  assert.equal(updated.isError, false, updated.text);
  assert.match(updated.text, /^Updated askuserquestion/);
  assert.match(updated.text, /1 occurrences to edit/);
  assert.ok(updated.text.includes('docs/request.md:9:1 "human prompt"'));
  const checked = await runTerms({ action: "check" }, deps);
  assert.equal(checked.isError, false);
  assert.match(checked.text, /2 findings · 2 documents · 1 entries/);
  assert.ok(
    checked.text.includes(
      'T005 askuserquestion: "AskUserQuestion" is local but used by docs/request.md',
    ),
  );
  assert.ok(checked.text.includes("docs/request.md:9:1 P001"));
  assert.doesNotMatch(checked.text, /T003|T006|P002/);
  const reowned = await runTerms(
    { action: "reown", id: "askuserquestion", owner: "docs/request.md" },
    deps,
  );
  assert.equal(reowned.isError, false);
  const local = await runTerms({ action: "check" }, deps);
  assert.match(local.text, /1 findings · 2 documents · 1 entries/);
  assert.doesNotMatch(local.text, /T005|T006/);
});

test("1.1 workspacePathOf: a path below the root, with no empty, '.', or '..' segment", () => {
  assert.equal(workspacePathOf("/repo", "/repo/docs/a.md"), "docs/a.md");
  assert.equal(workspacePathOf("/repo", "/repo"), undefined);
  assert.equal(workspacePathOf("/repo", "/elsewhere/a.md"), undefined);
  assert.equal(workspacePathOf("/repo", "/repo/../a.md"), undefined);
});
