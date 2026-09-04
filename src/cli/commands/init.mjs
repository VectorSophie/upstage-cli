// `upstage init` — Task 7.10 of the 3.2.0 release plan.
//
// Thin CLI adapter over `generateUpstageMd()` (src/agent/init-generator.mjs)
// — the SAME generation logic the TUI's `/init` slash command
// (src/ui/commands.mjs) calls. This file owns only argv parsing and
// stdout/exit-code formatting; no generation logic lives here.

import { generateUpstageMd } from "../../agent/init-generator.mjs";

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
      "  --refresh    Force regeneration (documented no-op alias of the default —",
      "               plain `upstage init` already always regenerates the block;",
      "               see src/agent/init-generator.mjs for the reasoning)",
      "  --dry-run    Print the would-be generated content without writing to disk"
    ].join("\n") + "\n"
  );
}

const ACTION_LABEL = {
  created: "Created UPSTAGE.md",
  updated: "Updated the generated block in UPSTAGE.md",
  appended: "Appended a new generated block to UPSTAGE.md"
};

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

  try {
    const result = await generateUpstageMd({ cwd: process.cwd(), refresh, dryRun });

    if (dryRun) {
      process.stdout.write(`--dry-run: would write ${result.path} (nothing written)\n\n`);
      process.stdout.write(`${result.block}\n`);
      return 0;
    }

    process.stdout.write(`${ACTION_LABEL[result.action] || `Wrote ${result.path}`} (${result.path})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`upstage init: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
