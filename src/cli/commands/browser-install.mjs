// `upstage browser install` — 3.3.0 Thread C, Task C.4. Downloads Chrome
// for Testing into ~/.upstage/browser/ — the ONLY place in this codebase
// that downloads a browser, and only when the user explicitly runs this
// command (design doc §C.1: "no giant hidden downloads unless the user
// explicitly asks"). Nothing in browser-tools.mjs or discovery.mjs ever
// calls into this file.
//
// Same injectable-`fetchImpl` pattern as update.mjs's fetchLatestRelease —
// no test in tests/m45-browser-install.test.mjs makes a real network call.

import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const KNOWN_GOOD_VERSIONS_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

function installDir() {
  return join(homedir(), ".upstage", "browser");
}

/** Maps this process's platform/arch to Chrome for Testing's platform
 *  naming (win64/win32/linux64/mac-x64/mac-arm64). */
export function detectCftPlatform({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32") return arch === "ia32" ? "win32" : "win64";
  if (platform === "linux") return "linux64";
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  return null;
}

/** Resolves the Stable-channel Chrome download URL for `platform` from
 *  Chrome for Testing's published JSON. Never downloads the archive itself
 *  — that's downloadFile()'s job, kept separate so URL resolution stays
 *  trivially mockable in tests. */
export async function resolveDownloadUrl({ platform, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(KNOWN_GOOD_VERSIONS_URL);
  if (!res.ok) {
    throw new Error(`Chrome for Testing versions endpoint returned HTTP ${res.status}`);
  }
  const data = await res.json();
  const stable = data.channels?.Stable;
  const download = stable?.downloads?.chrome?.find((d) => d.platform === platform);
  if (!download) {
    throw new Error(`no Chrome for Testing download found for platform '${platform}'`);
  }
  return { version: stable.version, url: download.url };
}

/** Downloads `url` to `destPath`. `fetchImpl` is overridable for tests —
 *  the default is the global `fetch`. */
export async function downloadFile(url, destPath, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`download of ${url} returned HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(join(destPath, ".."), { recursive: true });
  await writeFile(destPath, bytes);
}

/** Extracts a zip archive. Tries `unzip` first (present on Linux/macOS and
 *  most Windows dev environments via git-bash/WSL), falls back to
 *  PowerShell's `Expand-Archive` for a bare Windows install with neither. */
export async function extractZip(zipPath, destDir, { spawnFn = spawnSync } = {}) {
  await mkdir(destDir, { recursive: true });

  const unzipResult = spawnFn("unzip", ["-o", zipPath, "-d", destDir]);
  if (unzipResult.status === 0) return;

  const psResult = spawnFn("powershell.exe", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
  ]);
  if (psResult.status === 0) return;

  throw new Error(
    `failed to extract ${zipPath} — install \`unzip\` (or, on Windows, ensure PowerShell's Expand-Archive is available) and try again, or extract it manually into ${destDir}`
  );
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage browser install",
      "",
      "  Downloads Chrome for Testing into ~/.upstage/browser/, for use by the",
      "  browser_* verification tools. This is the ONLY command in upstage-cli",
      "  that downloads a browser, and it only runs when you explicitly invoke it.",
      "",
      "  If you already have Chrome/Chromium installed, you don't need this —",
      "  `upstage doctor` reports what browser_open will use."
    ].join("\n") + "\n"
  );
}

export async function runBrowserInstallCommand(rest = [], { fetchImpl, spawnFn } = {}) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  const platform = detectCftPlatform();
  if (!platform) {
    process.stderr.write(`upstage browser install: unsupported platform '${process.platform}'/'${process.arch}'\n`);
    return 1;
  }

  try {
    const { version, url } = await resolveDownloadUrl({ platform, fetchImpl });
    process.stdout.write(`Downloading Chrome for Testing ${version} (${platform})...\n`);

    const dir = installDir();
    const zipPath = join(dir, "chrome.zip");
    await downloadFile(url, zipPath, { fetchImpl });

    process.stdout.write("Extracting...\n");
    await extractZip(zipPath, dir, { spawnFn });

    process.stdout.write(`Installed to ${dir} — run \`upstage doctor\` to confirm it's picked up.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`upstage browser install: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
