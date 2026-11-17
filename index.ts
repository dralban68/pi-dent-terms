/**
 * pi-dent-terms - see specs/.
 *
 * Wiring only: every building block lives in lib/ (specs/terms-tool.md, Sections 1 and 4).
 */

import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAfterEdit } from "./lib/after-edit.ts";
import { loadTermsConfig, type TermsConfig } from "./lib/config.ts";
import { createTermsTool } from "./lib/tool.ts";
import { realWorkspace } from "./lib/workspace.ts";

export default function piDentTerms(pi: ExtensionAPI): void {
  // Read once per extension instance, at its first session_start (specs/terms-tool.md, 4.2).
  // The project layer is `<cwd>` of the process (pi-dent's config-file.md, Section 1), not the session's.
  let config: TermsConfig | undefined;

  pi.registerTool(createTermsTool(realWorkspace));

  const afterEdit = createAfterEdit({
    io: realWorkspace,
    homeDir: homedir(),
    config: () => config,
  });

  pi.on("session_start", (_event, ctx) => {
    if (config !== undefined) return;
    config = loadTermsConfig({ cwd: process.cwd() });
    if (!ctx.hasUI) return;
    for (const message of config.diagnostics) {
      ctx.ui.notify(`pi-dent-terms: ${message}`, "warning");
    }
  });

  pi.on("tool_result", (event, ctx) => afterEdit(event, ctx.cwd));
}
