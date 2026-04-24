import test from "node:test";
import assert from "node:assert/strict";

import { getDefaultCommands, rankCommands } from "../src/ui/command-palette.mjs";
import {
  createChatScreen,
  getFullscreenSequences,
  isFullscreenTuiSupported
} from "../src/ui/tui.mjs";

test("command palette ranks prefix and exact matches first", () => {
  const commands = getDefaultCommands();
  const ranked = rankCommands("/to", commands);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].name, "/tools");

  const exact = rankCommands("/tasks", commands);
  assert.ok(exact.length > 0);
  assert.equal(exact[0].name, "/tasks");
});

test("chat screen task summary tracks event counters", () => {
  const screen = createChatScreen("test-session");
  screen.onEvent({ type: "PLAN", mode: "model", keywords: ["a"] });
  screen.onEvent({ type: "TOOL", tool: "read_file", args: { path: "a" } });
  screen.onEvent({ type: "OBSERVATION", tool: "read_file", ok: true });
  screen.onEvent({
    type: "POLICY_DECISION",
    tool: "run_shell",
    actionClass: "exec",
    approved: true
  });

  const summary = screen.getTaskSummary();
  assert.equal(summary.plans, 1);
  assert.equal(summary.tools, 1);
  assert.equal(summary.observations, 1);
  assert.equal(summary.approvals, 1);
});

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
