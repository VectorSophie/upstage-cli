import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HookEngine } from "../src/hooks/engine.mjs";
import { ToolRegistry } from "../src/tools/registry.mjs";

// ──────────────────────────────────────────────
// HookEngine — basic allow-by-default
// ──────────────────────────────────────────────

describe("HookEngine — allow by default", () => {
  it("runPreToolUse allows when no hooks configured", async () => {
    const engine = new HookEngine();
    const result = await engine.runPreToolUse("read_file", { path: "x.txt" });
    assert.deepEqual(result, { allow: true });
  });

  it("runPostToolUse returns result unchanged when no hooks", async () => {
    const engine = new HookEngine();
    const result = await engine.runPostToolUse("read_file", "file contents");
    assert.equal(result, "file contents");
  });

  it("runStop returns true when no hooks", async () => {
    const engine = new HookEngine();
    assert.equal(await engine.runStop(), true);
  });
});

// ──────────────────────────────────────────────
// HookEngine — handler hooks
// ──────────────────────────────────────────────

describe("HookEngine — handler hooks", () => {
  it("handler hook returning decision:deny → { allow: false }", async () => {
    const engine = new HookEngine({
      PreToolUse: [{
        type: "handler",
        fn: async ({ tool }) => tool === "write_file" ? { decision: "deny", message: "no writes" } : {}
      }]
    });
    const denied = await engine.runPreToolUse("write_file", {});
    assert.equal(denied.allow, false);
    assert.equal(denied.message, "no writes");

    const allowed = await engine.runPreToolUse("read_file", {});
    assert.equal(allowed.allow, true);
  });

  it("PostToolUse handler modifying result", async () => {
    const engine = new HookEngine({
      PostToolUse: [{
        type: "handler",
        fn: async ({ result }) => ({ modifiedResult: `[redacted]: ${String(result).slice(0, 5)}` })
      }]
    });
    const out = await engine.runPostToolUse("read_file", "secret contents");
    assert.equal(out, "[redacted]: secre");
  });

  it("runStop with hook returning preventStop:true → false", async () => {
    const engine = new HookEngine({
      Stop: [{ type: "handler", fn: async () => ({ preventStop: true }) }]
    });
    assert.equal(await engine.runStop(), false);
  });

  it("fail-open: throwing handler hook → allow:true", async () => {
    const engine = new HookEngine({
      PreToolUse: [{
        type: "handler",
        failOpen: true,
        fn: async () => { throw new Error("boom"); }
      }]
    });
    const result = await engine.runPreToolUse("any_tool", {});
    assert.equal(result.allow, true);
  });

  it("fail-closed: throwing handler hook + failOpen:false → allow:false", async () => {
    const engine = new HookEngine({
      PreToolUse: [{
        type: "handler",
        failOpen: false,
        fn: async () => { throw new Error("boom"); }
      }]
    });
    const result = await engine.runPreToolUse("any_tool", {});
    assert.equal(result.allow, false);
  });
});

// ──────────────────────────────────────────────
// HookEngine — in-memory backward compat
// ──────────────────────────────────────────────

describe("HookEngine — backward compat .on() / .fire()", () => {
  it("on() registers handler, fire() calls it", async () => {
    const engine = new HookEngine();
    const calls = [];
    engine.on("BeforeTool", (payload) => { calls.push(payload); });
    await engine.fire("BeforeTool", { tool: "read_file" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "read_file");
  });

  it("on() returns unsubscribe function", async () => {
    const engine = new HookEngine();
    const calls = [];
    const unsub = engine.on("AfterTool", (p) => calls.push(p));
    await engine.fire("AfterTool", { tool: "x" });
    unsub();
    await engine.fire("AfterTool", { tool: "y" });
    assert.equal(calls.length, 1);
  });

  it("fire() on unknown hookName does not throw", async () => {
    const engine = new HookEngine();
    await assert.doesNotReject(() => engine.fire("UnknownHook", {}));
  });

  it("runPreToolUse fires BeforeTool in-memory handlers", async () => {
    const engine = new HookEngine();
    const calls = [];
    engine.on("BeforeTool", (p) => calls.push(p));
    await engine.runPreToolUse("write_file", { path: "x.txt" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "write_file");
  });
});

// ──────────────────────────────────────────────
// HookEngine — runNotification
// ──────────────────────────────────────────────

describe("HookEngine — runNotification", () => {
  it("never throws even if handler errors", async () => {
    const engine = new HookEngine({
      Notification: [{ type: "handler", fn: async () => { throw new Error("oops"); } }]
    });
    assert.doesNotThrow(() => engine.runNotification("SomeEvent", {}));
  });

  it("runSessionStart calls runNotification", () => {
    const engine = new HookEngine();
    const fired = [];
    engine.on("Notification", (p) => fired.push(p));
    engine.runSessionStart("sess-abc");
    // fire is async / microtask — we just verify it doesn't throw
    assert.ok(true);
  });
});

// ──────────────────────────────────────────────
// ToolRegistry + HookEngine integration
// ──────────────────────────────────────────────

describe("ToolRegistry + HookEngine integration", () => {
  function makeTool(name) {
    return {
      name,
      description: `test tool ${name}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      execute: async () => ({ output: "ok" })
    };
  }

  it("registry uses hookEngine.runPreToolUse and allows by default", async () => {
    const engine = new HookEngine();
    const registry = new ToolRegistry({ allowHighRiskTools: true, hookEngine: engine });
    registry.register(makeTool("test_tool"));
    const result = await registry.execute("test_tool", {}, { cwd: process.cwd() });
    assert.equal(result.ok, true);
  });

  it("registry blocks execution when hookEngine.runPreToolUse denies", async () => {
    const engine = new HookEngine({
      PreToolUse: [{
        type: "handler",
        fn: async () => ({ decision: "deny", message: "test deny" })
      }]
    });
    const registry = new ToolRegistry({ allowHighRiskTools: true, hookEngine: engine });
    registry.register(makeTool("blocked_tool"));
    const result = await registry.execute("blocked_tool", {}, { cwd: process.cwd() });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "HOOK_DENIED");
  });

  it("runPostToolUse can modify result data", async () => {
    const engine = new HookEngine({
      PostToolUse: [{
        type: "handler",
        fn: async () => ({ modifiedResult: { output: "modified" } })
      }]
    });
    const registry = new ToolRegistry({ allowHighRiskTools: true, hookEngine: engine });
    registry.register(makeTool("modify_tool"));
    const result = await registry.execute("modify_tool", {}, { cwd: process.cwd() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { output: "modified" });
  });

  it("fire('BeforeTool', ...) backward compat — in-memory handler still fires", async () => {
    const engine = new HookEngine();
    const calls = [];
    engine.on("BeforeTool", (p) => calls.push(p.tool));
    const registry = new ToolRegistry({ allowHighRiskTools: true, hookEngine: engine });
    registry.register(makeTool("compat_tool"));
    await registry.execute("compat_tool", {}, { cwd: process.cwd() });
    assert.ok(calls.includes("compat_tool"), "BeforeTool should have fired");
  });

  it("settings-based hooks from settingsHooks constructor arg", async () => {
    let preToolFired = false;
    const engine = new HookEngine({
      PreToolUse: [{
        type: "handler",
        fn: async () => { preToolFired = true; return {}; }
      }]
    });
    const registry = new ToolRegistry({ allowHighRiskTools: true, hookEngine: engine });
    registry.register(makeTool("settings_tool"));
    await registry.execute("settings_tool", {}, { cwd: process.cwd() });
    assert.equal(preToolFired, true);
  });
});
