// `upstage skills install` — Task 7.9 of the 3.2.0 release plan.
//
// Copies this repository's first-party `upstage-utilities` skill
// (skills/upstage-utilities/SKILL.md, source of truth — see that file's own
// header) into one or more on-disk skill directories that `SkillsLoader`
// (src/skills/loader.mjs) or an interoperable agent harness would pick up.
//
// This command does NOT regenerate the skill's content from a template
// string — it copies the source file's bytes verbatim, so the installed
// copy and skills/upstage-utilities/SKILL.md (the file a human/reviewer
// actually edits) can never drift apart. See that file for the skill's
// actual content/frontmatter.
//
// DEFAULT DESTINATIONS (no --target): BOTH of
//   <cwd>/.upstage/skills/upstage-utilities/SKILL.md  — this repo's own
//     first-party, project-local convention. SkillsLoader's SEARCH_DIRS
//     checks this FIRST, ahead of .claude/skills/, so an install here is
//     also the copy most likely to win over the package-bundled fallback
//     that already ships at skills/upstage-utilities/SKILL.md.
//   <cwd>/.claude/skills/upstage-utilities/SKILL.md   — the interop
//     convention: per this plan's own research, several other agent
//     harnesses (Claude Code, and OpenCode confirmed) read this exact
//     directory identically, no per-target templating needed.
// Installing to both by default costs two small file writes and covers
// "this repo's own convention" and "the convention other agents read" at
// once, per the task's framing. `--target` narrows this to exactly one.
//
// --target <name>: installs to ONLY the named target instead of the default
// pair (LIMITS, not adds — a caller who names one target most likely wants
// exactly that one, not extra unrequested writes elsewhere). A small
// hardcoded map (TARGETS below), not general "agent detection" — this
// codebase has no infrastructure for detecting other agents' install
// locations yet, and inventing it here would be scope creep on this task:
//   claude  -> .claude/skills/upstage-utilities/SKILL.md
//   upstage -> .upstage/skills/upstage-utilities/SKILL.md
//
// IDEMPOTENCY / USER-CONTENT PROTECTION (installOne, below):
// - Destination missing entirely -> create directories + write; "created".
// - Destination exists with content byte-identical to the canonical source
//   -> overwrite anyway (a functional no-op) and report "unchanged" — keeps
//   re-running trivially safe, no duplication, no error.
// - Destination exists with DIFFERENT content (hand-edited by a user, or an
//   older generated version) -> print a warning to stderr — the task's own
//   "a simple content-diff check is enough, not a full merge" allowance, so
//   this only reports that + how much the two differ (byte lengths), not a
//   line-by-line diff — and then STILL overwrites with the canonical
//   content. A non-interactive CLI has no prompt to block on; leaving a
//   stale/conflicting file in place with no way to reconcile it short of
//   deleting it by hand would be worse than a loud warning plus a
//   deterministic outcome. Reports "overwritten" in that case, distinct
//   from "unchanged", so a caller/test can tell the two apart.
//
// EXIT CODES: 0 for every completed install (created/unchanged/overwritten
// alike) — the warning is surfaced via stderr text and the per-target
// "status" field, not via a different exit code, following the exact
// precedent already established by src/cli/commands/doctor.mjs
// ("Individual checks may report warn/fail — this never affects the
// command's own exit code"). 2 for a genuine usage error (unknown --target
// name) before any file I/O is attempted. 1 for a genuinely unexpected
// failure (e.g. the bundled source file itself can't be read).

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "upstage-utilities";

// Package-bundled source of truth — same relationship SkillsLoader's
// PACKAGE_SKILLS_DIR has to the package root (sibling `skills/` dir to
// `src/`; this file is one directory deeper, under src/cli/commands/, hence
// one extra "../" versus loader.mjs's own PACKAGE_SKILLS_DIR).
const PRIMARY_SOURCE_PATH = fileURLToPath(
  new URL(`../../../skills/${SKILL_NAME}/SKILL.md`, import.meta.url)
);

// A `bun build --compile` standalone executable has no real on-disk location
// for import.meta.url (see loader.mjs's own comment on this) — same
// fallback convention: a `skills/` dir shipped alongside the executable.
function fallbackSourcePath() {
  return join(dirname(process.execPath), "skills", SKILL_NAME, "SKILL.md");
}

function resolveSourcePath() {
  if (existsSync(PRIMARY_SOURCE_PATH)) return PRIMARY_SOURCE_PATH;
  return fallbackSourcePath();
}

const TARGETS = {
  upstage: (cwd) => join(cwd, ".upstage", "skills", SKILL_NAME, "SKILL.md"),
  claude: (cwd) => join(cwd, ".claude", "skills", SKILL_NAME, "SKILL.md")
};

const DEFAULT_TARGET_NAMES = ["upstage", "claude"];

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage skills install [--target claude|upstage] [--json]",
      "",
      "Installs the first-party `upstage-utilities` skill (teaches an agent to prefer",
      "shelling out to `upstage parse/ocr/extract/schema/classify/embed/groundedness`",
      "over reimplementing Upstage API calls itself) into on-disk skill director(y/ies).",
      "",
      "By default, installs to BOTH known targets: .upstage/skills/ (this repo's own",
      "convention) and .claude/skills/ (the interop convention other agent harnesses",
      "read identically).",
      "",
      "Re-running is idempotent: an installed copy that exactly matches the canonical",
      "source is left byte-identical (\"unchanged\"); a hand-edited or outdated copy is",
      "still overwritten, but only after printing a warning to stderr.",
      "",
      "Options:",
      `  --target <name>   Install to only this target instead of the default pair.`,
      `                    One of: ${Object.keys(TARGETS).join(", ")}`,
      "  --json            Output a machine-readable summary (one object per target) as JSON"
    ].join("\n") + "\n"
  );
}

/** Reads the canonical source skill content. Exported for tests. */
export function readSourceContent() {
  return readFileSync(resolveSourcePath(), "utf8");
}

/**
 * Installs the canonical skill content at one destination path.
 * Returns `{ path, status }` where status is "created" | "unchanged" | "overwritten".
 * Never throws on a content mismatch — writes a warning to stderr instead
 * (see this file's header for the reasoning) and proceeds to overwrite.
 */
export function installOne(destPath, sourceContent) {
  if (existsSync(destPath)) {
    const existing = readFileSync(destPath, "utf8");
    if (existing === sourceContent) {
      writeFileSync(destPath, sourceContent, "utf8");
      return { path: destPath, status: "unchanged" };
    }
    process.stderr.write(
      `upstage skills install: ${destPath} already exists with different content ` +
        `(${existing.length} bytes on disk vs ${sourceContent.length} bytes generated) — ` +
        "overwriting with the canonical upstage-utilities skill. If you hand-edited this " +
        "file and want to keep those edits, save a copy before re-running.\n"
    );
    writeFileSync(destPath, sourceContent, "utf8");
    return { path: destPath, status: "overwritten" };
  }
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, sourceContent, "utf8");
  return { path: destPath, status: "created" };
}

export function formatHuman(results) {
  return results.map((r) => `${r.status}: ${r.path}`).join("\n") + "\n";
}

export async function runSkillsInstallCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const json = rest.includes("--json");

  let targetNames = DEFAULT_TARGET_NAMES;
  const targetIdx = rest.indexOf("--target");
  if (targetIdx !== -1) {
    const targetName = rest[targetIdx + 1];
    if (!targetName || targetName.startsWith("--") || !Object.prototype.hasOwnProperty.call(TARGETS, targetName)) {
      process.stderr.write(
        `upstage skills install: --target must be one of ${Object.keys(TARGETS).join("|")}, got "${targetName ?? ""}"\n`
      );
      return 2;
    }
    targetNames = [targetName];
  }

  let sourceContent;
  try {
    sourceContent = readSourceContent();
  } catch (err) {
    process.stderr.write(
      `upstage skills install: could not read the bundled upstage-utilities skill: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  }

  const cwd = process.cwd();
  const results = targetNames.map((name) => installOne(TARGETS[name](cwd), sourceContent));

  process.stdout.write(json ? JSON.stringify(results) : formatHuman(results));
  return 0;
}
