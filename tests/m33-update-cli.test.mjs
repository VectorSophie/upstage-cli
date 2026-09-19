import test from "node:test";
import assert from "node:assert/strict";

import { readPackageJson } from "../src/cli/commands/version.mjs";
import {
  fetchLatestRelease,
  checkForUpdate,
  runUpdateCommand
} from "../src/cli/commands/update.mjs";

function fakeFetch(tagName, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => ({ tag_name: tagName, html_url: `https://github.com/VectorSophie/upstage-cli/releases/${tagName}` })
  });
}

function captureStdio(run) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    run();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out: out.join(""), err: err.join("") };
}

// NOTE: `spawnFn` is passed to several calls below to show the override is
// harmless, but runUpdateCommand() never destructures or reads `spawnFn`
// from its options object — so passing it (even a throwing stub) does not
// exercise any interception mechanism and provides no regression guard
// against a future node:child_process call being added to update.mjs. What
// these tests actually check is stdout content and exit code per branch;
// "no child_process usage" is established separately by reading update.mjs's
// imports (see that file's header comment), not by anything here.
function throwingSpawn() {
  throw new Error("spawnFn should never be called in this branch");
}

// --- fetchLatestRelease (mocked — no real network call) ---

test("fetchLatestRelease returns {tag, url} from a mocked GitHub releases response", async () => {
  const result = await fetchLatestRelease({ fetchImpl: fakeFetch("v3.5.0") });
  assert.equal(result.tag, "v3.5.0");
  assert.match(result.url, /^https:\/\/github\.com\//);
});

test("fetchLatestRelease throws on a non-ok HTTP response", async () => {
  await assert.rejects(
    () => fetchLatestRelease({ fetchImpl: fakeFetch("v3.5.0", { ok: false, status: 404 }) }),
    /HTTP 404/
  );
});

test("fetchLatestRelease throws when the response is missing tag_name", async () => {
  const badFetch = async () => ({ ok: true, json: async () => ({ html_url: "https://x" }) });
  await assert.rejects(() => fetchLatestRelease({ fetchImpl: badFetch }), /tag_name/);
});

// --- checkForUpdate (version comparison) ---

test("checkForUpdate reports hasUpdate=true when the latest release tag is numerically newer", async () => {
  const result = await checkForUpdate({ currentVersion: "3.1.0", fetchImpl: fakeFetch("v3.5.0") });
  assert.deepEqual(result, { current: "3.1.0", latest: "3.5.0", hasUpdate: true, url: result.url });
});

test("checkForUpdate reports hasUpdate=false when up to date", async () => {
  const result = await checkForUpdate({ currentVersion: "3.1.0", fetchImpl: fakeFetch("v3.1.0") });
  assert.equal(result.hasUpdate, false);
});

test("checkForUpdate reports hasUpdate=false when the local version is AHEAD of the latest release (dev build)", async () => {
  const result = await checkForUpdate({ currentVersion: "3.9.0", fetchImpl: fakeFetch("v3.1.0") });
  assert.equal(result.hasUpdate, false);
});

test("checkForUpdate tolerates a tag with no leading 'v'", async () => {
  const result = await checkForUpdate({ currentVersion: "3.1.0", fetchImpl: fakeFetch("3.5.0") });
  assert.equal(result.latest, "3.5.0");
  assert.equal(result.hasUpdate, true);
});

// --- runUpdateCommand --check ---

test("runUpdateCommand --check reports a newer release is available and exits 0", async () => {
  const code = await runUpdateCommand(["--check"], { fetchImpl: fakeFetch("v99.0.0") });
  assert.equal(code, 0);
});

test("runUpdateCommand --check prints 'up to date' when the current version matches the latest tag", async () => {
  const pkg = readPackageJson();
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand(["--check"], { fetchImpl: fakeFetch(`v${pkg.version}`) });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(stdout, /up to date/);
});

test("runUpdateCommand --check prints the newer version when one is available", async () => {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand(["--check"], { fetchImpl: fakeFetch("v999.0.0") });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(stdout, /999\.0\.0/);
  assert.match(stdout, /newer release/i);
});

test("runUpdateCommand --check exits 1 and reports the error when the GitHub API call fails", async () => {
  let stderr = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand(["--check"], { fetchImpl: fakeFetch("v1.0.0", { ok: false, status: 500 }) });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(code, 1);
  assert.match(stderr, /upstage update --check:/);
});

test("runUpdateCommand --check succeeds with an unused spawnFn override present (spawnFn is never read by this function)", async () => {
  const code = await runUpdateCommand(["--check"], { fetchImpl: fakeFetch("v1.0.0"), spawnFn: throwingSpawn });
  assert.equal(code, 0);
});

// --- runUpdateCommand (no --check) — install-type branching ---

test("update on a detected npm install prints guidance and exits 0 (an unused spawnFn override is also passed, but has no effect)", async () => {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand([], { installTypeOverride: { type: "npm" }, spawnFn: throwingSpawn });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(stdout, /npm install -g @jackochesstern\/upstage-cli@latest/);
  // spawnFn is passed above but is never read by runUpdateCommand, so it
  // cannot fire regardless of what this branch does — this assertion checks
  // stdout content and exit code only, not child-process usage.
});

test("update on a dev-link install prints 'git pull it yourself' guidance and exits 0 (an unused spawnFn override is also passed, but has no effect)", async () => {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand([], {
      installTypeOverride: { type: "dev-link", repoRoot: "/repo", linkedAt: null },
      spawnFn: throwingSpawn
    });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(stdout, /git pull/);
});

test("update on a standalone install reports the self-update stub message (not yet implemented) and exits non-zero (an unused spawnFn override is also passed, but has no effect)", async () => {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand([], { installTypeOverride: { type: "standalone" }, spawnFn: throwingSpawn });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 1);
  assert.match(stdout, /not yet implemented/);
  assert.match(stdout, /re-run the installer/);
});

test("update on an unknown install type prints generic guidance and exits non-zero (an unused spawnFn override is also passed, but has no effect)", async () => {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  let code;
  try {
    code = await runUpdateCommand([], { installTypeOverride: { type: "unknown" }, spawnFn: throwingSpawn });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 1);
  assert.match(stdout, /Could not determine/);
});

test("runUpdateCommand -h / --help prints usage and returns 0", async () => {
  const { out } = captureStdio(() => { runUpdateCommand(["--help"]); });
  assert.match(out, /Usage: upstage update/);
});
