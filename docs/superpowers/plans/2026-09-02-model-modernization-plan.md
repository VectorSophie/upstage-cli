# Model Modernization (Thread A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move upstage-cli off hardcoded Solar-Pro2-era assumptions (default model, 65,536-token context ceiling, no reasoning-effort/parallel-tool-calls wiring) onto a per-model capability table, defaulting to `solar-pro4`.

**Architecture:** One new module, `src/model/model-capabilities.mjs`, becomes the single source of truth for per-model limits/features. Every place that currently hardcodes a Pro2-era number or reads `process.env.UPSTAGE_MODEL_CONTEXT_LIMIT` directly is updated to read through this table instead, keyed by `adapter.model`.

**Tech Stack:** Node.js built-in test runner (`node --test`), ESM (`.mjs`), no new dependencies.

---

### Task 1: Model capability table

**Files:**
- Create: `src/model/model-capabilities.mjs`
- Test: `tests/m30-model-capabilities.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModelCapabilities } from "../src/model/model-capabilities.mjs";

describe("getModelCapabilities", () => {
  it("returns Pro4 capabilities with the large context window and reasoning support", () => {
    const caps = getModelCapabilities("solar-pro4");
    assert.equal(caps.contextLimit, 512_000);
    assert.equal(caps.supportsReasoningEffort, true);
    assert.equal(caps.supportsParallelToolCalls, true);
    assert.equal(caps.supportsResponseFormat, true);
    assert.equal(caps.promptTier, "minimal");
  });

  it("returns Pro3 capabilities without reasoning-effort support", () => {
    const caps = getModelCapabilities("solar-pro3");
    assert.equal(caps.contextLimit, 65_536);
    assert.equal(caps.supportsReasoningEffort, false);
    assert.equal(caps.supportsResponseFormat, true);
    assert.equal(caps.promptTier, "full");
  });

  it("returns Pro2 capabilities as the conservative baseline", () => {
    const caps = getModelCapabilities("solar-pro2");
    assert.equal(caps.contextLimit, 65_536);
    assert.equal(caps.supportsReasoningEffort, false);
    assert.equal(caps.supportsParallelToolCalls, false);
    assert.equal(caps.supportsResponseFormat, false);
    assert.equal(caps.promptTier, "full");
  });

  it("is case-insensitive", () => {
    assert.equal(getModelCapabilities("Solar-Pro4").contextLimit, 512_000);
  });

  it("falls back to the Pro2 baseline for an unrecognized model id", () => {
    const caps = getModelCapabilities("some-future-model");
    assert.deepEqual(caps, getModelCapabilities("solar-pro2"));
  });

  it("falls back to the Pro2 baseline for a missing model id", () => {
    assert.deepEqual(getModelCapabilities(undefined), getModelCapabilities("solar-pro2"));
    assert.deepEqual(getModelCapabilities(null), getModelCapabilities("solar-pro2"));
    assert.deepEqual(getModelCapabilities(""), getModelCapabilities("solar-pro2"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/m30-model-capabilities.test.mjs`
Expected: FAIL — `Cannot find module '../src/model/model-capabilities.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/model/model-capabilities.mjs
//
// Single source of truth for per-model limits/features, so upgrading Solar
// models doesn't mean hunting down hardcoded numbers across the codebase.
//
// Provenance notes (2026-09-02):
// - solar-pro4's contextLimit (512K) and supportsReasoningEffort are from
//   Upstage's own Pro4 launch blog (upstage.ai/blog/en/solar-pro-4).
// - solar-pro2/solar-pro3's contextLimit (65,536) is the pre-existing
//   conservative default already used in this codebase, NOT an independently
//   confirmed published number for either model — Upstage's public materials
//   don't state a context window for Pro2, and Pro3's launch post describes
//   it as API-compatible with Pro2 rather than stating a new number.
// - supportsParallelToolCalls and supportsResponseFormat reflect what's
//   confirmed via OpenRouter's model pages for Pro3/Pro4; live-verify against
//   the actual Upstage API before relying on this for anything safety-critical.

const CAPABILITIES = {
  "solar-pro4": {
    contextLimit: 512_000,
    supportsReasoningEffort: true,
    supportsParallelToolCalls: true,
    supportsResponseFormat: true,
    promptTier: "minimal"
  },
  "solar-pro3": {
    contextLimit: 65_536,
    supportsReasoningEffort: false,
    supportsParallelToolCalls: false,
    supportsResponseFormat: true,
    promptTier: "full"
  },
  "solar-pro2": {
    contextLimit: 65_536,
    supportsReasoningEffort: false,
    supportsParallelToolCalls: false,
    supportsResponseFormat: false,
    promptTier: "full"
  }
};

const FALLBACK = CAPABILITIES["solar-pro2"];

export function getModelCapabilities(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return FALLBACK;
  }
  return CAPABILITIES[modelId.toLowerCase()] || FALLBACK;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/m30-model-capabilities.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/model/model-capabilities.mjs tests/m30-model-capabilities.test.mjs
git commit -m "feat: add per-model capability table (solar-pro2/pro3/pro4)"
```

---

### Task 2: Register Pro3/Pro4 in the provider registry

**Files:**
- Modify: `src/core/providers.mjs:8`
- Modify: `tests/m15-providers-streaming.test.mjs`

**Why:** `PROVIDERS.upstage.models` currently lists only `["solar-pro2", "solar-pro", "solar-mini"]`. Routing (`getProvider`) already works for Pro3/Pro4 via the `startsWith("solar")` prefix check, but anything that lists available models from this array (a future `/model` picker, `listProviders()` consumers) would be missing them.

- [ ] **Step 1: Write the failing test**

Add to `tests/m15-providers-streaming.test.mjs`, inside the existing `describe("getProvider", ...)` block or as a new one — append after the existing `it("defaults unknown model to upstage", ...)` block:

```js
describe("PROVIDERS.upstage.models", () => {
  it("lists solar-pro3 and solar-pro4 alongside the existing models", () => {
    const { PROVIDERS } = getProvider("solar-pro2");
    // getProvider returns the provider object itself, so re-import directly
    // for the models array — see next line for the actual assertion.
  });
});
```

Replace that placeholder block with the real test — import `PROVIDERS` directly at the top of the file alongside the existing imports:

```js
import { getProvider, getProviderByName, listProviders, checkProviderKeys, PROVIDERS } from "../src/core/providers.mjs";
```

```js
describe("PROVIDERS.upstage.models", () => {
  it("lists solar-pro3 and solar-pro4 alongside the existing models", () => {
    assert.ok(PROVIDERS.upstage.models.includes("solar-pro3"));
    assert.ok(PROVIDERS.upstage.models.includes("solar-pro4"));
    assert.ok(PROVIDERS.upstage.models.includes("solar-pro2"));
  });

  it("still routes solar-pro3 and solar-pro4 to the upstage provider", () => {
    assert.equal(getProvider("solar-pro3").id, "upstage");
    assert.equal(getProvider("solar-pro4").id, "upstage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/m15-providers-streaming.test.mjs`
Expected: FAIL — `models.includes("solar-pro3")` is false

- [ ] **Step 3: Update the implementation**

In `src/core/providers.mjs`, change line 8:

```js
    models: ["solar-pro2", "solar-pro", "solar-mini"],
```
to:
```js
    models: ["solar-pro4", "solar-pro3", "solar-pro2", "solar-pro", "solar-mini"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/m15-providers-streaming.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/providers.mjs tests/m15-providers-streaming.test.mjs
git commit -m "feat: register solar-pro3/pro4 in the provider registry"
```

---

### Task 3: Default model → solar-pro4

**Files:**
- Modify: `src/model/upstage-adapter.mjs:5`
- Modify: `tests/m15-providers-streaming.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `tests/m15-providers-streaming.test.mjs` (this file already imports `UpstageAdapter`):

```js
describe("UpstageAdapter default model", () => {
  it("defaults to solar-pro4 when no model or UPSTAGE_MODEL env var is set", () => {
    const originalEnv = process.env.UPSTAGE_MODEL;
    delete process.env.UPSTAGE_MODEL;
    try {
      const adapter = new UpstageAdapter({ apiKey: "test-key" });
      assert.equal(adapter.model, "solar-pro4");
    } finally {
      if (originalEnv === undefined) delete process.env.UPSTAGE_MODEL;
      else process.env.UPSTAGE_MODEL = originalEnv;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/m15-providers-streaming.test.mjs`
Expected: FAIL — `adapter.model` is `"solar-pro2"`, not `"solar-pro4"`

- [ ] **Step 3: Update the implementation**

In `src/model/upstage-adapter.mjs`, change line 5:

```js
const DEFAULT_MODEL = process.env.UPSTAGE_MODEL || "solar-pro2";
```
to:
```js
const DEFAULT_MODEL = process.env.UPSTAGE_MODEL || "solar-pro4";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/m15-providers-streaming.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full test suite to check for regressions from the default-model change**

Run: `npm test`
Expected: PASS — no test should depend on `solar-pro2` being the *default* (tests that need Pro2 specifically already pass `model: "solar-pro2"` explicitly, per the pattern seen in `tests/m7-robustness.test.mjs`). If anything fails here, read the failure before changing this default further — don't silence it.

- [ ] **Step 6: Commit**

```bash
git add src/model/upstage-adapter.mjs tests/m15-providers-streaming.test.mjs
git commit -m "feat: default UpstageAdapter to solar-pro4"
```

---

### Task 4: Wire parallel_tool_calls and reasoning_effort into the request payload

**Files:**
- Modify: `src/model/upstage-adapter.mjs`
- Test: `tests/m7-robustness.test.mjs` (already has the fetch-mocking pattern for this adapter)

- [ ] **Step 1: Write the failing tests**

Add to `tests/m7-robustness.test.mjs`, following the existing `globalThis.fetch` mock pattern used by the two tests already in that file:

```js
test("upstage adapter sends parallel_tool_calls for models that support it", async () => {
  const adapter = new UpstageAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    model: "solar-pro4"
  });

  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      stream: false
    });
    assert.equal(capturedBody.parallel_tool_calls, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstage adapter omits parallel_tool_calls for models that don't support it", async () => {
  const adapter = new UpstageAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    model: "solar-pro2"
  });

  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      stream: false
    });
    assert.equal("parallel_tool_calls" in capturedBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstage adapter sends reasoning_effort when requested on a supporting model", async () => {
  const adapter = new UpstageAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    model: "solar-pro4"
  });

  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoningEffort: "high"
    });
    assert.equal(capturedBody.reasoning_effort, "high");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstage adapter omits reasoning_effort on a non-supporting model even if requested", async () => {
  const adapter = new UpstageAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    model: "solar-pro2"
  });

  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoningEffort: "high"
    });
    assert.equal("reasoning_effort" in capturedBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/m7-robustness.test.mjs`
Expected: FAIL — `capturedBody.parallel_tool_calls` is `undefined`, `capturedBody.reasoning_effort` is `undefined`

- [ ] **Step 3: Update the implementation**

In `src/model/upstage-adapter.mjs`, add the import at the top:

```js
import { fetchWithRetry, normalizeUsage } from "./fetch-utils.mjs";
import { streamResponse, accumulateStream } from "../core/streaming.mjs";
import { getModelCapabilities } from "./model-capabilities.mjs";
```

Then change the `complete` method signature and payload construction:

```js
  async complete({ messages, tools = [], stream = true, onToken, toolChoice, reasoningEffort }) {
    if (!this.isConfigured()) {
      throw new Error("UPSTAGE_API_KEY is not configured");
    }

    const capabilities = getModelCapabilities(this.model);

    // Use "required" only on the very first user turn (no tool history yet) when the
    // last user message is clearly an action request. This stops Solar Pro2 from
    // describing what it would do instead of doing it.
    const ACTION_WORDS = /\b(read|write|create|edit|fix|add|run|list|find|search|delete|rename|move|show|check)\b/i;
    const hasToolResults = messages.some((m) => m.role === "tool");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const isActionPrompt = typeof lastUser?.content === "string" && ACTION_WORDS.test(lastUser.content);
    const resolvedToolChoice =
      toolChoice || (tools.length > 0 && !hasToolResults && isActionPrompt ? "required" : "auto");

    const payload = {
      model: this.model,
      messages,
      tools,
      tool_choice: resolvedToolChoice,
      temperature: this.temperature,
      stream
    };

    if (capabilities.supportsParallelToolCalls && tools.length > 0) {
      payload.parallel_tool_calls = true;
    }

    if (capabilities.supportsReasoningEffort && reasoningEffort) {
      payload.reasoning_effort = reasoningEffort;
    }
```

(The rest of the method — the `fetchWithRetry` call and response handling — stays unchanged.)

**Note for Task 5:** this task's `ACTION_WORDS` regex is the exact one Thread F's plan will reuse for hallucinated-completion detection — export it (`export const ACTION_WORDS = ...`) instead of leaving it as a function-local `const`, so it has one definition, not two. Move it above the `UpstageAdapter` class as a module-level export:

```js
export const ACTION_WORDS = /\b(read|write|create|edit|fix|add|run|list|find|search|delete|rename|move|show|check)\b/i;
```

and remove the now-duplicate local declaration inside `complete()`, referencing the module-level export instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/m7-robustness.test.mjs`
Expected: PASS (all 6 tests in this file, including the two pre-existing retry tests — confirm those still pass unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/model/upstage-adapter.mjs tests/m7-robustness.test.mjs
git commit -m "feat: wire parallel_tool_calls and reasoning_effort into request payload"
```

---

### Task 5: Parse reasoning content from responses

**Files:**
- Modify: `src/model/upstage-adapter.mjs` (`readJsonResponse`)
- Modify: `src/core/streaming.mjs` (`accumulateStream`)
- Test: `tests/m15-providers-streaming.test.mjs`

**Note on field-name uncertainty:** Upstage hasn't published the exact JSON field name for reasoning traces in Pro4 responses in anything found during this project's research. This implementation checks both `reasoning_content` (the convention used by DeepSeek-R1-style OpenAI-compatible APIs) and `reasoning` (a plausible alternative), preferring whichever is present. **Live-verify the actual field name against a real Solar Pro4 API response before relying on this for anything user-facing** — if the resulting `reasoning` value is always `null` in practice, that's the signal the field name guess was wrong, not that Pro4 isn't returning reasoning traces.

- [ ] **Step 1: Write the failing tests**

Add to `tests/m15-providers-streaming.test.mjs`:

```js
describe("accumulateStream reasoning content", () => {
  it("accumulates reasoning_content deltas separately from content", async () => {
    async function* fakeEvents() {
      yield 'data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}';
      yield 'data: {"choices":[{"delta":{"reasoning_content":"think."}}]}';
      yield 'data: {"choices":[{"delta":{"content":"The answer is 4."}}]}';
      yield "data: [DONE]";
    }
    const result = await accumulateStream(fakeEvents(), "openai");
    assert.equal(result.content, "The answer is 4.");
    assert.equal(result.reasoning, "Let me think.");
  });

  it("returns null reasoning when no reasoning deltas are present", async () => {
    async function* fakeEvents() {
      yield 'data: {"choices":[{"delta":{"content":"hi"}}]}';
      yield "data: [DONE]";
    }
    const result = await accumulateStream(fakeEvents(), "openai");
    assert.equal(result.reasoning, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/m15-providers-streaming.test.mjs`
Expected: FAIL — `result.reasoning` is `undefined`, not `"Let me think."` / `null`

- [ ] **Step 3: Update the implementation**

In `src/core/streaming.mjs`, inside `accumulateStream`, add reasoning accumulation:

```js
export async function accumulateStream(events, format = "openai", onToken) {
  const toolCalls = [];
  let content = "";
  let reasoning = "";
  let usage = null;

  for await (const rawEvent of events) {
    const { data } = parseSSEChunk(rawEvent);
    if (!data || data === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (_e) {
      continue;
    }

    if (format === "gemini") {
      // (unchanged gemini branch)
      const candidate = parsed.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (typeof text === "string" && text.length > 0) {
        content += text;
        if (typeof onToken === "function") onToken(text);
      }
      const geminiUsage = parsed.usageMetadata;
      if (geminiUsage) {
        usage = normalizeUsage({
          prompt_tokens: geminiUsage.promptTokenCount,
          completion_tokens: geminiUsage.candidatesTokenCount,
          total_tokens: geminiUsage.totalTokenCount
        });
      }
      continue;
    }

    // OpenAI format
    const chunkUsage = normalizeUsage(parsed.usage);
    if (chunkUsage) usage = chunkUsage;

    if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) continue;
    const delta = parsed.choices[0].delta || {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      if (typeof onToken === "function") onToken(delta.content);
    }

    const reasoningDelta = delta.reasoning_content || delta.reasoning;
    if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
      reasoning += reasoningDelta;
    }

    mergeToolCall(toolCalls, delta);
  }

  return { content, toolCalls: toolCalls.filter(Boolean), usage, reasoning: reasoning || null };
}
```

In `src/model/upstage-adapter.mjs`, update `readJsonResponse`:

```js
async function readJsonResponse(response) {
  const data = await response.json();
  const choice = Array.isArray(data.choices) && data.choices[0] ? data.choices[0] : null;
  const message = choice?.message || {};
  return {
    content: message.content || "",
    toolCalls: message.tool_calls || [],
    reasoning: message.reasoning_content || message.reasoning || null,
    usage: normalizeUsage(data.usage)
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/m15-providers-streaming.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/streaming.mjs src/model/upstage-adapter.mjs tests/m15-providers-streaming.test.mjs
git commit -m "feat: parse reasoning content from streaming and non-streaming responses"
```

---

### Task 6: Thread reasoning-effort settings through the agent loop

**Files:**
- Modify: `src/agent/loop.mjs` (`requestModelCompletion`, both call sites, and a new `resolveReasoningEffort` helper)
- Test: `tests/m1-runtime-transcript.test.mjs` (already exercises `runAgentLoop` end-to-end per its existing tests — check this file's imports/mock-adapter pattern before writing the new test, and match it)

- [ ] **Step 1: Write the failing test**

`tests/m1-runtime-transcript.test.mjs` already has the exact pattern to follow: a hand-rolled fake adapter object (`{ isConfigured() {...}, async complete({ messages }) {...} }`), a plain `new ToolRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false })` with no tools registered when the test doesn't need any, `createSession(process.cwd())`, and `collectAgentLoop(runAgentLoop({...}))`. Add this test following that exact shape:

```js
test("runAgentLoop passes reasoning_effort=high when alwaysThinkingEnabled is set", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const capturedCalls = [];
  const adapter = {
    isConfigured() {
      return true;
    },
    async complete(opts) {
      capturedCalls.push(opts);
      return { content: "done", toolCalls: [] };
    }
  };

  const session = createSession(process.cwd());
  const { result } = await collectAgentLoop(runAgentLoop({
    input: "say hi",
    registry,
    cwd: process.cwd(),
    adapter,
    stream: false,
    session,
    runtimeCache: {},
    settings: { alwaysThinkingEnabled: true, thinkingBudget: 10000 }
  }));

  assert.equal(result.ok, true);
  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].reasoningEffort, "high");
});

test("runAgentLoop omits reasoning_effort when alwaysThinkingEnabled is false", async () => {
  const registry = new ToolRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  const capturedCalls = [];
  const adapter = {
    isConfigured() {
      return true;
    },
    async complete(opts) {
      capturedCalls.push(opts);
      return { content: "done", toolCalls: [] };
    }
  };

  const session = createSession(process.cwd());
  const { result } = await collectAgentLoop(runAgentLoop({
    input: "say hi",
    registry,
    cwd: process.cwd(),
    adapter,
    stream: false,
    session,
    runtimeCache: {},
    settings: { alwaysThinkingEnabled: false }
  }));

  assert.equal(result.ok, true);
  assert.equal(capturedCalls[0].reasoningEffort, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/m1-runtime-transcript.test.mjs`
Expected: FAIL — `capturedCalls[0].reasoningEffort` is `undefined` in the first test (should be `"high"`)

- [ ] **Step 3: Update the implementation**

In `src/agent/loop.mjs`, add a small helper near the top (after `toFiniteNumber`, before `normalizeTokenUsage` — pure function, no dependencies needed):

```js
function resolveReasoningEffort(settings) {
  if (!settings?.alwaysThinkingEnabled) {
    return undefined;
  }
  const budget = Number(settings.thinkingBudget);
  return Number.isFinite(budget) && budget >= 5000 ? "high" : "low";
}
```

Update `requestModelCompletion`'s signature and call to `adapter.complete`:

```js
async function requestModelCompletion({ adapter, messages, registry, stream, onToken, trace, session, reasoningEffort }) {
  try {
    const completion = await adapter.complete({
      messages,
      tools: registry.toModelTools(),
      stream,
      onToken,
      reasoningEffort
    });
```

In `runAgentLoop`, compute `reasoningEffort` once near the top (right after `const tokenBudgeter = createTokenBudgeter(session);` — this exact line moves in Task 7 below, so place this next to wherever that line ends up):

```js
  const reasoningEffort = resolveReasoningEffort(settings);
```

Then pass `reasoningEffort` at **both** existing call sites of `requestModelCompletion` inside `runAgentLoop` — the main-flow call and the context-length-exceeded retry call — by adding `reasoningEffort` to each call's argument object, e.g.:

```js
      const completionResult = await requestModelCompletion({
        adapter,
        messages,
        registry,
        stream,
        onToken,
        trace,
        session,
        reasoningEffort
      });
```

(same addition at the retry call site further down in the same function).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/m1-runtime-transcript.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — this touches a hot path (`requestModelCompletion` is called on every model turn), so a full-suite regression check matters here more than in earlier tasks.

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.mjs tests/m1-runtime-transcript.test.mjs
git commit -m "feat: thread reasoning-effort settings through the agent loop"
```

---

### Task 7: Model-aware context/token limit in the agent loop

**Files:**
- Modify: `src/agent/loop.mjs` (`resolveTokenLimit`, `createTokenBudgeter`, `readSessionTokenBaseline`, and their call sites)
- Modify: `tests/m7-robustness.test.mjs` — this file already has the existing `"agent loop emits SYSTEM_WARNING after crossing token budget threshold"` test that exercises the 80%-threshold warning; it must keep passing unchanged after this task since it constructs its adapter without a `model` field, so `resolveTokenLimit(undefined)` must still resolve to 65,536 (confirmed: `getModelCapabilities(undefined)` falls back to the Pro2 baseline, contextLimit 65,536 — this task's Step 3 preserves that).

**Why this task is more than a one-line change:** `SOLAR_PRO2_TOKEN_LIMIT` and `SOLAR_PRO2_WARNING_THRESHOLD` are currently module-level constants computed once at import time — they can't know which model a given `runAgentLoop` call is using (especially once Thread D adds per-subagent model overrides). This task converts them into values computed per-call from `adapter.model`, threaded through the functions that use them.

- [ ] **Step 1: Write the new failing test**

Add to `tests/m7-robustness.test.mjs`:

```js
test("resolveTokenLimit uses the active model's capability-table context limit", async () => {
  // Import resolveTokenLimit is not exported today — this test drives the
  // refactor to accept a modelId parameter. If resolveTokenLimit isn't
  // exported from loop.mjs, export it for this test (named export, no
  // default-export change).
  const { resolveTokenLimit } = await import("../src/agent/loop.mjs");

  const originalEnv = process.env.UPSTAGE_MODEL_CONTEXT_LIMIT;
  delete process.env.UPSTAGE_MODEL_CONTEXT_LIMIT;
  try {
    assert.equal(resolveTokenLimit("solar-pro4"), 512_000);
    assert.equal(resolveTokenLimit("solar-pro2"), 65_536);
    assert.equal(resolveTokenLimit(undefined), 65_536); // fallback
  } finally {
    if (originalEnv === undefined) delete process.env.UPSTAGE_MODEL_CONTEXT_LIMIT;
    else process.env.UPSTAGE_MODEL_CONTEXT_LIMIT = originalEnv;
  }
});

test("resolveTokenLimit still honors the UPSTAGE_MODEL_CONTEXT_LIMIT env override", async () => {
  const { resolveTokenLimit } = await import("../src/agent/loop.mjs");
  const originalEnv = process.env.UPSTAGE_MODEL_CONTEXT_LIMIT;
  process.env.UPSTAGE_MODEL_CONTEXT_LIMIT = "99999";
  try {
    assert.equal(resolveTokenLimit("solar-pro4"), 99999);
  } finally {
    if (originalEnv === undefined) delete process.env.UPSTAGE_MODEL_CONTEXT_LIMIT;
    else process.env.UPSTAGE_MODEL_CONTEXT_LIMIT = originalEnv;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/m7-robustness.test.mjs`
Expected: FAIL — `resolveTokenLimit` currently takes no parameter and isn't exported

- [ ] **Step 3: Update the implementation**

In `src/agent/loop.mjs`, replace the top-level constant block:

```js
function resolveTokenLimit() {
  const rawLimit = Number(process.env.UPSTAGE_MODEL_CONTEXT_LIMIT);
  if (Number.isFinite(rawLimit) && rawLimit > 0) {
    return Math.floor(rawLimit);
  }
  return 65_536;
}

const SOLAR_PRO2_TOKEN_LIMIT = resolveTokenLimit();
const SOLAR_PRO2_WARNING_THRESHOLD = Math.floor(SOLAR_PRO2_TOKEN_LIMIT * 0.8);
```

with:

```js
import { getModelCapabilities } from "../model/model-capabilities.mjs";

export function resolveTokenLimit(modelId) {
  const rawLimit = Number(process.env.UPSTAGE_MODEL_CONTEXT_LIMIT);
  if (Number.isFinite(rawLimit) && rawLimit > 0) {
    return Math.floor(rawLimit);
  }
  return getModelCapabilities(modelId).contextLimit;
}
```

(add this import alongside the existing imports at the top of the file, and remove the two now-deleted module-level `const` lines).

Update `readSessionTokenBaseline` to take the warning threshold as a parameter instead of closing over the deleted module constant:

```js
function readSessionTokenBaseline(session, warningThreshold) {
  if (!session || !Array.isArray(session.runtimeEvents)) {
    return {
      totalTokens: 0,
      warningEmitted: false
    };
  }

  let totalTokens = 0;
  let warningEmitted = false;
  for (const event of session.runtimeEvents) {
    if (event?.type === "TOKEN_USAGE") {
      const usage = normalizeTokenUsage(event.usage);
      if (usage) {
        totalTokens += usage.totalTokens;
      }
    }
    if (event?.type === "SYSTEM_WARNING" && event?.code === "TOKEN_CONTEXT_HIGH") {
      warningEmitted = true;
    }
  }

  if (totalTokens > warningThreshold) {
    warningEmitted = true;
  }

  return {
    totalTokens,
    warningEmitted
  };
}
```

Update `createTokenBudgeter` to take and use `tokenLimit`:

```js
function createTokenBudgeter(session, tokenLimit) {
  const warningThreshold = Math.floor(tokenLimit * 0.8);
  const baseline = readSessionTokenBaseline(session, warningThreshold);
  let sessionTotalTokens = baseline.totalTokens;
  let warningEmitted = baseline.warningEmitted;

  return {
    consume(usageInput) {
      const normalizedUsage = normalizeTokenUsage(usageInput);
      if (!normalizedUsage) {
        return null;
      }

      sessionTotalTokens += normalizedUsage.totalTokens;

      const usage = {
        ...normalizedUsage,
        sessionTotalTokens,
        limit: tokenLimit
      };

      if (warningEmitted || sessionTotalTokens <= warningThreshold) {
        return {
          usage,
          warning: null
        };
      }

      warningEmitted = true;
      return {
        usage,
        warning: {
          level: "warning",
          code: "TOKEN_CONTEXT_HIGH",
          message: `Session context usage is above 80% of model limit (${sessionTotalTokens}/${tokenLimit} tokens).`,
          usage: {
            totalTokens: sessionTotalTokens,
            threshold: warningThreshold,
            limit: tokenLimit
          }
        }
      };
    }
  };
}
```

In `runAgentLoop`, replace:

```js
  const tokenBudgeter = createTokenBudgeter(session);

  const contextManager = new ContextManager(
    settings?.maxContextTokens || SOLAR_PRO2_TOKEN_LIMIT,
    settings?.compactThreshold || 0.8
  );
```

with:

```js
  const tokenLimit = resolveTokenLimit(adapter?.model);
  const tokenBudgeter = createTokenBudgeter(session, tokenLimit);
  const reasoningEffort = resolveReasoningEffort(settings);

  const contextManager = new ContextManager(
    settings?.maxContextTokens || tokenLimit,
    settings?.compactThreshold || 0.8
  );
```

(This is also where Task 6's `reasoningEffort` computation belongs — combining them here avoids adding it twice.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/m7-robustness.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. This is the highest-risk task in this plan — `SOLAR_PRO2_TOKEN_LIMIT`/`SOLAR_PRO2_WARNING_THRESHOLD` were referenced in multiple closures. If any test fails, read the failure; a common mistake here is missing one of the two `readSessionTokenBaseline`/`createTokenBudgeter` call sites when converting them to take parameters.

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.mjs tests/*.test.mjs
git commit -m "feat: make agent loop token/context limits model-aware"
```

---

### Task 8: Model-aware context-builder character budget

**Files:**
- Modify: `src/agent/context-builder.mjs`
- Modify: `src/agent/loop.mjs` (the `formatContextForModel` call site)
- Create: `tests/m31-context-builder.test.mjs` — no existing test file covers `formatContextForModel`/`buildContext` (confirmed via `grep -rln "formatContextForModel\|buildContext" tests/`, zero matches), so this task creates the first one.

- [ ] **Step 1: Write the failing test**

```js
// tests/m31-context-builder.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatContextForModel } from "../src/agent/context-builder.mjs";

describe("formatContextForModel model-aware truncation", () => {
  it("uses a larger character budget for solar-pro4 than solar-pro2", () => {
    const bigSnippet = { path: "big.js", content: "x".repeat(300_000) };
    const context = {
      keywords: [],
      repoSummary: { totalFiles: 1, map: "" },
      modules: [],
      snippets: [bigSnippet],
      retrieval: { chunks: [] }
    };

    const pro2Result = formatContextForModel(context, { modelId: "solar-pro2" });
    const pro4Result = formatContextForModel(context, { modelId: "solar-pro4" });

    assert.ok(pro4Result.length > pro2Result.length);
    assert.ok(pro2Result.includes("(context truncated)"));
  });

  it("defaults to the existing ~24k char budget when no modelId is given", () => {
    const bigSnippet = { path: "big.js", content: "x".repeat(50_000) };
    const context = {
      keywords: [],
      repoSummary: { totalFiles: 1, map: "" },
      modules: [],
      snippets: [bigSnippet],
      retrieval: { chunks: [] }
    };
    const result = formatContextForModel(context);
    assert.ok(result.length <= 24_100); // 24_000 + "... (context truncated)" suffix slack
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/m31-context-builder.test.mjs`
Expected: FAIL — `formatContextForModel` currently ignores its second argument entirely, so both results are truncated to the same fixed 24,000-char cap

- [ ] **Step 3: Update the implementation**

In `src/agent/context-builder.mjs`, replace the top-level constant and `formatContextForModel` signature:

```js
import { retrieveRelevantChunks } from "../retriever/index.mjs";
import { getModelCapabilities } from "../model/model-capabilities.mjs";

// Ratio preserved from the original hand-tuned Pro2-era budget: 24,000 chars
// against a 65,536-token limit, assuming ~4 chars/token, is ~9% of the token
// budget spent on injected repo context. Scaled proportionally for models
// with larger context windows instead of staying fixed at 24k.
const CONTEXT_CHARS_PER_TOKEN = 4;
const CONTEXT_BUDGET_RATIO = 0.09;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
```

Remove the old `const MAX_CONTEXT_CHARS = 24_000;` line entirely (it's replaced by the ratio-based calculation above).

At the bottom of the file, update `formatContextForModel`:

```js
function resolveMaxContextChars(modelId) {
  if (!modelId) return DEFAULT_MAX_CONTEXT_CHARS;
  const { contextLimit } = getModelCapabilities(modelId);
  return Math.floor(contextLimit * CONTEXT_CHARS_PER_TOKEN * CONTEXT_BUDGET_RATIO);
}

export function formatContextForModel(context, { modelId } = {}) {
  const maxContextChars = resolveMaxContextChars(modelId);
  const lines = [];
  lines.push("Repository context:");
  lines.push(`- totalFiles: ${context.repoSummary.totalFiles}`);
  lines.push(`- keywordHints: ${context.keywords.join(", ") || "none"}`);
  if (context.repoSummary.map) {
    lines.push("- repository map (condensed):");
    lines.push(context.repoSummary.map.slice(0, 4000));
  }
  if (Array.isArray(context.modules) && context.modules.length > 0) {
    lines.push("- module edges:");
    for (const module of context.modules.slice(0, 8)) {
      lines.push(`  - ${module.file} -> ${(module.imports || []).slice(0, 3).join(", ") || "(none)"}`);
    }
  }
  if (context.snippets.length > 0) {
    lines.push("- relevant snippets:");
  }
  for (const snippet of context.snippets) {
    lines.push(`FILE: ${snippet.path}`);
    lines.push("```text");
    lines.push(snippet.content);
    lines.push("```");
  }
  if (Array.isArray(context.retrieval?.chunks) && context.retrieval.chunks.length > 0) {
    lines.push(`- semantic retrieval (mode=${context.retrieval.mode}):`);
    for (const chunk of context.retrieval.chunks) {
      lines.push(`  - ${chunk.path} (score=${chunk.score})`);
      lines.push("```text");
      lines.push(chunk.text.slice(0, 300));
      lines.push("```");
    }
  }
  const result = lines.join("\n");
  if (result.length > maxContextChars) {
    return result.slice(0, maxContextChars) + "\n... (context truncated)";
  }
  return result;
}
```

(`buildContext` itself is unchanged — only `formatContextForModel`'s signature and the constant it reads from changed.)

In `src/agent/loop.mjs`, update the call site:

```js
      const context = await buildContext({ input, registry, cwd, runtimeCache });
      const contextBlock = formatContextForModel(context, { modelId: adapter?.model });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/m31-context-builder.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/context-builder.mjs src/agent/loop.mjs tests/m31-context-builder.test.mjs
git commit -m "feat: scale context-builder char budget with model context window"
```

---

## Final check

- [ ] Run `npm run ci` (check + lint + test + smoke) and confirm it's green end-to-end before considering Thread A done.
- [ ] Update `docs/roadmap-tui-and-features.md`'s "Note: Solar Pro 3 / Pro 4" section to strike the `DEFAULT_MODEL` TODO — it's done as of this plan's Task 3.
