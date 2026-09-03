import test from "node:test";
import assert from "node:assert/strict";

import {
  getFullscreenSequences,
  isFullscreenTuiSupported
} from "../src/ui/plain-event-renderer.mjs";

test("fullscreen terminal sequences include cleanup codes", () => {
  const seq = getFullscreenSequences();
  assert.ok(seq.enter.includes("\x1b[?1049h"));
  assert.ok(seq.enter.includes("\x1b[?25l"));
  if (process.platform !== "win32") {
    assert.ok(seq.enter.includes("\x1b[?2004h"));
  }

  if (process.platform !== "win32") {
    assert.ok(seq.exit.includes("\x1b[?2004l"));
  }
  assert.ok(seq.exit.includes("\x1b[?25h"));
  assert.ok(seq.exit.includes("\x1b[0m"));
  assert.ok(seq.exit.includes("\x1b[?1049l"));
});

test("fullscreen support is disabled for legacy windows cmd", () => {
  const supported = isFullscreenTuiSupported({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: {
      TERM: "",
      TERM_PROGRAM: "",
      WT_SESSION: "",
      ANSICON: "",
      ConEmuANSI: ""
    }
  });
  assert.equal(supported, false);
});

test("fullscreen support is enabled for windows terminal", () => {
  const supported = isFullscreenTuiSupported({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: {
      TERM: "",
      TERM_PROGRAM: "",
      WT_SESSION: "1"
    }
  });
  assert.equal(supported, true);
});
