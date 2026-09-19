// `upstage version` / `upstage --version` — Task 12.9 of the 3.2.0 release
// plan (§6 command tree, §7.V design detail).
//
// `package.json`'s `version` field is the single source of truth for the
// CLI's own version — read fresh on every call (never cached at module load)
// so a test can point `pkgPath` at a fixture file with a controlled value.
//
// `--verbose` adds five fields, each best-effort (never throws the whole
// command if one is unavailable):
//   - commit hash: `git rev-parse HEAD`, only attempted when `isGitRepo(cwd)`
//     (reused from src/core/worktree.mjs, not reimplemented) — `cwd` here is
//     the CLI's OWN source location (REPO_ROOT), not process.cwd(), since
//     this reports which commit of upstage-cli's source is running, not
//     whether the user's project happens to be a git repo (that's `doctor`'s
//     "Project" section's job).
//   - build date: this is a zero-build-step project (see CLAUDE.md) — there
//     is no compile timestamp to report. The most honest available proxy is
//     package.json's own mtime (it's the version source of truth, and is
//     touched at release time by `npm version`/the release workflow).
//   - install type: reused from src/cli/lib/install-type.mjs, not
//     reimplemented (per that module's own docstring, which names this task
//     as one of its intended consumers).
//   - runtime: Bun.version when running under Bun, else process.version.
//   - platform: process.platform/process.arch.

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isGitRepo } from "../../core/worktree.mjs";
import { detectInstallType } from "../lib/install-type.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_PKG_PATH = join(REPO_ROOT, "package.json");

/** Reads and parses package.json. Exported so `update.mjs` can reuse it
 *  rather than re-reading/re-parsing the file itself. */
export function readPackageJson(pkgPath = DEFAULT_PKG_PATH) {
  const raw = readFileSync(pkgPath, "utf8");
  return JSON.parse(raw);
}

function getCommitHash(cwd) {
  if (!isGitRepo(cwd)) return null;
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function getBuildDate(pkgPath) {
  try {
    return statSync(pkgPath).mtime.toISOString();
  } catch {
    return null;
  }
}

function getRuntime() {
  return globalThis.Bun?.version ? `Bun ${globalThis.Bun.version}` : `Node ${process.version}`;
}

function formatInstallType(info) {
  return info.type === "dev-link" ? `dev-link (${info.repoRoot})` : info.type;
}

/**
 * Builds the version report. `cwd`/`pkgPath`/`installTypeOverride` are all
 * overridable for tests — defaults are the CLI's own real source location
 * and package.json.
 */
export function gatherVersionInfo({
  cwd = REPO_ROOT,
  pkgPath = DEFAULT_PKG_PATH,
  verbose = false,
  installTypeOverride
} = {}) {
  const pkg = readPackageJson(pkgPath);
  const info = { name: "upstage-cli", version: pkg.version || "unknown" };
  if (!verbose) return info;

  info.commit = getCommitHash(cwd);
  info.buildDate = getBuildDate(pkgPath);
  info.installType = formatInstallType(installTypeOverride || detectInstallType());
  info.runtime = getRuntime();
  info.platform = `${process.platform}/${process.arch}`;
  return info;
}

export function formatHuman(info, verbose) {
  if (!verbose) return `upstage-cli ${info.version}\n`;
  return [
    `upstage-cli ${info.version}`,
    `commit: ${info.commit || "unknown (not a git checkout)"}`,
    `build date: ${info.buildDate || "unknown"}`,
    `install type: ${info.installType}`,
    `runtime: ${info.runtime}`,
    `platform: ${info.platform}`
  ].join("\n") + "\n";
}

export function formatJson(info) {
  return `${JSON.stringify(info, null, 2)}\n`;
}

function printUsage() {
  process.stdout.write([
    "Usage: upstage version [--verbose] [--json]",
    "",
    "  Prints `upstage-cli <version>` (from package.json) by default.",
    "  --verbose adds commit hash, build date, install type, runtime, and platform.",
    "",
    "Options:",
    "  --verbose   Include commit/build/install-type/runtime/platform detail",
    "  --json      Output as JSON"
  ].join("\n") + "\n");
}

/** Router entry point. Always exits 0 — reading a version report never
 *  itself constitutes a command failure (an unreadable git/package.json
 *  degrades individual fields to null/"unknown" rather than throwing). */
export async function runVersionCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }
  const verbose = rest.includes("--verbose");
  const json = rest.includes("--json");
  const info = gatherVersionInfo({ verbose });
  process.stdout.write(json ? formatJson(info) : formatHuman(info, verbose));
  return 0;
}
