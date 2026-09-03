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
