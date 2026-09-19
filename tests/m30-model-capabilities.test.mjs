import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModelCapabilities, KNOWN_MODEL_IDS } from "../src/model/model-capabilities.mjs";
import { UpstageAdapter, assertReasoningEffortSupported } from "../src/model/upstage-adapter.mjs";

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

  it("KNOWN_MODEL_IDS lists exactly the models this table has real data for", () => {
    assert.deepEqual([...KNOWN_MODEL_IDS].sort(), ["solar-pro2", "solar-pro3", "solar-pro4"]);
  });
});

// ─── Task 7.17 — widened reasoning_effort enum ──────────────────────────
//
// Upstage's live enum (per the 3.2.0 release plan's external research,
// NOT live-verified — see upstage-adapter.mjs's VALID_REASONING_EFFORTS
// comment) is none|minimal|low|medium|high|xhigh|max, wider than this
// repo's original {low, high} pair. These tests assert the widened set is
// validated correctly, both by the pre-existing instance-level
// this.reasoningEffort / setReasoningEffort() mechanism and by the new
// assertReasoningEffortSupported() client-side guard the -e/--reasoning-
// effort CLI flag and /effort TUI command call before ever touching the
// network.

describe("widened VALID_REASONING_EFFORTS enum", () => {
  const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  it("UpstageAdapter's instance-level mechanism accepts every widened level", () => {
    for (const level of LEVELS) {
      const adapter = new UpstageAdapter({ apiKey: "x", reasoningEffort: level });
      assert.equal(adapter.reasoningEffort, level, `expected constructor to accept "${level}"`);

      const other = new UpstageAdapter({ apiKey: "x" });
      other.setReasoningEffort(level);
      assert.equal(other.reasoningEffort, level, `expected setReasoningEffort() to accept "${level}"`);
    }
  });

  it("still rejects a value outside the widened set (constructor and setReasoningEffort())", () => {
    const adapter = new UpstageAdapter({ apiKey: "x", reasoningEffort: "ultra-mega" });
    assert.equal(adapter.reasoningEffort, null);
    adapter.setReasoningEffort("ultra-mega");
    assert.equal(adapter.reasoningEffort, null);
  });
});

describe("assertReasoningEffortSupported", () => {
  it("accepts every widened level on solar-pro4 (supportsReasoningEffort: true)", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.doesNotThrow(() => assertReasoningEffortSupported("solar-pro4", level));
    }
  });

  it("rejects an invalid level with a clear error before any network call", () => {
    assert.throws(
      () => assertReasoningEffortSupported("solar-pro4", "not-a-real-level"),
      /Invalid reasoning effort level.*not-a-real-level/
    );
  });

  it("rejects a valid level on a model whose capability table entry marks supportsReasoningEffort: false", () => {
    // solar-pro2/solar-pro3 both have supportsReasoningEffort: false in
    // model-capabilities.mjs — see that file's comment on why the flag
    // still means "the new explicit -e//effort controls refuse this model"
    // even though Pro2's pre-existing, ungated settings.json/Ctrl+E path
    // has real reasoning_effort support.
    assert.throws(
      () => assertReasoningEffortSupported("solar-pro2", "high"),
      /does not support explicit reasoning-effort control/
    );
    assert.throws(
      () => assertReasoningEffortSupported("solar-pro3", "high"),
      /does not support explicit reasoning-effort control/
    );
  });

  it("rejects an unrecognized model id (falls back to the conservative baseline, still unsupported) — covers the solar-mini HTTP 400 failure mode", () => {
    assert.throws(
      () => assertReasoningEffortSupported("solar-mini", "high"),
      /does not support explicit reasoning-effort control/
    );
  });

  it("checks the level before the model — an invalid level is rejected even on an unsupported model, with the level error", () => {
    assert.throws(
      () => assertReasoningEffortSupported("solar-mini", "not-a-real-level"),
      /Invalid reasoning effort level/
    );
  });
});

// 3.3.0 Thread D, Task D.1: additive modality metadata alongside the
// existing boolean flags — Solar is confirmed text-only (Upstage's own
// Pro4 launch materials document no image input), so every known model id
// gets ["text"]/["text"] until Upstage ships a vision-capable model.
describe("getModelCapabilities — modality metadata", () => {
  it("every known Solar model reports text-only input/output modalities", () => {
    for (const modelId of KNOWN_MODEL_IDS) {
      const caps = getModelCapabilities(modelId);
      assert.deepEqual(caps.inputModalities, ["text"]);
      assert.deepEqual(caps.outputModalities, ["text"]);
    }
  });

  it("the fallback (unrecognized model id) also reports text-only modalities", () => {
    const caps = getModelCapabilities("some-unrecognized-model-id");
    assert.deepEqual(caps.inputModalities, ["text"]);
    assert.deepEqual(caps.outputModalities, ["text"]);
  });
});
