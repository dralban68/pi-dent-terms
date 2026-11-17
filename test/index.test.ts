import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import piDentTerms from "../index.ts";

/** A host stand-in that records what the factory registers and the handlers it subscribes. */
function fakePi() {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers };
}

function context(cwd: string, notified: string[]) {
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notified.push(`${type ?? "info"}: ${message}`);
      },
    },
  };
  return ctx as unknown as ExtensionContext;
}

/** A directory holding a project layer whose `checkAfterEdit` is wrong, so it has a diagnostic. */
async function directoryWithBadConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-dent-terms-index-"));
  await mkdir(join(dir, ".pi", "pi-dent"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "pi-dent", "pi-dent.conf"),
    '{ "terms": { "checkAfterEdit": "yes" } }',
  );
  return dir;
}

/** Runs a body with the process working directory set to `dir`, restoring it afterwards. */
async function inDirectory(dir: string, body: () => Promise<void>): Promise<void> {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    await body();
  } finally {
    process.chdir(saved);
  }
}

const run = promisify(execFile);

/** A terms file with no setting of its own, whose entry rejects `html preview`. */
const TERMS = `terms:
  - id: rendered-view
    label: rendered view
    meaning: How a document looks once rendered.
    owner: other.md
    group: Rendering
    key: confusable
    status: active
    reject:
      - html preview
    history:
      - { date: 2026-01-02, op: add }
`;

const P001 = '"html preview" is rejected: use "rendered view" (rendered-view)';

test("1 wiring: the factory registers the Terms tool, and subscribes the session and result events", () => {
  const { pi, tools, handlers } = fakePi();
  piDentTerms(pi);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["Terms"],
  );
  assert.deepEqual([...handlers.keys()].toSorted(), ["session_start", "tool_result"]);
});

test("4.2 wiring: a diagnostic is reported once per instance, at its first session_start, as a warning", async () => {
  const cwd = await directoryWithBadConfig();
  await inDirectory(cwd, async () => {
    const { pi, handlers } = fakePi();
    piDentTerms(pi);
    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart !== undefined);

    const notified: string[] = [];
    const file = join(process.cwd(), ".pi", "pi-dent", "pi-dent.conf");
    const expected = `warning: pi-dent-terms: ${file}: terms.checkAfterEdit must be true or false`;
    sessionStart({ type: "session_start", reason: "startup" }, context(cwd, notified));
    sessionStart({ type: "session_start", reason: "reload" }, context(cwd, notified));
    assert.equal(notified.filter((message) => message === expected).length, 1);
    for (const message of notified)
      assert.ok(message.startsWith("warning: pi-dent-terms: "), message);
  });
  await rm(cwd, { recursive: true, force: true });
});

test("4.2 wiring: without a UI, session_start reads the configuration, so a later edit is checked", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dent-terms-index-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".pi", "pi-dent"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "pi-dent", "pi-dent.conf"),
    '{ "terms": { "checkAfterEdit": true } }',
  );
  await run("git", ["init", "-q"], { cwd: dir });
  await writeFile(join(dir, ".pi", "pi-dent", "terms.yaml"), TERMS);
  await writeFile(join(dir, "other.md"), "Use the html preview here.\n");
  const cwd = await realpath(dir);

  await inDirectory(cwd, async () => {
    const { pi, handlers } = fakePi();
    piDentTerms(pi);
    const sessionStart = handlers.get("session_start");
    const toolResult = handlers.get("tool_result");
    assert.ok(sessionStart !== undefined);
    assert.ok(toolResult !== undefined);

    const notified: string[] = [];
    const headless = { cwd, hasUI: false } as unknown as ExtensionContext;
    assert.doesNotThrow(() => sessionStart({ type: "session_start", reason: "startup" }, headless));
    assert.deepEqual(notified, []);

    // The terms file sets nothing, so only a configuration read at session_start turns the check on.
    const result = await toolResult(
      {
        toolName: "edit",
        input: { path: "other.md" },
        content: [{ type: "text", text: "Edited the file." }],
        isError: false,
      },
      context(cwd, notified),
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "Edited the file." },
        { type: "text", text: `Terms check of other.md: 1 findings\nother.md:1:9 P001 ${P001}` },
      ],
    });
  });
});

test("4.2 wiring: the configuration is read at the process working directory, not the session's", async () => {
  const project = await directoryWithBadConfig();
  const session = await mkdtemp(join(tmpdir(), "pi-dent-terms-session-"));
  await inDirectory(project, async () => {
    const { pi, handlers } = fakePi();
    piDentTerms(pi);
    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart !== undefined);

    const notified: string[] = [];
    sessionStart({ type: "session_start", reason: "startup" }, context(session, notified));
    const file = join(process.cwd(), ".pi", "pi-dent", "pi-dent.conf");
    assert.deepEqual(notified, [
      `warning: pi-dent-terms: ${file}: terms.checkAfterEdit must be true or false`,
    ]);
  });
  await rm(project, { recursive: true, force: true });
  await rm(session, { recursive: true, force: true });
});
