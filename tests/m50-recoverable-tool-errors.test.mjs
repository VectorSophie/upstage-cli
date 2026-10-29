// A failed tool call is returned to the model instead of ending the run; after
// REPLAN_CONSECUTIVE_FAILURE_THRESHOLD (3) consecutive failures a re-plan
// message is injected (at most REPLAN_MAX_REPLANS = 2 times), then the run
// stops with tool_error. Before this, the first failure always ended the run,
// so the threshold and re-plan were unreachable. Private HOME (see m9).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { runAgentLoop, collectAgentLoop } from "../src/agent/loop.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";
import { createSession } from "../src/runtime/session.mjs";

async function withHome(fn) {
  const home = await mkdtemp(join(os.tmpdir(), "m50-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  }
}

function registry() {
  const r = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  r.register({
    name: "readf", description: "read", risk: "low", actionClass: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    async execute(args) {
      if (args.path !== "ok.txt") throw Object.assign(new Error(`ENOENT: ${args.path}`), { code: "ENOENT" });
      return { text: "contents" };
    }
  });
  return r;
}

const call = (id, path) => ({ id, type: "function", function: { name: "readf", arguments: JSON.stringify({ path }) } });
const run = (adapter, extra = {}) =>
  collectAgentLoop(runAgentLoop({ input: "task", registry: registry(), cwd: process.cwd(), adapter, stream: false, session: createSession(process.cwd()), ...extra }));

test("a single failed tool call is shown to the model, which can recover", async () => {
  await withHome(async () => {
    const requests = [];
    const adapter = {
      isConfigured: () => true,
      async complete({ messages }) {
        requests.push(messages);
        if (requests.length === 1) return { content: "", toolCalls: [call("a", "missing.txt")] };
        if (requests.length === 2) return { content: "", toolCalls: [call("b", "ok.txt")] };
        return { content: "done", toolCalls: [] };
      }
    };
    const { result, events } = await run(adapter);
    assert.equal(result.stopReason, "done");
    assert.equal(requests.length, 3);
    const errMsg = requests[1].find((m) => m.role === "tool" && m.tool_call_id === "a");
    assert.ok(errMsg && /ENOENT/.test(errMsg.content), "the model saw its tool error");
    assert.ok(events.some((e) => e.code === "TOOL_ERROR_RECOVERABLE"));
  });
});

test("persistent failures: two re-plans, then tool_error — bounded at 9 requests", async () => {
  await withHome(async () => {
    let n = 0;
    // a different missing path each time, so the separate tool-loop detector
    // (identical calls) does not fire and only the failure counter is tested
    const adapter = { isConfigured: () => true, async complete() { n += 1; return { content: "", toolCalls: [call(`c${n}`, `missing-${n}.txt`)] }; } };
    const { result, events } = await run(adapter, { budget: { maxSteps: 50, maxToolCalls: 100, maxWallTimeMs: 60000 } });
    assert.equal(result.stopReason, "tool_error");
    assert.equal(n, 9, "2 failures + re-plan, x2, then 3 failures and stop");
    assert.deepEqual(events.filter((e) => e.type === "replan").map((e) => e.trigger), ["consecutive_failures", "consecutive_failures"]);
  });
});

test("a policy block still stops immediately", async () => {
  await withHome(async () => {
    const r = new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
    r.register({
      name: "readf", description: "read", risk: "low", actionClass: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      async execute() { throw Object.assign(new Error("blocked by policy"), { code: "POLICY_BLOCKED" }); }
    });
    let n = 0;
    const adapter = { isConfigured: () => true, async complete() { n += 1; return { content: "", toolCalls: [call(`p${n}`, "x")] }; } };
    const { result } = await collectAgentLoop(runAgentLoop({ input: "task", registry: r, cwd: process.cwd(), adapter, stream: false, session: createSession(process.cwd()) }));
    assert.equal(result.stopReason, "policy_blocked");
    assert.equal(n, 1);
  });
});

test("a multi-call turn with a failure: the call that never ran gets an explicit result", async () => {
  await withHome(async () => {
    const requests = [];
    const adapter = {
      isConfigured: () => true,
      async complete({ messages }) {
        requests.push(messages);
        if (requests.length === 1) return { content: "", toolCalls: [call("x1", "missing.txt"), call("x2", "ok.txt")] };
        return { content: "done", toolCalls: [] };
      }
    };
    const { result } = await run(adapter);
    assert.equal(result.stopReason, "done");
    const second = requests[1];
    const assistant = second.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.ok(assistant, "the failing turn is still in the request");
    const ids = second.filter((m) => m.role === "tool").map((m) => m.tool_call_id).sort();
    assert.deepEqual(ids, ["x1", "x2"]);
  });
});
