// `upstage update [--check]` — Task 12.9 of the 3.2.0 release plan (§6
// command tree, §7.V design detail).
//
// `--check` makes exactly one network call (the GitHub releases API,
// mockable below via an injectable `fetchImpl`) and never installs
// anything. Without `--check`, behavior branches on install type (reused
// from src/cli/lib/install-type.mjs, not reimplemented):
//   - npm      -> guidance only ("run npm install -g ...@latest yourself").
//                 NEVER invokes npm as a child process on the user's behalf.
//   - dev-link -> guidance only ("git pull it yourself").
//   - standalone -> SCOPE NOTE: a real self-update here needs to download a
//     release asset, verify its checksum, and atomically replace the
//     running binary. That download/verify/replace machinery does not exist
//     anywhere on this branch yet (grep confirms: no checksum generation in
//     scripts/package-binary.mjs or .github/workflows/release.yml, and
//     Task 7.12 "installer hardening" — which owns that work — has not
//     landed). Half-building a bespoke, untested checksum/atomic-replace
//     path here would both duplicate Task 7.12's actual job AND ship
//     unverified binary-replacement logic, which is the wrong tradeoff for
//     a stub. So this branch is a thin, clearly-marked TODO: it reports
//     that self-update isn't available yet and exits non-zero, touching
//     nothing. Revisit once Task 7.12 lands real checksum-verified release
//     assets to build on top of.
//   - unknown  -> guidance only, nothing removed/changed.
//
// None of the branches above ever import/call node:child_process — there is
// nothing to invoke, since every branch is pure print-and-return (verifiable
// today by reading this file's imports above). Some tests in
// tests/m33-update-cli.test.mjs additionally pass an `overrides.spawnFn`
// throwing stub alongside their other overrides — but `runUpdateCommand`
// below never destructures or reads `spawnFn` anywhere in its body, so that
// stub is inert and can never fire either way. Its presence is NOT a
// dependency-injection mechanism and provides no regression guard: if a
// future change added a real node:child_process call, these tests would
// keep passing unchanged, since nothing wires `spawnFn` to that call site.

import { readPackageJson } from "./version.mjs";
import { detectInstallType } from "../lib/install-type.mjs";

const GITHUB_REPO = "VectorSophie/upstage-cli";
const NPM_PACKAGE = "@jackochesstern/upstage-cli";

function normalizeVersion(v) {
  return String(v || "").replace(/^v/, "").trim();
}

/** Numeric-segment comparison (handles "3.2.0" style versions; a missing
 *  segment on either side is treated as 0). Returns >0 if `a` is newer. */
function compareVersions(a, b) {
  const pa = normalizeVersion(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** One network call to GitHub's releases/latest endpoint. `fetchImpl`
 *  defaults to the global `fetch` — override in tests to avoid a real
 *  network call. */
export async function fetchLatestRelease({ repo = GITHUB_REPO, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "upstage-cli" }
  });
  if (!res.ok) {
    throw new Error(`GitHub releases API returned HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data || typeof data.tag_name !== "string") {
    throw new Error("GitHub releases API response missing tag_name");
  }
  return { tag: data.tag_name, url: data.html_url || null };
}

/** Compares `currentVersion` against the latest GitHub release tag. Returns
 *  `{ current, latest, hasUpdate, url }`. */
export async function checkForUpdate({ currentVersion, fetchImpl } = {}) {
  const release = await fetchLatestRelease({ fetchImpl });
  const current = normalizeVersion(currentVersion);
  const latest = normalizeVersion(release.tag);
  return { current, latest, hasUpdate: compareVersions(latest, current) > 0, url: release.url };
}

function printUsage() {
  process.stdout.write([
    "Usage: upstage update [--check]",
    "",
    "  --check reports whether a newer GitHub release exists (one network call),",
    "  without installing anything.",
    "",
    "  Without --check, behavior depends on how this copy of upstage-cli was",
    "  installed: a standalone binary self-updates in place; an npm install or",
    "  development checkout instead prints guidance and does nothing (this",
    "  command never invokes npm or git on your behalf)."
  ].join("\n") + "\n");
}

async function runCheckOnly({ fetchImpl }) {
  const pkg = readPackageJson();
  try {
    const result = await checkForUpdate({ currentVersion: pkg.version, fetchImpl });
    if (result.hasUpdate) {
      process.stdout.write(`A newer release is available: ${result.latest} (current: ${result.current})\n`);
    } else {
      process.stdout.write(`upstage-cli is up to date (${result.current})\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`upstage update --check: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** Router entry point. `fetchImpl`/`installTypeOverride` are overridable for
 *  tests. Some tests also pass an `overrides.spawnFn` stub, but this
 *  function never destructures or reads `spawnFn` from its options object —
 *  it is silently ignored, not wired to anything. Passing a throwing stub
 *  there does NOT regression-test "this command never invokes npm/git as a
 *  child process" — it only confirms that today's branches (verified by
 *  reading this file's imports, per the header comment above) don't happen
 *  to call that particular unused option. A future node:child_process call
 *  added here would not be caught by that stub. */
export async function runUpdateCommand(rest = [], { fetchImpl, installTypeOverride } = {}) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }

  if (rest.includes("--check")) {
    return runCheckOnly({ fetchImpl });
  }

  const installType = installTypeOverride || detectInstallType();

  if (installType.type === "npm") {
    process.stdout.write(
      `Installed via npm as \`${NPM_PACKAGE}\` — run \`npm install -g ${NPM_PACKAGE}@latest\` to update.\n`
    );
    return 0;
  }

  if (installType.type === "dev-link") {
    process.stdout.write("This is a development checkout — `git pull` it yourself.\n");
    return 0;
  }

  if (installType.type === "standalone") {
    // See this file's header — real download+checksum-verify+atomic-replace
    // logic belongs to Task 7.12 (installer hardening), not yet landed.
    process.stdout.write(
      "self-update for standalone binaries requires Task 7.12's installer hardening (not yet implemented)\n"
    );
    return 1;
  }

  process.stdout.write(
    `Could not determine how upstage-cli was installed — see https://github.com/${GITHUB_REPO} for update instructions.\n`
  );
  return 1;
}
