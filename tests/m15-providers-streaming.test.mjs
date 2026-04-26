import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getProvider, getProviderByName, listProviders, checkProviderKeys } from "../src/core/providers.mjs";
import { parseSSEChunk, accumulateStream } from "../src/core/streaming.mjs";
import { normalizeUsage } from "../src/model/fetch-utils.mjs";
import { UpstageAdapter } from "../src/model/upstage-adapter.mjs";
import { OpenAIAdapter } from "../src/model/openai-adapter.mjs";
import { GeminiAdapter } from "../src/model/gemini-adapter.mjs";

// ──────────────────────────────────────────────
// Provider routing
// ──────────────────────────────────────────────

describe("getProvider", () => {
  it("routes solar-pro2 to upstage", () => {
    assert.equal(getProvider("solar-pro2").id, "upstage");
  });

  it("routes solar-pro to upstage", () => {
    assert.equal(getProvider("solar-pro").id, "upstage");
  });

  it("routes gpt-4o to openai", () => {
    assert.equal(getProvider("gpt-4o").id, "openai");
  });

  it("routes gpt-4o-mini to openai", () => {
    assert.equal(getProvider("gpt-4o-mini").id, "openai");
  });

  it("routes o3-mini to openai", () => {
    assert.equal(getProvider("o3-mini").id, "openai");
  });

  it("routes o1 to openai", () => {
    assert.equal(getProvider("o1").id, "openai");
  });

  it("routes gemini-2.0-flash to gemini", () => {
    assert.equal(getProvider("gemini-2.0-flash").id, "gemini");
  });

  it("routes gemini-2.5-pro to gemini", () => {
    assert.equal(getProvider("gemini-2.5-pro").id, "gemini");
  });

  it("defaults unknown model to upstage", () => {
    assert.equal(getProvider("unknown-model").id, "upstage");
  });

  it("defaults null/undefined to upstage", () => {
    assert.equal(getProvider(null).id, "upstage");
    assert.equal(getProvider(undefined).id, "upstage");
  });
});

describe("getProviderByName", () => {
  it("returns provider by name", () => {
    assert.equal(getProviderByName("openai").id, "openai");
    assert.equal(getProviderByName("gemini").id, "gemini");
  });

  it("returns null for unknown name", () => {
    assert.equal(getProviderByName("unknown"), null);
  });
});

describe("listProviders", () => {
  it("returns exactly 3 providers", () => {
    assert.equal(listProviders().length, 3);
  });

  it("includes upstage, openai, gemini", () => {
    const ids = listProviders().map((p) => p.id).sort();
    assert.deepEqual(ids, ["gemini", "openai", "upstage"]);
  });
});

describe("checkProviderKeys", () => {
  it("reflects env vars for each provider", () => {
    // In test env, these keys are likely not set
    const result = checkProviderKeys();
    assert.equal(typeof result.upstage, "boolean");
    assert.equal(typeof result.openai, "boolean");
    assert.equal(typeof result.gemini, "boolean");
  });

  it("detects UPSTAGE_API_KEY", () => {
    const old = process.env.UPSTAGE_API_KEY;
    process.env.UPSTAGE_API_KEY = "test-key";
    assert.equal(checkProviderKeys().upstage, true);
    if (old === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = old;
  });

  it("detects GOOGLE_API_KEY as gemini fallback", () => {
    const oldG = process.env.GOOGLE_API_KEY;
    const oldK = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "google-key";
    assert.equal(checkProviderKeys().gemini, true);
    if (oldG === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = oldG;
    if (oldK !== undefined) process.env.GEMINI_API_KEY = oldK;
  });
});

// ──────────────────────────────────────────────
// parseSSEChunk
// ──────────────────────────────────────────────

describe("parseSSEChunk", () => {
  it("parses data: line", () => {
    const result = parseSSEChunk("data: {\"hello\":1}");
    assert.equal(result.data, '{"hello":1}');
  });

  it("parses event: line", () => {
    const result = parseSSEChunk("event: update\ndata: {}");
    assert.equal(result.event, "update");
    assert.equal(result.data, "{}");
  });

  it("returns null data for empty chunk", () => {
    const result = parseSSEChunk("");
    assert.equal(result.data, null);
  });
});

// ──────────────────────────────────────────────
// accumulateStream — OpenAI format
// ──────────────────────────────────────────────

async function* makeOpenAIEvents(chunks) {
  for (const chunk of chunks) {
    yield `data: ${JSON.stringify(chunk)}`;
  }
  yield "data: [DONE]";
}

describe("accumulateStream — openai format", () => {
  it("accumulates text content from delta", async () => {
    const events = makeOpenAIEvents([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] }
    ]);
    const result = await accumulateStream(events, "openai");
    assert.equal(result.content, "Hello world");
  });

  it("accumulates tool call deltas", async () => {
    const events = makeOpenAIEvents([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x"}' } }] } }] }
    ]);
    const result = await accumulateStream(events, "openai");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, "read_file");
    assert.equal(result.toolCalls[0].function.arguments, '{"path":"x"}');
  });

  it("captures usage from chunk", async () => {
    const events = makeOpenAIEvents([
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    ]);
    const result = await accumulateStream(events, "openai");
    assert.equal(result.usage?.totalTokens, 15);
  });

  it("skips [DONE] without crashing", async () => {
    const events = makeOpenAIEvents([{ choices: [{ delta: { content: "ok" } }] }]);
    await assert.doesNotReject(() => accumulateStream(events, "openai"));
  });

  it("calls onToken for each text delta", async () => {
    const tokens = [];
    const events = makeOpenAIEvents([
      { choices: [{ delta: { content: "a" } }] },
      { choices: [{ delta: { content: "b" } }] }
    ]);
    await accumulateStream(events, "openai", (t) => tokens.push(t));
    assert.deepEqual(tokens, ["a", "b"]);
  });
});

// ──────────────────────────────────────────────
// accumulateStream — Gemini format
// ──────────────────────────────────────────────

async function* makeGeminiEvents(chunks) {
  for (const chunk of chunks) {
    yield `data: ${JSON.stringify(chunk)}`;
  }
}

describe("accumulateStream — gemini format", () => {
  it("accumulates text from candidates[0].content.parts[0].text", async () => {
    const events = makeGeminiEvents([
      { candidates: [{ content: { parts: [{ text: "Hi " }] } }] },
      { candidates: [{ content: { parts: [{ text: "there" }] } }] }
    ]);
    const result = await accumulateStream(events, "gemini");
    assert.equal(result.content, "Hi there");
  });

  it("captures usageMetadata", async () => {
    const events = makeGeminiEvents([
      {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
      }
    ]);
    const result = await accumulateStream(events, "gemini");
    assert.equal(result.usage?.totalTokens, 7);
  });

  it("calls onToken for Gemini text", async () => {
    const tokens = [];
    const events = makeGeminiEvents([
      { candidates: [{ content: { parts: [{ text: "x" }] } }] }
    ]);
    await accumulateStream(events, "gemini", (t) => tokens.push(t));
    assert.deepEqual(tokens, ["x"]);
  });
});

// ──────────────────────────────────────────────
// normalizeUsage
// ──────────────────────────────────────────────

describe("normalizeUsage", () => {
  it("handles snake_case keys", () => {
    const u = normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.equal(u.promptTokens, 10);
    assert.equal(u.completionTokens, 5);
    assert.equal(u.totalTokens, 15);
  });

  it("computes totalTokens if missing", () => {
    const u = normalizeUsage({ prompt_tokens: 3, completion_tokens: 7 });
    assert.equal(u.totalTokens, 10);
  });

  it("returns null for empty/null", () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage({}), null);
  });
});

// ──────────────────────────────────────────────
// Adapter isConfigured
// ──────────────────────────────────────────────

describe("UpstageAdapter.isConfigured", () => {
  it("returns false when no key", () => {
    const adapter = new UpstageAdapter({ apiKey: "" });
    assert.equal(adapter.isConfigured(), false);
  });

  it("returns true when key provided", () => {
    const adapter = new UpstageAdapter({ apiKey: "test-key" });
    assert.equal(adapter.isConfigured(), true);
  });
});

describe("OpenAIAdapter.isConfigured", () => {
  it("returns false when OPENAI_API_KEY unset", () => {
    const old = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const adapter = new OpenAIAdapter();
    assert.equal(adapter.isConfigured(), false);
    if (old !== undefined) process.env.OPENAI_API_KEY = old;
  });

  it("returns true when key provided via constructor", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });
    assert.equal(adapter.isConfigured(), true);
  });
});

describe("GeminiAdapter.isConfigured", () => {
  it("returns false when no keys set", () => {
    const oldG = process.env.GEMINI_API_KEY;
    const oldK = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const adapter = new GeminiAdapter();
    assert.equal(adapter.isConfigured(), false);
    if (oldG !== undefined) process.env.GEMINI_API_KEY = oldG;
    if (oldK !== undefined) process.env.GOOGLE_API_KEY = oldK;
  });

  it("returns true when GEMINI_API_KEY set", () => {
    const adapter = new GeminiAdapter({ apiKey: "gem-key" });
    assert.equal(adapter.isConfigured(), true);
  });
});
