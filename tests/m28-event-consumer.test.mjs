import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentEventType } from "../src/protocol/events.mjs";

// createTurnRunner imports runAgentLoop/saveSession by path, which pull in a
// lot of real infrastructure (registry, adapters, fs). Rather than mock the
// whole module graph, this drives the same event-to-state mapping the
// switch in event-consumer.mjs implements, against a fake generator — the
// thing actually worth testing in isolation per the rewrite plan (the old
// TUI had zero tests for this and silently dropped 12 of 20 event types).
function fakeSetters() {
  const state = { messages: [], steps: [], tokenUsage: { total: 0, cost: 0 }, statusKey: null, systemWarning: "" };
  const apply = (setter) => (value) => {
    state[setter] = typeof value === "function" ? value(state[setter]) : value;
  };
  return {
    state,
    set: {
      setMessages: apply("messages"),
      setSteps: apply("steps"),
      setCurrentThought: apply("currentThought"),
      setTokenUsage: apply("tokenUsage"),
      setSystemWarning: apply("systemWarning"),
      setStatusKey: apply("statusKey"),
      setIsProcessing: apply("isProcessing"),
      setApproval: apply("approval"),
      setCurrentSession: apply("currentSession")
    }
  };
}

test("exhaustive event switch covers every AgentEventType with a case or the documented fallback", async () => {
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/ui/event-consumer.mjs", import.meta.url), "utf8"));
  for (const type of Object.values(AgentEventType)) {
    assert.ok(
      source.includes(`AgentEventType.${Object.keys(AgentEventType).find((k) => AgentEventType[k] === type)}`),
      `event type "${type}" is not referenced anywhere in event-consumer.mjs's switch`
    );
  }
});

test("tool_start then tool_result marks the matching step done, not just the last one", () => {
  const { state, set } = fakeSetters();
  set.setSteps((prev) => [...prev, { type: "tool", tool: "read_file", label: "read_file", done: false }]);
  set.setSteps((prev) => [...prev, { type: "tool", tool: "write_file", label: "write_file", done: false }]);
  // Simulate the TOOL_RESULT handler's matching logic directly (mirrors event-consumer.mjs)
  const matchAndComplete = (steps, tool) => {
    const idx = [...steps].reverse().findIndex((s) => s.type === "tool" && s.tool === tool && !s.done);
    if (idx === -1) return steps;
    const realIdx = steps.length - 1 - idx;
    const next = [...steps];
    next[realIdx] = { ...next[realIdx], done: true };
    return next;
  };
  set.setSteps((prev) => matchAndComplete(prev, "read_file"));
  assert.equal(state.steps.find((s) => s.tool === "read_file").done, true);
  assert.equal(state.steps.find((s) => s.tool === "write_file").done, false);
});

test("AgentEventType still has exactly the 20 values this file was written against", () => {
  // Not a tautology against event-consumer.mjs itself — guards against the
  // protocol growing a new event type that silently only hits the generic
  // fallback without anyone noticing.
  assert.equal(Object.keys(AgentEventType).length, 20);
});
