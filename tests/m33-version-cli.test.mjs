import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readPackageJson,
  gatherVersionInfo,
  formatHuman,
  formatJson,
  runVersionCommand
} from "../src/cli/commands/version.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_DIR, "..");
const REAL_PKG_PATH = join(REPO_ROOT, "package.json");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-version-cli-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureStdout(run) {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try {
    run();
  } finally {
    process.stdout.write = orig;
  }
  return out.join("");
}

// --- readPackageJson / gatherVersionInfo (non-verbose) ---

test("readPackageJson reads version from a fixture package.json", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ version: "9.9.9" }));
    assert.equal(readPackageJson(pkgPath).version, "9.9.9");
  });
});

test("gatherVersionInfo non-verbose returns only {name, version} — no extra fields", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ version: "1.2.3" }));
    const info = gatherVersionInfo({ pkgPath, verbose: false });
    assert.deepEqual(info, { name: "upstage-cli", version: "1.2.3" });
  });
});

test("gatherVersionInfo reads the real repo's package.json by default", () => {
  const realPkg = readPackageJson(REAL_PKG_PATH);
  const info = gatherVersionInfo({ verbose: false });
  assert.equal(info.version, realPkg.version);
});

// --- gatherVersionInfo (verbose) ---

test("gatherVersionInfo verbose adds commit/buildDate/installType/runtime/platform", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ version: "1.0.0" }));
    const info = gatherVersionInfo({
      pkgPath,
      cwd: dir, // not a git repo -> commit should be null
      verbose: true,
      installTypeOverride: { type: "npm" }
    });
    assert.equal(info.version, "1.0.0");
    assert.equal(info.commit, null);
    assert.match(info.buildDate, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(info.installType, "npm");
    assert.match(info.runtime, /^(Bun|Node) /);
    assert.equal(info.platform, `${process.platform}/${process.arch}`);
  });
});

test("gatherVersionInfo verbose reports a real commit hash when cwd IS a git repo (this worktree)", () => {
  const info = gatherVersionInfo({ cwd: REPO_ROOT, verbose: true, installTypeOverride: { type: "unknown" } });
  assert.match(info.commit, /^[0-9a-f]{40}$/);
});

test("gatherVersionInfo verbose formats dev-link install type with its repoRoot", () => {
  const info = gatherVersionInfo({
    cwd: REPO_ROOT,
    verbose: true,
    installTypeOverride: { type: "dev-link", repoRoot: "/home/user/upstage-cli", linkedAt: null }
  });
  assert.equal(info.installType, "dev-link (/home/user/upstage-cli)");
});

// --- formatHuman / formatJson (pure) ---

test("formatHuman non-verbose is exactly 'upstage-cli <version>\\n'", () => {
  assert.equal(formatHuman({ name: "upstage-cli", version: "3.2.0" }, false), "upstage-cli 3.2.0\n");
});

test("formatHuman verbose includes every labeled field", () => {
  const text = formatHuman({
    version: "3.2.0",
    commit: "abc123",
    buildDate: "2026-09-10T00:00:00.000Z",
    installType: "standalone",
    runtime: "Bun 1.3.0",
    platform: "linux/x64"
  }, true);
  assert.match(text, /^upstage-cli 3\.2\.0\n/);
  assert.match(text, /commit: abc123/);
  assert.match(text, /build date: 2026-09-10T00:00:00\.000Z/);
  assert.match(text, /install type: standalone/);
  assert.match(text, /runtime: Bun 1\.3\.0/);
  assert.match(text, /platform: linux\/x64/);
});

test("formatHuman verbose falls back to explanatory text for a null commit", () => {
  const text = formatHuman({ version: "1.0.0", commit: null, buildDate: null, installType: "unknown", runtime: "Node v24", platform: "win32/x64" }, true);
  assert.match(text, /commit: unknown \(not a git checkout\)/);
  assert.match(text, /build date: unknown/);
});

test("formatJson round-trips the info object", () => {
  const info = { name: "upstage-cli", version: "3.2.0" };
  assert.deepEqual(JSON.parse(formatJson(info)), info);
});

// --- runVersionCommand (CLI entry point) ---

test("runVersionCommand with no flags prints 'upstage-cli <version>' and returns 0", async () => {
  const pkg = readPackageJson(REAL_PKG_PATH);
  const out = captureStdout(() => { runVersionCommand([]); });
  // runVersionCommand is async but does no real await internally (pure
  // sync fs/child_process calls) — see version.mjs — so its body completes
  // synchronously within this capture window.
  assert.equal(out, `upstage-cli ${pkg.version}\n`);
});

test("runVersionCommand returns 0", async () => {
  const code = await runVersionCommand([]);
  assert.equal(code, 0);
});

test("runVersionCommand --verbose includes all verbose fields", async () => {
  const out = captureStdout(() => { runVersionCommand(["--verbose"]); });
  assert.match(out, /commit:/);
  assert.match(out, /build date:/);
  assert.match(out, /install type:/);
  assert.match(out, /runtime:/);
  assert.match(out, /platform:/);
});

test("runVersionCommand --json prints valid, parseable JSON", async () => {
  const out = captureStdout(() => { runVersionCommand(["--json"]); });
  const parsed = JSON.parse(out);
  assert.equal(parsed.name, "upstage-cli");
  assert.ok(typeof parsed.version === "string" && parsed.version.length > 0);
});

test("runVersionCommand -h / --help prints usage and returns 0, without touching version info", async () => {
  const out = captureStdout(() => { runVersionCommand(["--help"]); });
  assert.match(out, /Usage: upstage version/);
  const code = await runVersionCommand(["-h"]);
  assert.equal(code, 0);
});

// --- `upstage --version` top-level flag wiring (Task 12.9 / §7.V) ---

test("`upstage --version` (top-level flag) prints the exact same output as `upstage version`", () => {
  const pkg = readPackageJson(REAL_PKG_PATH);
  const output = execFileSync(process.execPath, [CLI_ENTRY, "--version"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 20000
  });
  assert.equal(output, `upstage-cli ${pkg.version}\n`);
});
