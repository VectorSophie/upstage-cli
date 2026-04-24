import test from "node:test";
import assert from "node:assert/strict";

import { runAgentLoop, collectAgentLoop } from "../src/agent/loop.mjs";
import { createSession } from "../src/runtime/session.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";

test("tool execution emits policy and tool lifecycle events in order", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  registry.register({
    name: "echo",
    description: "echo tool",
    risk: "low",
    actionClass: "read",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false
    },
    async execute(args) {
      return { text: args.text || "" };
    }
  });

  const events = [];
  registry.eventBus.on((event) => {
    events.push(event);
  });

  const result = await registry.execute("echo", { text: "hello" }, { cwd: process.cwd() });
  assert.equal(result.ok, true);

  const eventTypes = events.map((event) => event.type);
  assert.ok(eventTypes.includes("HOOK_LIFECYCLE"));
  assert.ok(eventTypes.includes("POLICY_DECISION"));
  assert.ok(eventTypes.includes("TOOL_LIFECYCLE"));

  const policyIndex = events.findIndex((event) => event.type === "POLICY_DECISION");
  const toolStartIndex = events.findIndex(
    (event) => event.type === "TOOL_LIFECYCLE" && event.stage === "start"
  );
  const toolEndIndex = events.findIndex(
    (event) => event.type === "TOOL_LIFECYCLE" && event.stage === "end"
  );

  assert.ok(policyIndex >= 0);
  assert.ok(toolStartIndex >= 0);
  assert.ok(toolEndIndex >= 0);
  assert.ok(policyIndex < toolStartIndex);
  assert.ok(toolStartIndex < toolEndIndex);
});

test("agent loop records runtime event transcript with start and end lifecycle", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  registry.register({
    name: "echo",
    description: "echo tool",
    risk: "low",
    actionClass: "read",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false
    },
    async execute(args) {
      return { text: args.text || "" };
    }
  });

  const session = createSession(process.cwd());

const { result } = await collectAgentLoop(runAgentLoop({
  input: "echo hello",
  registry,
  cwd: process.cwd(),
  adapter: null,
  stream: false,
  session,
  runtimeCache: {}
}));

assert.equal(result.ok, true);
assert.equal(result.stopReason, "done");
assert.ok(Array.isArray(result.session.runtimeEvents));

  const lifecycleStart = result.session.runtimeEvents.find(
    (event) => event.type === "AGENT_LIFECYCLE" && event.stage === "start"
  );
  const lifecycleEnd = result.session.runtimeEvents.find(
    (event) => event.type === "AGENT_LIFECYCLE" && event.stage === "end"
  );

  assert.ok(lifecycleStart);
  assert.ok(lifecycleEnd);
});

test("agent loop completes after a tool result without replaying the user prompt each step", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  registry.register({
    name: "echo",
    description: "echo tool",
    risk: "low",
    actionClass: "read",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false
    },
    async execute(args) {
      return { text: args.text || "" };
    }
  });

  const adapter = {
    isConfigured() {
      return true;
    },
    async complete({ messages }) {
      const hasToolMessage = messages.some((message) => message.role === "tool");
      if (!hasToolMessage) {
        return {
          content: "",
          toolCalls: [
            {
              id: "call_0",
              type: "function",
              function: {
                name: "echo",
                arguments: JSON.stringify({ text: "hello" })
              }
            }
          ]
        };
      }

      const userMessages = messages.filter((message) => message.role === "user");
      assert.equal(userMessages.length, 1);
      return {
        content: "done after tool",
        toolCalls: []
      };
    }
  };

const session = createSession(process.cwd());
const { result } = await collectAgentLoop(runAgentLoop({
  input: "echo hello",
  registry,
  cwd: process.cwd(),
  adapter,
  stream: false,
  session,
  runtimeCache: {}
}));

assert.equal(result.ok, true);
assert.equal(result.stopReason, "done");
assert.equal(result.response, "done after tool");
});
