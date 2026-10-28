import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTask } from "../src/task/loader.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { defaultRegistry } from "../src/agent/registry.mjs";
import { LOCAL_MODELS } from "../src/agent/local-models.mjs";

// Stage B: drive the REAL harness pipeline (TaskRunner → buildAgentRegistry's real
// tool registry → native sandbox → checks → scorer → provenance) with the
// LocalModelAgent, mocking only the model HTTP endpoint. Uses the existing
// fix-flaky-test fixture (node-based checks, no python deps).

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_PATH = resolve(HERE, "../tasks/fix-flaky-test.yaml");

// The correct fix (README.fixture.md): add `await` before fetchData(...).
const FIXED_TEST_FILE = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchData, parseConfig } from "../fetcher.mjs";

describe("fetchData", () => {
  it("test_data_fetch — returns data array", async () => {
    const result = await fetchData("https://example.com/api");
    assert.ok(Array.isArray(result.data), "data should be an array");
  });
});

describe("parseConfig", () => {
  it("test_config — parses valid JSON string", () => {
    const cfg = parseConfig('{"debug":true,"port":3000}');
    assert.equal(cfg.debug, true);
    assert.equal(cfg.port, 3000);
  });

  it("test_parse — throws on non-string input", () => {
    assert.throws(() => parseConfig(123), /config must be a string/);
  });
});
`;

const realFetch = globalThis.fetch;
let callCount = 0;

/** Install a /chat/completions handler; non-model fetches fall through to real fetch. */
function stubModel(handler) {
  callCount = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/chat/completions")) {
      callCount += 1;
      return handler(callCount, opts);
    }
    return realFetch(url, opts);
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function assistantToolCall(name, args) {
  return json({
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${callCount}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
  });
}
function assistantStop(text) {
  return json({
    choices: [{ message: { role: "assistant", content: text, reasoning: "I have applied the fix." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 60, completion_tokens: 5, total_tokens: 65 }
  });
}

let savedCritic;
before(() => { savedCritic = process.env.UPSTAGE_CRITIC_DISABLED; process.env.UPSTAGE_CRITIC_DISABLED = "true"; });
after(() => { if (savedCritic === undefined) delete process.env.UPSTAGE_CRITIC_DISABLED; else process.env.UPSTAGE_CRITIC_DISABLED = savedCritic; });
beforeEach(() => { callCount = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("Local model config/provenance (no network)", () => {
  it("every model carries a pinned revision, quantization, runtime and image", () => {
    for (const [key, cfg] of Object.entries(LOCAL_MODELS)) {
      const p = cfg.provenance;
      assert.ok(/^[0-9a-f]{40}$/.test(p.revision), `${key} revision must be a pinned 40-hex sha`);
      assert.ok(p.quantization && typeof p.quantization === "string", `${key} quantization`);
      assert.ok(p.servingRuntime.includes("vLLM"), `${key} runtime`);
      assert.ok(/@sha256:[0-9a-f]{64}$/.test(p.servingImage), `${key} image digest pinned`);
      assert.equal(typeof p.official, "boolean");
    }
  });

  it("Solar Open 2 is explicitly marked UNOFFICIAL (Nota NVFP4), others official", () => {
    assert.equal(LOCAL_MODELS["solar-open2"].provenance.official, false);
    assert.equal(LOCAL_MODELS["solar-open2"].provenance.quantizationSource, "Nota AI (third-party community quant)");
    assert.equal(LOCAL_MODELS.kanana.provenance.official, true);
    assert.equal(LOCAL_MODELS.exaone.provenance.official, true);
    assert.equal(LOCAL_MODELS.ax.provenance.official, true);
  });

  it("per-model parsers and Solar's required Mamba cap match the validated serving config", () => {
    assert.equal(LOCAL_MODELS.kanana.provenance.reasoningParser, "deepseek_r1");
    assert.equal(LOCAL_MODELS.exaone.provenance.reasoningParser, "qwen3");
    assert.equal(LOCAL_MODELS.ax.provenance.reasoningParser, null); // non-thinking
    assert.equal(LOCAL_MODELS["solar-open2"].provenance.reasoningParser, "solar_open2");
    assert.equal(LOCAL_MODELS["solar-open2"].provenance.maxNumSeqs, 256);
    assert.equal(LOCAL_MODELS["solar-open2"].contextLimit, 8192); // validated ceiling
  });

  it("EXAONE thinking on/off are distinct configs on the same checkpoint", () => {
    assert.deepEqual(LOCAL_MODELS.exaone.chatTemplateKwargs, { enable_thinking: true });
    assert.deepEqual(LOCAL_MODELS["exaone-nothink"].chatTemplateKwargs, { enable_thinking: false });
    assert.equal(LOCAL_MODELS.exaone.provenance.revision, LOCAL_MODELS["exaone-nothink"].provenance.revision);
  });
});

describe("LocalModelAgent — full harness pipeline (mocked endpoint)", () => {
  it("writes the real fix via the registry → task PASSES with correct provenance", async () => {
    stubModel((n) => (n === 1 ? assistantToolCall("write_file", { path: "tests/fetcher.test.mjs", content: FIXED_TEST_FILE }) : assistantStop("Fixed.")));
    const task = loadTask(TASK_PATH);
    const adapter = defaultRegistry.resolve("kanana");
    const runner = new TaskRunner({ runsDir: null });

    const result = await runner.run(task, adapter);

    assert.equal(result.status, "pass", `expected pass, got ${result.status} (${result.outcome?.detail})`);
    assert.equal(result.outcome.reason, "all_required_checks_passed");
    // Edit really happened through the registry and was captured in the patch
    assert.ok(result.patch.filesChanged.includes("tests/fetcher.test.mjs"));
    // The CLI's own cache (.upstage-cli/) is excluded from the patch, so only the real edit shows.
    assert.ok(!result.patch.filesChanged.some((f) => f.startsWith(".upstage-cli/")));
    assert.ok(result.metrics.toolCalls >= 1); // metrics.toolCalls is the count; trace.toolCalls is the list
    assert.ok(result.trace.toolCalls.length >= 1);
    // Provenance recorded verbatim from the agent
    const m = result.provenance.model;
    assert.equal(m.provider, "local-vllm");
    assert.equal(m.id, "Kanana-2");
    assert.equal(m.revision, "cdcbf8b811c21366f20f8a10a1f83183433c0844");
    assert.equal(m.official, true);
    assert.equal(m.reasoningParser, "deepseek_r1");
    assert.equal(m.toolCallParser, "hermes");
    assert.ok(m.servingImage.includes("@sha256:"));
    // reasoning kept separate and never scored; providerReasoningTokens null (deepseek_r1 unreliable)
    assert.equal(typeof m.reasoning.reasoningChars === "number" || m.reasoning.reasoningChars === null, true);
    assert.equal(m.reasoning.providerReasoningTokens, null);
    // tool schema hash present
    assert.ok(result.provenance.tools.schemaHash && result.provenance.tools.schemaHash.length === 64);
  });

  it("a model/infrastructure failure is status=error, not a task failure", async () => {
    stubModel(() => new Response("upstream is down", { status: 500 }));
    const task = loadTask(TASK_PATH);
    const adapter = defaultRegistry.resolve("exaone");
    const runner = new TaskRunner({ runsDir: null });

    const result = await runner.run(task, adapter);

    assert.equal(result.status, "error");
    assert.equal(result.outcome.reason, "agent_adapter_error");
    assert.match(String(result.outcome.detail || result.trace.agentError || ""), /server_error|500/);
    assert.notEqual(result.status, "fail"); // must stay distinguishable from a real task failure
  });

  it("a no-op agent (no edit) does NOT pass — the fail_to_pass check still fails", async () => {
    stubModel(() => assistantStop("I think it looks fine as-is."));
    const task = loadTask(TASK_PATH);
    const adapter = defaultRegistry.resolve("ax");
    const runner = new TaskRunner({ runsDir: null });

    const result = await runner.run(task, adapter);

    assert.equal(result.status, "fail");
    assert.equal(result.outcome.reason, "required_check_failed");
    assert.equal(result.patch.filesChanged.length, 0);
    // A.X is non-thinking → no reasoning parser in provenance
    assert.equal(result.provenance.model.reasoningParser, null);
  });

  it("a truncated completion (finish_reason=length) is recorded as output_truncated, never a pass", async () => {
    // Model runs out of output budget mid-reasoning and emits no tool call.
    stubModel(() => json({
      choices: [{ message: { role: "assistant", content: "Let me think about this. First I will", reasoning: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 40, completion_tokens: 8192, total_tokens: 8232 }
    }));
    const task = loadTask(TASK_PATH);
    const adapter = defaultRegistry.resolve("kanana");
    const result = await new TaskRunner({ runsDir: null }).run(task, adapter);

    assert.notEqual(result.status, "pass"); // truncation must never be a success
    assert.equal(result.trace.stopReason, "output_truncated"); // preserved in the trace
    assert.equal(result.patch.filesChanged.length, 0); // nothing was edited
    // classified as a runtime truncation, not a wrong-answer failure
    assert.equal(result.failure?.symptom, "output_truncated");
  });
});
