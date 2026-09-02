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
