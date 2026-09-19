import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PassThrough } from "node:stream";

import {
  resolvePaths,
  gatherUninstallPlan,
  runUninstallCommand
} from "../src/cli/commands/uninstall.mjs";

async function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-uninstall-"));
  const binDir = join(dir, "bin");
  const installDir = join(dir, "install");
  const settingsRoot = join(dir, "settings");
  const sessionsRoot = join(dir, "sessions");
  const repoDir = join(dir, "repo"); // stands in for a dev-link's linked repository
  mkdirSync(binDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(settingsRoot, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(join(installDir, "upstage"), "binary");
  writeFileSync(join(installDir, "skills-marker.txt"), "skills"); // extra file — proves recursive removal
  writeFileSync(join(binDir, "upstage"), "shim");
  writeFileSync(join(settingsRoot, "settings.json"), "{}");
  writeFileSync(join(sessionsRoot, "session-a.json"), "{}");
  writeFileSync(join(repoDir, "package.json"), "{}"); // stand-in repo content

  const markerPath = join(dir, "dev-link.json");

  try {
    return await run({ dir, binDir, installDir, settingsRoot, sessionsRoot, repoDir, markerPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// NOTE: `spawnFn` is passed below to show the override is harmless, but
// runUninstallCommand() never destructures or reads `spawnFn` from its
// options object — so passing it (even a throwing stub) does not exercise
// any interception mechanism and provides no regression guard against a
// future node:child_process call being added to uninstall.mjs. What the
// test using it actually checks is stdout content and filesystem state;
// "no child_process usage" is established separately by reading
// uninstall.mjs's imports (see that file's header comment), not by
// anything here.
function throwingSpawn() {
  throw new Error("spawnFn should never be called");
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

// --- resolvePaths ---

test("resolvePaths honors explicit overrides over env/home defaults", () => {
  const paths = resolvePaths({ binDir: "/x/bin", installDir: "/x/install", markerPath: "/x/marker.json", settingsRoot: "/x/settings", sessionsRoot: "/x/sessions" });
  assert.deepEqual(paths, {
    binDir: "/x/bin", installDir: "/x/install", markerPath: "/x/marker.json",
    settingsRoot: "/x/settings", sessionsRoot: "/x/sessions"
  });
});

// --- gatherUninstallPlan (pure) ---

test("gatherUninstallPlan for a standalone install targets the install directory + bin shim only (no purge)", () => {
  const plan = gatherUninstallPlan({
    installType: { type: "standalone" },
    binDir: "/bin", installDir: "/install", markerPath: "/marker.json",
    settingsRoot: "/settings", sessionsRoot: "/sessions", purge: false
  });
  const targeted = plan.paths.map((p) => p.path);
  // installDir/settingsRoot/sessionsRoot are used AS-IS by gatherUninstallPlan
  // (no path.join applied) — only the bin shim/wrapper are `join(binDir, ...)`'d.
  assert.ok(targeted.includes("/install"));
  assert.ok(targeted.some((p) => dirname(p) === join("/bin")));
  assert.equal(targeted.includes("/settings"), false);
  assert.equal(targeted.includes("/sessions"), false);
});

test("gatherUninstallPlan for a dev-link install targets ONLY the bin wrapper + marker — never installType.repoRoot", () => {
  const plan = gatherUninstallPlan({
    installType: { type: "dev-link", repoRoot: "/home/user/upstage-cli", linkedAt: null },
    binDir: "/bin", installDir: "/install", markerPath: "/marker.json",
    settingsRoot: "/settings", sessionsRoot: "/sessions", purge: false
  });
  const targeted = plan.paths.map((p) => p.path);
  assert.equal(targeted.length, 2);
  assert.ok(targeted.some((p) => dirname(p) === join("/bin")));
  assert.ok(targeted.includes("/marker.json"));
  assert.equal(targeted.includes("/home/user/upstage-cli"), false);
  // The guidance text may mention the repo path (context), but only in an
  // "is left untouched" framing — never as a thing this run will remove.
  assert.match(plan.guidance, /left untouched/i);
});

test("gatherUninstallPlan for an npm install targets nothing (guidance only)", () => {
  const plan = gatherUninstallPlan({
    installType: { type: "npm" },
    binDir: "/bin", installDir: "/install", markerPath: "/marker.json",
    settingsRoot: "/settings", sessionsRoot: "/sessions", purge: false
  });
  assert.deepEqual(plan.paths, []);
  assert.match(plan.guidance, /npm uninstall -g @jackochesstern\/upstage-cli/);
});

test("gatherUninstallPlan for an unknown install type targets nothing", () => {
  const plan = gatherUninstallPlan({
    installType: { type: "unknown" },
    binDir: "/bin", installDir: "/install", markerPath: "/marker.json",
    settingsRoot: "/settings", sessionsRoot: "/sessions", purge: false
  });
  assert.deepEqual(plan.paths, []);
});

test("gatherUninstallPlan --purge adds settings + sessions regardless of install type (npm included)", () => {
  const plan = gatherUninstallPlan({
    installType: { type: "npm" },
    binDir: "/bin", installDir: "/install", markerPath: "/marker.json",
    settingsRoot: "/settings", sessionsRoot: "/sessions", purge: true
  });
  const targeted = plan.paths.map((p) => p.path);
  assert.ok(targeted.includes("/settings"));
  assert.ok(targeted.includes("/sessions"));
});

// --- runUninstallCommand: standalone (the one branch that actually deletes) ---

test("uninstalling a fixture standalone-binary install leaves zero files behind (default mode)", async () => {
  await withFixture(async ({ binDir, installDir, settingsRoot, sessionsRoot }) => {
    const code = await runUninstallCommand(["-y"], {
      installTypeOverride: { type: "standalone" },
      binDir, installDir, settingsRoot, sessionsRoot
    });
    assert.equal(code, 0);
    assert.equal(existsSync(installDir), false);
    assert.equal(existsSync(join(binDir, "upstage")), false);
  });
});

test("default mode (no --purge) leaves ~/.upstage/ settings and ~/.upstage-cli/sessions/ untouched", async () => {
  await withFixture(async ({ binDir, installDir, settingsRoot, sessionsRoot }) => {
    await runUninstallCommand(["-y"], {
      installTypeOverride: { type: "standalone" },
      binDir, installDir, settingsRoot, sessionsRoot
    });
    assert.equal(existsSync(settingsRoot), true);
    assert.equal(existsSync(sessionsRoot), true);
    assert.equal(existsSync(join(settingsRoot, "settings.json")), true);
    assert.equal(existsSync(join(sessionsRoot, "session-a.json")), true);
  });
});

test("--purge additionally removes ~/.upstage/ and ~/.upstage-cli/sessions/", async () => {
  await withFixture(async ({ binDir, installDir, settingsRoot, sessionsRoot }) => {
    const code = await runUninstallCommand(["-y", "--purge"], {
      installTypeOverride: { type: "standalone" },
      binDir, installDir, settingsRoot, sessionsRoot
    });
    assert.equal(code, 0);
    assert.equal(existsSync(installDir), false);
    assert.equal(existsSync(join(binDir, "upstage")), false);
    assert.equal(existsSync(settingsRoot), false);
    assert.equal(existsSync(sessionsRoot), false);
  });
});

// --- runUninstallCommand: npm (guidance only, no deletion, no child process) ---

test("uninstalling a fixture npm install prints guidance and deletes nothing (an unused spawnFn override is also passed, but has no effect)", async () => {
  await withFixture(async ({ binDir, installDir, settingsRoot, sessionsRoot }) => {
    let stdout = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
    let code;
    try {
      code = await runUninstallCommand(["-y"], {
        installTypeOverride: { type: "npm" },
        binDir, installDir, settingsRoot, sessionsRoot,
        spawnFn: throwingSpawn
      });
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(code, 0);
    assert.match(stdout, /npm uninstall -g @jackochesstern\/upstage-cli/);
    // installDir/binDir belong to a DIFFERENT (standalone) install type in
    // this scenario and must be left completely alone by the npm branch.
    assert.equal(existsSync(installDir), true);
    assert.equal(existsSync(join(binDir, "upstage")), true);
    // spawnFn is passed above but is never read by runUninstallCommand, so
    // it cannot fire regardless of what this branch does — this assertion
    // checks stdout content and filesystem state only, not child-process
    // usage. See uninstall.mjs's header comment for how "no child_process
    // import" is actually established (source inspection, not this test).
  });
});

// --- runUninstallCommand: dev-link (scope-safety regression — the repo must survive) ---

test("uninstalling a fixture dev-link install removes ONLY the wrapper + marker, and NEVER deletes the linked repository", async () => {
  await withFixture(async ({ binDir, settingsRoot, sessionsRoot, repoDir, markerPath }) => {
    // The dev-link wrapper's filename is platform-dependent (upstage.cmd on
    // Windows, a plain `upstage` script elsewhere — see scripts/dev-link.ps1
    // vs. scripts/dev-link.sh) — matches uninstall.mjs's own IS_WINDOWS check.
    const wrapperName = process.platform === "win32" ? "upstage.cmd" : "upstage";
    const wrapperPath = join(binDir, wrapperName);
    writeFileSync(wrapperPath, "dev-link wrapper");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: repoDir, linkedAt: "2026-09-04T00:00:00Z" }));

    const code = await runUninstallCommand(["-y"], {
      installTypeOverride: { type: "dev-link", repoRoot: repoDir, linkedAt: "2026-09-04T00:00:00Z" },
      binDir, markerPath, settingsRoot, sessionsRoot
    });

    assert.equal(code, 0);
    // Wrapper + marker ARE removed...
    assert.equal(existsSync(wrapperPath), false);
    assert.equal(existsSync(markerPath), false);
    // ...but the linked repository and its contents are completely untouched.
    assert.equal(existsSync(repoDir), true);
    assert.equal(existsSync(join(repoDir, "package.json")), true);
    assert.equal(readFileSync(join(repoDir, "package.json"), "utf8"), "{}");
  });
});

// --- interactive confirmation (default) vs -y/--yes ---

test("without -y, declining the confirmation prompt (typed 'n') removes nothing", async () => {
  await withFixture(async ({ binDir, installDir, settingsRoot, sessionsRoot }) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on("data", () => {});
    stdin.write("n\n");

    const code = await runUninstallCommand([], {
      installTypeOverride: { type: "standalone" },
      binDir, installDir, settingsRoot, sessionsRoot,
      stdin, stdout
    });

    assert.equal(code, 0);
    assert.equal(existsSync(installDir), true);
    assert.equal(existsSync(join(binDir, "upstage")), true);
  });
});

test("without -y, confirming the prompt (typed 'y') proceeds with removal", async () => {
  await withFixture(async ({ binDir, installDir, settingsRoot, sessionsRoot }) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on("data", () => {});
    stdin.write("y\n");

    const code = await runUninstallCommand([], {
      installTypeOverride: { type: "standalone" },
      binDir, installDir, settingsRoot, sessionsRoot,
      stdin, stdout
    });

    assert.equal(code, 0);
    assert.equal(existsSync(installDir), false);
  });
});

// --- help ---

test("runUninstallCommand -h / --help prints usage and returns 0", async () => {
  const out = captureStdout(() => { runUninstallCommand(["--help"]); });
  assert.match(out, /Usage: upstage uninstall/);
});
