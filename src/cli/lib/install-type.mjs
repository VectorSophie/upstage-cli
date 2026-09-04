/**
 * Install-type detection — a single, reusable place to answer "how was this
 * copy of upstage-cli installed?".
 *
 * This module is intentionally narrow: it detects and reports, nothing more.
 * It is designed to be imported (not reimplemented) by:
 *   - Task 12.3's `upstage doctor`
 *   - Task 12.9's `upstage version --verbose` / `upstage update`
 *   - Task 7.20's `upstage uninstall`
 *   - Task 7.23's `upstage migrate`
 *
 * The dev-link marker (see `getDevLinkMarkerPath`/`readDevLinkMarker` below)
 * is written by `scripts/dev-link.sh` / `scripts/dev-link.ps1` and is the one
 * *unambiguous* signal this module has — it must always be checked before any
 * path-shape heuristic (npm/standalone), per the plan's explicit failure-mode
 * note: a dev-link checkout can otherwise be misdetected as an npm install by
 * path shape alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding upstage-cli's non-settings runtime state (sessions, this marker). */
export function getUpstageCliStateDir() {
  return join(homedir(), ".upstage-cli");
}

/** Absolute path to the dev-link marker file written by scripts/dev-link.sh(.ps1). */
export function getDevLinkMarkerPath() {
  return join(getUpstageCliStateDir(), "dev-link.json");
}

/**
 * Reads and validates the dev-link marker file, if present.
 * Returns `null` if the file is missing, unreadable, malformed, or missing
 * its required `repoRoot` field — callers should treat `null` the same as
 * "not a dev-link install", never throw.
 *
 * @param {string} [markerPath] override for testing; defaults to the real marker path.
 * @returns {{ repoRoot: string, linkedAt: string | null } | null}
 */
export function readDevLinkMarker(markerPath = getDevLinkMarkerPath()) {
  if (!existsSync(markerPath)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || typeof data.repoRoot !== "string" || data.repoRoot.length === 0) {
    return null;
  }
  return {
    repoRoot: data.repoRoot,
    linkedAt: typeof data.linkedAt === "string" ? data.linkedAt : null
  };
}

/**
 * Detects how this running copy of upstage-cli was installed.
 *
 * Check order (deliberate — see module docstring):
 *   1. dev-link marker (unambiguous, written by our own dev-link scripts)
 *   2. npm-install path-shape heuristic (`node_modules` in `execPath`)
 *   3. standalone-binary path-shape heuristic (a `bun build --compile`
 *      executable named `upstage`/`upstage.exe`, outside any `node_modules`)
 *   4. `unknown` — e.g. running via plain `bun src/cli/index.mjs` in this
 *      repo with no dev-link marker present (a maintainer who hasn't run
 *      dev-link.sh yet)
 *
 * @param {object} [options]
 * @param {string} [options.markerPath] override for testing.
 * @param {string} [options.execPath] override for testing; defaults to `process.execPath`.
 * @returns {{ type: "dev-link" } & { repoRoot: string, linkedAt: string | null }
 *         | { type: "standalone" | "npm" | "unknown" }}
 */
export function detectInstallType({ markerPath = getDevLinkMarkerPath(), execPath = process.execPath } = {}) {
  const marker = readDevLinkMarker(markerPath);
  if (marker) {
    return { type: "dev-link", repoRoot: marker.repoRoot, linkedAt: marker.linkedAt };
  }

  const normalized = String(execPath).replace(/\\/g, "/");

  if (normalized.includes("/node_modules/")) {
    return { type: "npm" };
  }

  if (/\/upstage(\.exe)?$/i.test(normalized)) {
    return { type: "standalone" };
  }

  return { type: "unknown" };
}
