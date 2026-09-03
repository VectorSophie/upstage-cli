import { COLOR, c } from "./colors.mjs";

function supportsBracketedPasteMode() {
  return process.platform !== "win32";
}

export function isFullscreenTuiSupported({
  stdinIsTTY = process.stdin?.isTTY,
  stdoutIsTTY = process.stdout?.isTTY,
  env = process.env,
  platform = process.platform
} = {}) {
  if (!stdinIsTTY || !stdoutIsTTY) {
    return false;
  }

  if (env.TERM === "dumb") {
    return false;
  }

  if (platform !== "win32") {
    return true;
  }

  if (env.WT_SESSION || env.TERM_PROGRAM === "vscode") {
    return true;
  }

  const term = String(env.TERM || "").toLowerCase();
  if (term.includes("xterm") || term.includes("vt100") || term.includes("ansi")) {
    return true;
  }

  if (env.ANSICON || env.ConEmuANSI === "ON") {
    return true;
  }

  return false;
}

const ENTER_FULLSCREEN_SEQUENCE = supportsBracketedPasteMode()
  ? "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?2004h"
  : "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const EXIT_FULLSCREEN_SEQUENCE = supportsBracketedPasteMode()
  ? "\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l\r\n"
  : "\x1b[?25h\x1b[0m\x1b[?1049l\r\n";

export function canUseFullscreenTui() {
  return isFullscreenTuiSupported();
}

export function enterFullscreenTui() {
  process.stdout.write(ENTER_FULLSCREEN_SEQUENCE);
}

export function exitFullscreenTui() {
  if (process.stdin && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch (error) {
      void error;
    }
  }
  process.stdout.write(EXIT_FULLSCREEN_SEQUENCE);
}

export function getFullscreenSequences() {
  return {
    enter: ENTER_FULLSCREEN_SEQUENCE,
    exit: EXIT_FULLSCREEN_SEQUENCE
  };
}

// Plain-text renderer for the non-interactive `upstage ask`/`-p` path.
// Never touched Ink/OpenTUI — pure ANSI writes to stdout.
export function renderEvent(event) {
  if (!event || typeof event !== "object") {
    return;
  }
  if (event.type === "PLAN") {
    process.stdout.write(c(COLOR.primary, "[PLAN] "));
    process.stdout.write(`mode=${event.mode} keywords=${(event.keywords || []).join(",") || "none"}\n`);
    return;
  }
  if (event.type === "TOOL") {
    process.stdout.write(c(COLOR.subA, "[TOOL] "));
    process.stdout.write(`${event.tool} ${JSON.stringify(event.args || {})}\n`);
    return;
  }
  if (event.type === "OBSERVATION") {
    process.stdout.write(c(COLOR.subB, "[OBSERVATION] "));
    process.stdout.write(`${event.tool} ok=${event.ok}\n`);
    return;
  }
  if (event.type === "PATCH_PREVIEW") {
    process.stdout.write(c(COLOR.primary, "[PATCH PREVIEW]\n"));
    process.stdout.write(`${event.patch?.unifiedDiff || "(no diff)"}\n`);
    return;
  }
  if (event.type === "VERIFY_LOG") {
    const stage = event.stage || "verify";
    const text = (event.text || "").trim();
    if (text) {
      process.stdout.write(c(COLOR.subA, `[VERIFY:${stage}] `) + `${text}\n`);
    }
    return;
  }
  if (event.type === "VERIFY_RESULT") {
    process.stdout.write(c(COLOR.primary, `[VERIFY RESULT] stage=${event.stage}\n`));
    return;
  }
  if (event.type === "POLICY_DECISION") {
    process.stdout.write(c(COLOR.subB, "[POLICY] "));
    process.stdout.write(
      `${event.tool || "n/a"} action=${event.actionClass || "n/a"} approved=${event.approved ?? event.allowed ?? "n/a"}\n`
    );
  }
}
