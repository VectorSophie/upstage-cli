import test from "node:test";
import assert from "node:assert/strict";

import { getDefaultCommands, rankCommands } from "../src/ui/command-palette.js";
import { createChatScreen } from "../src/ui/tui.js";

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
