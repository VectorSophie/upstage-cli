// Chrome/Chromium discovery (3.3.0 Thread C, Task C.2). Looks for an
// existing install only — per the owner decision (design doc §C.1), no tool
// in this codebase auto-downloads a browser. `upstage browser install`
// (Task C.4) is the only path that fetches one, and only when the user
// explicitly runs it.

import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

function defaultCandidates() {
  const home = homedir();
  return [
    // Explicit opt-in install location (Task C.4), checked first so an
    // `upstage browser install`ed Chrome for Testing takes priority over a
    // system install.
    join(home, ".upstage", "browser", "chrome"),
    join(home, ".upstage", "browser", "chrome.exe"),
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ];
}

async function defaultExists(path) {
  try {
    await access(path, constants.X_OK | constants.F_OK);
    return true;
  } catch {
    try {
      // Windows has no notion of the executable bit — F_OK alone is enough.
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** Returns the first existing Chrome/Chromium path from `candidates`
 *  (default: standard per-OS install locations + PATH via `command -v`-style
 *  candidates is deliberately NOT included — callers on PATH already work
 *  without this), or `null` if none exist. Never downloads anything. */
export async function findChrome({ candidates = defaultCandidates(), exists = defaultExists } = {}) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}
