// Tests for src/cli/commands/browser-install.mjs (3.3.0 Thread C, Task
// C.4) — `upstage browser install`, an EXPLICIT opt-in command that
// downloads Chrome for Testing into ~/.upstage/browser/. Never invoked by
// any other command (per the owner decision, design doc §C.1: "no giant
// hidden downloads unless the user explicitly asks").
//
// No real network call in any test — `fetchImpl` is always injected, same
// pattern as tests/m33-update-cli.test.mjs's `fetchImpl` override for
// upstage update --check.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveDownloadUrl, downloadFile, extractZip } from "../src/cli/commands/browser-install.mjs";

// Chrome for Testing's real JSON shape (trimmed to what resolveDownloadUrl reads).
function fakeKnownGoodVersions() {
  return {
    channels: {
      Stable: {
        version: "131.0.6778.85",
        downloads: {
          chrome: [
            { platform: "win64", url: "https://example.invalid/win64/chrome.zip" },
            { platform: "linux64", url: "https://example.invalid/linux64/chrome.zip" },
            { platform: "mac-x64", url: "https://example.invalid/mac-x64/chrome.zip" },
            { platform: "mac-arm64", url: "https://example.invalid/mac-arm64/chrome.zip" }
          ]
        }
      }
    }
  };
}

test("resolveDownloadUrl picks the download matching the requested platform", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => fakeKnownGoodVersions() });
  const result = await resolveDownloadUrl({ platform: "win64", fetchImpl });
  assert.equal(result.url, "https://example.invalid/win64/chrome.zip");
  assert.equal(result.version, "131.0.6778.85");
});

test("resolveDownloadUrl throws a clear error for an unsupported platform", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => fakeKnownGoodVersions() });
  await assert.rejects(
    () => resolveDownloadUrl({ platform: "not-a-real-platform", fetchImpl }),
    /not-a-real-platform/
  );
});

test("resolveDownloadUrl surfaces a non-ok HTTP response as an error, not a silent failure", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => resolveDownloadUrl({ platform: "win64", fetchImpl }), /500/);
});

test("downloadFile writes the fetched bytes to disk without a real network call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m45-download-"));
  try {
    const dest = join(dir, "chrome.zip");
    const fakeBytes = Buffer.from("fake-zip-bytes");
    const fetchImpl = async () => ({
      ok: true,
      arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength)
    });
    await downloadFile("https://example.invalid/chrome.zip", dest, { fetchImpl });
    assert.ok(existsSync(dest));
    assert.equal(readFileSync(dest).toString("utf8"), "fake-zip-bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadFile surfaces a non-ok HTTP response as an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m45-download-fail-"));
  try {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await assert.rejects(
      () => downloadFile("https://example.invalid/nope.zip", join(dir, "out.zip"), { fetchImpl }),
      /404/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HAS_UNZIP = spawnSync("unzip", ["-v"]).status === 0;
const HAS_COMPRESS_ARCHIVE = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Command Compress-Archive"]).status === 0;

test("extractZip extracts a real archive's contents", async (t) => {
  if (!HAS_UNZIP || !HAS_COMPRESS_ARCHIVE) return t.skip("unzip or Compress-Archive not available in this environment");
  const dir = mkdtempSync(join(tmpdir(), "m45-extract-"));
  try {
    const srcDir = join(dir, "src");
    const zipPath = join(dir, "fixture.zip");
    const destDir = join(dir, "out");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "sentinel.txt"), "hello from the zip");
    const compress = spawnSync("powershell.exe", [
      "-NoProfile", "-Command",
      `Compress-Archive -Path '${join(srcDir, "sentinel.txt")}' -DestinationPath '${zipPath}'`
    ]);
    assert.equal(compress.status, 0, compress.stderr?.toString());

    await extractZip(zipPath, destDir);
    assert.equal(readFileSync(join(destDir, "sentinel.txt"), "utf8"), "hello from the zip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
