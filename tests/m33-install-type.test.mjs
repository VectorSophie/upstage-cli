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

test("detectInstallType prefers the dev-link marker over an npm-shaped execPath (unambiguous signal wins)", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "dev-link.json");
    writeFileSync(markerPath, JSON.stringify({ repoRoot: "/home/user/upstage-cli", linkedAt: null }));
    const result = detectInstallType({
      markerPath,
      execPath: "/usr/lib/node_modules/@jackochesstern/upstage-cli/node_modules/.bin/node"
    });
    assert.equal(result.type, "dev-link");
  });
});

test("detectInstallType reports npm when execPath contains node_modules and no marker exists", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({
      markerPath,
      execPath: "/usr/lib/node_modules/@jackochesstern/upstage-cli/bin/node"
    });
    assert.deepEqual(result, { type: "npm" });
  });
});

test("detectInstallType reports standalone for a compiled binary named upstage outside node_modules", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({ markerPath, execPath: "/home/user/.local/share/upstage-cli/upstage" });
    assert.deepEqual(result, { type: "standalone" });
  });
});

test("detectInstallType reports standalone for upstage.exe on Windows-style paths", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({ markerPath, execPath: "C:\\Users\\dev\\.local\\share\\upstage-cli\\upstage.exe" });
    assert.deepEqual(result, { type: "standalone" });
  });
});

test("detectInstallType reports unknown for a plain bun/node execPath with no marker (e.g. running from a repo checkout that isn't dev-linked)", () => {
  return withTempDir((dir) => {
    const markerPath = join(dir, "missing-marker.json");
    const result = detectInstallType({ markerPath, execPath: "/usr/local/bin/bun" });
    assert.deepEqual(result, { type: "unknown" });
  });
});

test("detectInstallType defaults markerPath/execPath to the real environment when not overridden", () => {
  // Just verify it doesn't throw and returns a recognizable shape when called
  // with no arguments at all (exercises the real getDevLinkMarkerPath()/process.execPath path).
  const result = detectInstallType();
  assert.ok(["dev-link", "standalone", "npm", "unknown"].includes(result.type));
});
