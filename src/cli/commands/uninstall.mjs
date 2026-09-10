// `upstage uninstall [--purge] [-y|--yes]` — Task 7.20 of the 3.2.0 release
// plan (§7.20 design detail).
//
// Scope discipline is the entire point of this command (see the plan's
// explicit failure-mode note), so every path this command can touch is
// resolved ONCE up front by `resolvePaths()`/`gatherUninstallPlan()` — pure,
// side-effect-free, fully overridable for tests — and the actual deletion
// step (`executePlan()`) does nothing but iterate that already-computed,
// already-printed list. There is no code path that decides what to delete
// AFTER the confirmation prompt has already been shown.
//
// Install-type detection is reused from src/cli/lib/install-type.mjs (not
// reimplemented), exactly like version.mjs/update.mjs/doctor.mjs:
//   - standalone -> owns its install directory + $BIN_DIR shim; both are
//     removed (this is the one branch that actually deletes real content).
//   - dev-link   -> owns ONLY the wrapper script in $BIN_DIR and the marker
//     file (both written by scripts/dev-link.sh(.ps1)) — NEVER the linked
//     repository itself (`installType.repoRoot`), which this command never
//     references as a deletion target anywhere below. See
//     tests/m33-uninstall.test.mjs's dedicated regression test for this.
//   - npm        -> owns nothing this command should delete (npm's own
//     node_modules tree is npm's to manage) — guidance only, and this
//     command never invokes npm as a child process on the user's behalf
//     (see `spawnFn` below, same DI pattern as update.mjs, for how that's
//     independently testable).
//   - unknown    -> guidance only, nothing removed.
//
// `--purge` is orthogonal to all of the above: it always additionally
// targets `~/.upstage/` (settings) and `~/.upstage-cli/sessions/` (session
// data, deliberately different directory name — see CLAUDE.md) regardless
// of install type, since upstage-cli itself always owns that state
// (unlike the binary/shim, whose ownership depends on how it was
// installed). Default (no --purge) never touches either.

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { detectInstallType, getDevLinkMarkerPath, getUpstageCliStateDir } from "../lib/install-type.mjs";

const NPM_PACKAGE = "@jackochesstern/upstage-cli";
const IS_WINDOWS = process.platform === "win32";

/** Resolves every path this command might touch. All overridable — tests
 *  always pass a fixture directory structure here, never the real
 *  ~/.local/bin, ~/.local/share/upstage-cli, ~/.upstage, or
 *  ~/.upstage-cli/sessions. */
export function resolvePaths(overrides = {}) {
  return {
    binDir: overrides.binDir || process.env.UPSTAGE_BIN_DIR || join(homedir(), ".local", "bin"),
    installDir: overrides.installDir || process.env.UPSTAGE_INSTALL_DIR || join(homedir(), ".local", "share", "upstage-cli"),
    markerPath: overrides.markerPath || getDevLinkMarkerPath(),
    settingsRoot: overrides.settingsRoot || join(homedir(), ".upstage"),
    sessionsRoot: overrides.sessionsRoot || join(getUpstageCliStateDir(), "sessions")
  };
}

/**
 * Builds the removal plan — a pure function of install type + resolved
 * paths + the --purge flag. Returns `{ guidance, paths }`, where `paths` is
 * every `{ label, path }` this run will actually delete (already scoped per
 * the rules in this file's header). Never touches the filesystem itself.
 */
export function gatherUninstallPlan({ installType, binDir, installDir, markerPath, settingsRoot, sessionsRoot, purge = false }) {
  const paths = [];
  let guidance;

  if (installType.type === "standalone") {
    paths.push({ label: "install directory", path: installDir });
    paths.push({ label: "bin shim", path: join(binDir, "upstage") });
    guidance = `Removing standalone binary install at ${installDir} and its shim at ${join(binDir, "upstage")}.`;
  } else if (installType.type === "dev-link") {
    const wrapperName = IS_WINDOWS ? "upstage.cmd" : "upstage";
    paths.push({ label: "dev-link wrapper", path: join(binDir, wrapperName) });
    paths.push({ label: "dev-link marker", path: markerPath });
    guidance = `This is a dev-link checkout (repo: ${installType.repoRoot}) — removing only the wrapper ` +
      `and marker; the linked repository is left untouched. (Equivalent to running scripts/dev-unlink.sh.)`;
  } else if (installType.type === "npm") {
    guidance = `This is an npm install (\`${NPM_PACKAGE}\`) — run \`npm uninstall -g ${NPM_PACKAGE}\` instead. ` +
      `This command does not manage npm-owned files.`;
  } else {
    guidance = "Could not determine how upstage-cli was installed — nothing removed.";
  }

  if (purge) {
    paths.push({ label: "settings (~/.upstage)", path: settingsRoot });
    paths.push({ label: "sessions (~/.upstage-cli/sessions)", path: sessionsRoot });
  }

  return { guidance, paths, installType };
}

async function confirm(promptText, { yes, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (yes) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${promptText} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Deletes every path in `plan.paths`. Best-effort per entry (a missing
 *  path is not an error — `force: true` — so a partially-completed prior
 *  run, or a dev-link install with no marker file, doesn't abort the rest
 *  of the plan). Returns the list of paths actually removed. */
function executePlan(plan) {
  const removed = [];
  for (const entry of plan.paths) {
    try {
      if (existsSync(entry.path)) {
        rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry);
      }
    } catch {
      // Best-effort — one failing entry must not abort the rest.
    }
  }
  return removed;
}

function printUsage() {
  process.stdout.write([
    "Usage: upstage uninstall [--purge] [-y|--yes]",
    "",
    "  Removes upstage-cli. Default scope depends on how it was installed:",
    "    standalone -> removes the install directory + $BIN_DIR shim",
    "    dev-link   -> removes the $BIN_DIR wrapper + dev-link marker only",
    "                  (never the linked repository)",
    "    npm        -> guidance only (`npm uninstall -g ...`); nothing removed",
    "",
    "  Default mode NEVER touches ~/.upstage/ (settings) or",
    "  ~/.upstage-cli/sessions/ (session data).",
    "",
    "Options:",
    "  --purge      Additionally remove ~/.upstage/ and ~/.upstage-cli/sessions/",
    "  -y, --yes    Skip the interactive confirmation prompt"
  ].join("\n") + "\n");
}

/** Router entry point. `installTypeOverride`/path overrides/`stdin`/`stdout`
 *  are all accepted for tests — production callers pass none of them and
 *  get the real environment. An `overrides.spawnFn` is accepted but
 *  intentionally never invoked by any branch below — every branch is pure
 *  print-and-delete against paths this command itself resolved, never a
 *  child process — so a test can inject a throwing stub there to
 *  independently verify "this command never invokes npm as a child
 *  process", the same DI pattern update.mjs uses for its own npm branch. */
export async function runUninstallCommand(rest = [], overrides = {}) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const purge = rest.includes("--purge");
  const yes = rest.includes("-y") || rest.includes("--yes");
  const installType = overrides.installTypeOverride || detectInstallType();
  const paths = resolvePaths(overrides);

  const plan = gatherUninstallPlan({ installType, ...paths, purge });
  process.stdout.write(`${plan.guidance}\n`);

  if (plan.paths.length === 0) {
    return 0;
  }

  process.stdout.write("The following will be removed:\n");
  for (const entry of plan.paths) {
    process.stdout.write(`  ${entry.label}: ${entry.path}\n`);
  }

  const confirmed = await confirm("Proceed?", { yes, stdin: overrides.stdin, stdout: overrides.stdout });
  if (!confirmed) {
    process.stdout.write("Aborted — nothing removed.\n");
    return 0;
  }

  const removed = executePlan(plan);
  process.stdout.write(
    removed.length > 0
      ? `Removed ${removed.length} item${removed.length === 1 ? "" : "s"}.\n`
      : "Nothing found to remove.\n"
  );
  return 0;
}
