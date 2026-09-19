// `upstage init` — Task 7.10 of the 3.2.0 release plan.
//
// Thin CLI adapter over `generateUpstageMd()` (src/agent/init-generator.mjs)
// — the SAME generation logic the TUI's `/init` slash command
// (src/ui/commands.mjs) calls. This file owns only argv parsing and
// stdout/exit-code formatting; no generation logic lives here.

import { generateUpstageMd } from "../../agent/init-generator.mjs";
import { addChromeDevtoolsMcpEntry } from "../lib/mcp-template.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage init [--refresh] [--dry-run]",
      "",
      "Generates/updates a marked block in UPSTAGE.md from static analysis of the",
      "current project (package.json + intelligence index): Architecture, Entry",
      "Points, Important Directories, Build/Test/Lint/Typecheck, Runtime & Frameworks.",
      "",
      "Content outside the `<!-- upstage:generated:start/end -->` markers — including",
      "a hand-written UPSTAGE.md with no markers yet, which gets a block appended — is",
      "always preserved.",
      "",
      "Options:",
      "  --refresh            Force regeneration (documented no-op alias of the default —",
      "                       plain `upstage init` already always regenerates the block;",
      "                       see src/agent/init-generator.mjs for the reasoning)",
      "  --dry-run            Print the would-be generated content without writing to disk",
      "  --with-browser-mcp   Also add a chrome-devtools-mcp entry to .mcp.json (advanced",
      "                       browser debugging, beyond the native browser_* tools) —",
      "                       offered, never added without this flag"
    ].join("\n") + "\n"
  );
}

const ACTION_LABEL = {
  created: "Created UPSTAGE.md",
  updated: "Updated the generated block in UPSTAGE.md",
  appended: "Appended a new generated block to UPSTAGE.md"
};

// Pure formatters, split out from runInitCommand for the same reason
// doctor.mjs splits formatHuman/formatJson from runDoctorCommand: it lets
// tests assert on exact output text by feeding a `generateUpstageMd()`
// result straight in, without capturing this process's real stdout across
// runInitCommand's real async I/O (buildIntelligenceIndex/readFile/
// writeFile) — see tests/m33-doctor.test.mjs's own comment on why
// intercepting process.stdout.write across a real await is fragile in
// node --test's in-process runner, and tests/m33-init-generator.test.mjs
// for where this bit in practice while adding this file's test coverage.

/** Formats the --dry-run preview shown for a `{ dryRun: true }` generateUpstageMd() result. */
export function formatDryRunOutput(result) {
  return `--dry-run: would write ${result.path} (nothing written)\n\n${result.block}\n`;
}

/** Formats the one-line summary shown after a real (non-dry-run) write. */
export function formatWriteSummary(result) {
  return `${ACTION_LABEL[result.action] || `Wrote ${result.path}`} (${result.path})\n`;
}

/**
 * Router entry point (see src/cli/router.mjs). Exits 0 on success; a genuine
 * unexpected failure (e.g. an unwritable cwd) exits 1 with the error message
 * on stderr.
 */
export async function runInitCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const refresh = rest.includes("--refresh");
  const dryRun = rest.includes("--dry-run");
  const withBrowserMcp = rest.includes("--with-browser-mcp");

  try {
    const result = await generateUpstageMd({ cwd: process.cwd(), refresh, dryRun });
    process.stdout.write(dryRun ? formatDryRunOutput(result) : formatWriteSummary(result));

    if (withBrowserMcp && !dryRun) {
      const mcpResult = await addChromeDevtoolsMcpEntry(process.cwd());
      if (mcpResult.action !== "already-present") {
        process.stdout.write(`Added chrome-devtools-mcp to ${mcpResult.path}\n`);
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`upstage init: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
