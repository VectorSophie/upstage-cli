import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getUpstageCliStateDir,
  getDevLinkMarkerPath,
  readDevLinkMarker,
  detectInstallType
} from "../src/cli/lib/install-type.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-install-type-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// --- getUpstageCliStateDir / getDevLinkMarkerPath ---

test("getUpstageCliStateDir points at ~/.upstage-cli (not ~/.upstage, the settings dir)", () => {
  const dir = getUpstageCliStateDir();
  assert.match(dir, /\.upstage-cli$/);
});

test("getDevLinkMarkerPath is dev-link.json inside the state dir", () => {
  const marker = getDevLinkMarkerPath();
  const stateDir = getUpstageCliStateDir();
  assert.equal(marker, join(stateDir, "dev-link.json"));
});

// --- readDevLinkMarker ---

test("readDevLinkMarker returns null when the marker file doesn't exist", () => {
  return withTempDir((dir) => {
    const result = readDevLinkMarker(join(dir, "does-not-exist.json"));
    assert.equal(result, null);
  });
});

test("readDevLinkMarker parses a well-formed marker", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: "/home/user/upstage-cli", linkedAt: "2026-09-04T00:00:00Z" }));
    const result = readDevLinkMarker(markerPath);
    assert.deepEqual(result, { repoRoot: "/home/user/upstage-cli", linkedAt: "2026-09-04T00:00:00Z" });
  });
});

test("readDevLinkMarker tolerates a missing linkedAt field", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: "/repo" }));
    const result = readDevLinkMarker(markerPath);
    assert.deepEqual(result, { repoRoot: "/repo", linkedAt: null });
  });
});

test("readDevLinkMarker returns null for malformed JSON", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, "{not valid json");
    const result = readDevLinkMarker(markerPath);
    assert.equal(result, null);
  });
});

test("readDevLinkMarker returns null when repoRoot is missing", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ linkedAt: "2026-09-04T00:00:00Z" }));
    const result = readDevLinkMarker(markerPath);
    assert.equal(result, null);
  });
});

test("readDevLinkMarker returns null when repoRoot is empty or non-string", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: "" }));
    assert.equal(readDevLinkMarker(markerPath), null);
    writeFileSync(markerPath, JSON.stringify({ repoRoot: 42 }));
    assert.equal(readDevLinkMarker(markerPath), null);
  });
});

// --- detectInstallType ---

test("detectInstallType reports dev-link when a valid marker is present, regardless of execPath", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: "/home/user/upstage-cli", linkedAt: "2026-09-04T00:00:00Z" }));
    const result = detectInstallType({ markerPath, execPath: "/usr/bin/node" });
    assert.deepEqual(result, { type: "dev-link", repoRoot: "/home/user/upstage-cli", linkedAt: "2026-09-04T00:00:00Z" });
  });
});

test("detectInstallType prefers the dev-link marker over an npm-shaped scriptPath (unambiguous signal wins)", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: "/home/user/upstage-cli", linkedAt: null }));
    const result = detectInstallType({
      markerPath,
      scriptPath: "/usr/lib/node_modules/@jackochesstern/upstage-cli/src/cli/index.mjs"
    });
    assert.equal(result.type, "dev-link");
  });
});

test("detectInstallType reports npm when the invoked scriptPath (argv[1]) contains node_modules and no marker exists", () => {
  // execPath is deliberately left as a plain bun binary path here — execPath is the
  // interpreter's own location (irrelevant to how the package was installed), not the
  // invoked script's location. Only scriptPath (argv[1]) should drive this signal.
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({
      markerPath,
      execPath: "/usr/local/bin/bun",
      scriptPath: "/usr/lib/node_modules/@jackochesstern/upstage-cli/src/cli/index.mjs"
    });
    assert.deepEqual(result, { type: "npm" });
  });
});

test("detectInstallType reports npm for a Windows-style npm-global scriptPath", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({
      markerPath,
      execPath: "C:\\Users\\dev\\.bun\\bin\\bun.exe",
      scriptPath: "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@jackochesstern\\upstage-cli\\src\\cli\\index.mjs"
    });
    assert.deepEqual(result, { type: "npm" });
  });
});

test("detectInstallType does NOT report npm just because execPath (the interpreter binary) happens to contain node_modules", () => {
  // Regression test for the bug this suite previously had: execPath is the interpreter's
  // own path, unrelated to where the invoked script/package lives, and must not drive
  // npm detection on its own.
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({
      markerPath,
      execPath: "/usr/lib/node_modules/@jackochesstern/upstage-cli/node_modules/.bin/node",
      scriptPath: "/home/user/some-project/index.mjs"
    });
    assert.deepEqual(result, { type: "unknown" });
  });
});

test("detectInstallType reports standalone for a compiled binary named upstage outside node_modules", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({
      markerPath,
      execPath: "/home/user/.local/share/upstage-cli/upstage",
      scriptPath: "/home/user/.local/share/upstage-cli/upstage"
    });
    assert.deepEqual(result, { type: "standalone" });
  });
});

test("detectInstallType reports standalone for upstage.exe on Windows-style paths", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({
      markerPath,
      execPath: "C:\\Users\\dev\\.local\\share\\upstage-cli\\upstage.exe",
      scriptPath: "C:\\Users\\dev\\.local\\share\\upstage-cli\\upstage.exe"
    });
    assert.deepEqual(result, { type: "standalone" });
  });
});

test("detectInstallType reports unknown for a plain bun/node execPath and scriptPath with no marker (e.g. running from a repo checkout that isn't dev-linked)", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({ markerPath, execPath: "/usr/local/bin/bun", scriptPath: "/home/user/upstage-cli/src/cli/index.mjs" });
    assert.deepEqual(result, { type: "unknown" });
  });
});

test("detectInstallType defaults markerPath/execPath/scriptPath to the real environment when not overridden, given a guaranteed-nonexistent marker path", () => {
  // Pass an explicit, guaranteed-nonexistent markerPath so this test stays hermetic —
  // it must not depend on whatever ~/.upstage-cli/dev-link.json (if any) happens to
  // exist on the machine running the suite. execPath/scriptPath are left defaulted
  // to exercise the real process.execPath/process.argv[1] path at least once.
  return withTempDir((dir) => {
    const markerPath = join(dir, "definitely-does-not-exist.json");
    const result = detectInstallType({ markerPath });
    assert.ok(["dev-link", "standalone", "npm", "unknown"].includes(result.type));
    // With this markerPath, "dev-link" is impossible (nothing was written there).
    assert.notEqual(result.type, "dev-link");
  });
});
