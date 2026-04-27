import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CodingAgent } from "../src/agent/interface.mjs";
import { MockAgent } from "../src/agent/adapters/mock.mjs";
import { UpstageAgent } from "../src/agent/adapters/upstage.mjs";
import { ClaudeCodeAgent } from "../src/agent/adapters/claude-code.mjs";
import { AiderAgent } from "../src/agent/adapters/aider.mjs";
import { OpenCodeAgent } from "../src/agent/adapters/opencode.mjs";
import { AgentRegistry, defaultRegistry } from "../src/agent/registry.mjs";
import { comparisonTable, deltaColumn } from "../src/report/table.mjs";

// ── CodingAgent abstract base ─────────────────────────────────────────────────

describe("CodingAgent — interface contract", () => {
  it("base class run() throws", async () => {
    const agent = new CodingAgent();
    await assert.rejects(() => agent.run({}, {}), /not implemented/);
  });

  it("base class id returns empty string", () => {
    assert.equal(new CodingAgent().id, "");
  });

  it("base class isAvailable() returns true", () => {
    assert.equal(new CodingAgent().isAvailable(), true);
  });
});

// ── MockAgent ─────────────────────────────────────────────────────────────────

describe("MockAgent — README.fixture.md parsing", () => {
  let tmp;
  const setup = () => { tmp = mkdtempSync(join(tmpdir(), "h5-mock-")); };
  const teardown = () => { rmSync(tmp, { recursive: true, force: true }); };

  it("parses single file block correctly", async () => {
    setup();
    writeFileSync(join(tmp, "README.fixture.md"), [
      "## Expected Fix",
      "### file: src/app.py",
      "```",
      "x = 1",
      "```"
    ].join("\n"));
    const result = await new MockAgent().run({}, { workdir: tmp });
    assert.equal(result.ok, true);
    assert.equal(result.toolCalls, 1);
    teardown();
  });

  it("parses multiple file blocks", async () => {
    setup();
    writeFileSync(join(tmp, "README.fixture.md"), [
      "## Expected Fix",
      "### file: a.py",
      "```",
      "a = 1",
      "```",
      "### file: b.py",
      "```",
      "b = 2",
      "```"
    ].join("\n"));
    const result = await new MockAgent().run({}, { workdir: tmp });
    assert.equal(result.ok, true);
    assert.equal(result.toolCalls, 2);
    teardown();
  });

  it("returns ok:false with no Expected Fix section", async () => {
    setup();
    writeFileSync(join(tmp, "README.fixture.md"), "# Just a README\nNo fix here.");
    const result = await new MockAgent().run({}, { workdir: tmp });
    assert.equal(result.ok, false);
    teardown();
  });
});

// ── External adapters — isAvailable() ────────────────────────────────────────

describe("External adapters — isAvailable()", () => {
  it("ClaudeCodeAgent.isAvailable() returns boolean", () => {
    const r = new ClaudeCodeAgent().isAvailable();
    assert.equal(typeof r, "boolean");
  });

  it("AiderAgent.isAvailable() returns boolean", () => {
    const r = new AiderAgent().isAvailable();
    assert.equal(typeof r, "boolean");
  });

  it("OpenCodeAgent.isAvailable() returns boolean", () => {
    const r = new OpenCodeAgent().isAvailable();
    assert.equal(typeof r, "boolean");
  });

  it("UpstageAgent.isAvailable() returns false when UPSTAGE_API_KEY unset", () => {
    const saved = process.env.UPSTAGE_API_KEY;
    delete process.env.UPSTAGE_API_KEY;
    assert.equal(new UpstageAgent().isAvailable(), false);
    if (saved) process.env.UPSTAGE_API_KEY = saved;
  });
});

// ── External adapters — id / displayName ─────────────────────────────────────

describe("External adapters — metadata", () => {
  it("ClaudeCodeAgent has id='claude-code'", () => {
    assert.equal(new ClaudeCodeAgent().id, "claude-code");
  });

  it("AiderAgent has id='aider'", () => {
    assert.equal(new AiderAgent().id, "aider");
  });

  it("OpenCodeAgent has id='opencode'", () => {
    assert.equal(new OpenCodeAgent().id, "opencode");
  });

  it("model option reflected in displayName", () => {
    assert.ok(new ClaudeCodeAgent({ model: "claude-opus-4" }).displayName.includes("claude-opus-4"));
    assert.ok(new AiderAgent({ model: "gpt-4o" }).displayName.includes("gpt-4o"));
  });
});

// ── AgentRegistry ─────────────────────────────────────────────────────────────

describe("AgentRegistry", () => {
  it("resolves 'mock' to MockAgent", () => {
    const reg = new AgentRegistry();
    assert.ok(reg.resolve("mock") instanceof MockAgent);
  });

  it("resolves all known aliases without throwing", () => {
    const reg = new AgentRegistry();
    for (const id of ["mock", "upstage", "solar", "claude", "claude-code", "aider", "opencode"]) {
      assert.doesNotThrow(() => reg.resolve(id));
    }
  });

  it("throws on unknown agent id", () => {
    const reg = new AgentRegistry();
    assert.throws(() => reg.resolve("nonexistent-agent-xyz"), /Unknown agent/);
  });

  it("register() adds a custom adapter", () => {
    const reg = new AgentRegistry();
    class MyAgent extends CodingAgent { get id() { return "my-agent"; } }
    reg.register(["my-agent"], () => new MyAgent());
    assert.ok(reg.resolve("my-agent") instanceof MyAgent);
  });

  it("listAvailable() returns array with id and available fields", () => {
    const reg = new AgentRegistry();
    const list = reg.listAvailable();
    assert.ok(Array.isArray(list));
    assert.ok(list.every((e) => typeof e.id === "string" && typeof e.available === "boolean"));
  });

  it("defaultRegistry is an AgentRegistry instance", () => {
    assert.ok(defaultRegistry instanceof AgentRegistry);
  });
});

// ── comparisonTable ───────────────────────────────────────────────────────────

describe("comparisonTable", () => {
  function makeRun(agentId, status, score = 0.9, ftp = 1, ptp = 1) {
    return {
      agentId,
      status,
      durationMs: 60000,
      evaluation: { score, failToPassRate: ftp, passToPassRate: ptp },
      metrics: { toolCalls: 5, estimatedCostUsd: 0.04, patch: { linesAdded: 1, linesRemoved: 0 } },
      failure: null
    };
  }

  it("returns a non-empty string for a single run", () => {
    const table = comparisonTable([makeRun("mock", "pass")]);
    assert.ok(typeof table === "string" && table.length > 0);
  });

  it("contains agent id in output", () => {
    const table = comparisonTable([makeRun("upstage-solar", "pass")]);
    assert.ok(table.includes("upstage-solar"));
  });

  it("PASS and FAIL markers both appear with mixed results", () => {
    const table = comparisonTable([makeRun("agent-a", "pass"), makeRun("agent-b", "fail")]);
    assert.ok(table.includes("PASS"));
    assert.ok(table.includes("FAIL"));
  });

  it("returns 'No runs' message for empty array", () => {
    assert.ok(comparisonTable([]).includes("No runs"));
  });

  it("table has a header separator row", () => {
    const table = comparisonTable([makeRun("x", "pass")]);
    assert.ok(table.includes("|-"));
  });
});
