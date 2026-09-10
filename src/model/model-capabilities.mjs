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
    // false here only gates the newer per-call reasoningEffort override in
    // UpstageAdapter#complete() — it is NOT the claim "Pro2 has no reasoning_effort
    // support." Pro2's real reasoning_effort switch is handled separately and
    // unconditionally via the pre-existing instance-level this.reasoningEffort /
    // setReasoningEffort() mechanism in upstage-adapter.mjs, which this flag does not gate.
    supportsReasoningEffort: false,
    supportsParallelToolCalls: false,
    supportsResponseFormat: false,
    promptTier: "full"
  }
};

const FALLBACK = CAPABILITIES["solar-pro2"];

// The set of model ids this table actually has real (not fallback) data
// for — the single source of truth `upstage models list/info`
// (src/cli/commands/models.mjs) and the TUI's `/model` command both read,
// per Task 7.16. Deliberately narrower than PROVIDERS.upstage.models
// (src/core/providers.mjs) — models.mjs's contract is "one row per model
// this table has real capability data for," not "every model string the
// Upstage provider will accept," so ids like "solar-pro"/"solar-mini" that
// only ever hit getModelCapabilities()'s conservative FALLBACK are
// intentionally excluded here rather than presented as if they had a real
// entry.
export const KNOWN_MODEL_IDS = Object.keys(CAPABILITIES);

export function getModelCapabilities(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return FALLBACK;
  }
  return CAPABILITIES[modelId.toLowerCase()] || FALLBACK;
}
