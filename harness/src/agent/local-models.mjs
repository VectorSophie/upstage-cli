// Registry of the four locally served Korean models, with the EXACT serving
// configuration validated in /home/jackb/workspace/model-prep (models-manifest.json,
// serving-readiness.json, kserve.sh, kserve-solar.sh, smoke-test-results.md).
//
// Nothing here is invented: ids, HF repos, pinned revisions, quantization,
// parsers, container image digests, tensor-parallelism and the validated
// context ceilings all come from those records. Model-specific serving
// behavior is captured as data here and in the kserve launchers — NOT as
// branches in generic harness/scoring code.
//
// Base URLs default to loopback and are env-overridable, so no machine-specific
// address is baked into the adapter. The three "standard" models share one vLLM
// v0.32.0 server on :8101 (served ONE AT A TIME — these are not simultaneously
// available endpoints); Solar Open 2 runs on its separate Upstage-fork server on
// :8102. Starting/stopping those servers is the operator's job (kserve.sh /
// kserve-solar.sh); this harness only talks to whichever one is currently up.

const STANDARD_BASE_URL = process.env.KSERVE_BASE_URL || "http://127.0.0.1:8101/v1";
const SOLAR_BASE_URL = process.env.SOLAR_BASE_URL || "http://127.0.0.1:8102/v1";

// Official vLLM image (CUDA 13.0.2) pinned digest from kserve.sh (IMG_CU130).
const VLLM_V032_IMAGE = "vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9";
// Upstage fork image pinned digest from the Solar serving validation (2026-10-26).
const SOLAR_IMAGE = "upstage/vllm-solar-open2@sha256:b34b7dd42d986bafb8dcfb285758de2fbfd55e7cf28a1b5ba6b858e6b2b7c8c3";

export const LOCAL_MODELS = {
  kanana: {
    // ── identity / adapter ──
    servedModelName: "Kanana-2",
    baseUrlEnv: "KANANA_BASE_URL",
    baseUrl: process.env.KANANA_BASE_URL || STANDARD_BASE_URL,
    displayName: "Kanana 2 30B-A3B Thinking (local vLLM)",
    // ── sampling (vendor-recommended; recorded in provenance) ──
    sampling: { temperature: 0.6, topP: 0.95, topK: 20 },
    // Reasoning is ALWAYS on for Kanana — its chat template prefills <think>.
    chatTemplateKwargs: null,
    maxOutputTokens: 8192,
    contextLimit: 16384, // validated serving context (YaRN can extend, not used here)
    // ── provenance ──
    provenance: {
      provider: "local-vllm",
      hfRepo: "kakaocorp/kanana-2-30b-a3b-thinking-2601",
      revision: "cdcbf8b811c21366f20f8a10a1f83183433c0844",
      quantization: "bf16",
      official: true,
      servingRuntime: "vLLM v0.32.0 (CUDA 13.0.2)",
      servingImage: VLLM_V032_IMAGE,
      tensorParallel: 1,
      reasoningParser: "deepseek_r1",
      toolCallParser: "hermes",
      logitsProcessor: null,
      launcher: "kserve.sh start kanana",
      port: 8101,
      notes:
        "Thinking model; reasoning always enabled by the template. Provider reasoning-token metric is unreliable (deepseek_r1 reports 0) → reasoningChars used, providerReasoningTokens null."
    }
  },

  exaone: {
    servedModelName: "EXAONE-4.5",
    baseUrlEnv: "EXAONE_BASE_URL",
    baseUrl: process.env.EXAONE_BASE_URL || STANDARD_BASE_URL,
    displayName: "EXAONE 4.5 33B FP8 (local vLLM)",
    // Vendor Korean/reasoning preset (temp 0.6, top_p 0.95, top_k 20, presence 1.5).
    sampling: { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5 },
    // Thinking is ON by default; the "exaone-nothink" variant flips this off.
    chatTemplateKwargs: { enable_thinking: true },
    maxOutputTokens: 8192,
    contextLimit: 16384,
    provenance: {
      provider: "local-vllm",
      hfRepo: "LGAI-EXAONE/EXAONE-4.5-33B-FP8",
      revision: "69570ad5d9a5159816ef267f2f4d37e36447f1be",
      quantization: "fp8",
      official: true,
      servingRuntime: "vLLM v0.32.0 (CUDA 13.0.2)",
      servingImage: VLLM_V032_IMAGE,
      tensorParallel: 1,
      reasoningParser: "qwen3",
      toolCallParser: "hermes",
      logitsProcessor: null,
      launcher: "kserve.sh start exaone",
      port: 8101,
      notes:
        "Hybrid thinking model; enable_thinking toggles reasoning. Provider reasoning-token metric is reliable (qwen3 engine)."
    }
  },

  "exaone-nothink": {
    servedModelName: "EXAONE-4.5",
    baseUrlEnv: "EXAONE_BASE_URL",
    baseUrl: process.env.EXAONE_BASE_URL || STANDARD_BASE_URL,
    displayName: "EXAONE 4.5 33B FP8 — thinking OFF (local vLLM)",
    sampling: { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5 },
    chatTemplateKwargs: { enable_thinking: false },
    maxOutputTokens: 4096,
    contextLimit: 16384,
    provenance: {
      provider: "local-vllm",
      hfRepo: "LGAI-EXAONE/EXAONE-4.5-33B-FP8",
      revision: "69570ad5d9a5159816ef267f2f4d37e36447f1be",
      quantization: "fp8",
      official: true,
      servingRuntime: "vLLM v0.32.0 (CUDA 13.0.2)",
      servingImage: VLLM_V032_IMAGE,
      tensorParallel: 1,
      reasoningParser: "qwen3",
      toolCallParser: "hermes",
      logitsProcessor: null,
      launcher: "kserve.sh start exaone",
      port: 8101,
      notes: "Same checkpoint/server as `exaone`, with enable_thinking=false (non-reasoning configuration)."
    }
  },

  ax: {
    servedModelName: "A.X-4.0",
    baseUrlEnv: "AX_BASE_URL",
    baseUrl: process.env.AX_BASE_URL || STANDARD_BASE_URL,
    displayName: "A.X 4.0 72B (local vLLM, TP2)",
    sampling: { temperature: 0.6, topP: 0.95 },
    chatTemplateKwargs: null, // non-thinking: no reasoning parser, no think toggle
    maxOutputTokens: 4096,
    contextLimit: 16384,
    provenance: {
      provider: "local-vllm",
      hfRepo: "skt/A.X-4.0",
      revision: "a3393fd67bf09a34a85e66dfd2c2da61c4497b67",
      quantization: "bf16",
      official: true,
      servingRuntime: "vLLM v0.32.0 (CUDA 13.0.2)",
      servingImage: VLLM_V032_IMAGE,
      tensorParallel: 2,
      reasoningParser: null,
      toolCallParser: "hermes",
      logitsProcessor: null,
      launcher: "kserve.sh start ax",
      port: 8101,
      notes: "Non-thinking dense model; reasoning N/A (no reasoning parser). TP2 over PCIe."
    }
  },

  "solar-open2": {
    servedModelName: "solar-open2-250b",
    baseUrlEnv: "SOLAR_BASE_URL",
    baseUrl: SOLAR_BASE_URL,
    displayName: "Solar Open 2 250B — Nota NVFP4, UNOFFICIAL quant (local, Upstage fork, TP2)",
    sampling: { temperature: 0.6, topP: 0.95 },
    // reasoning_effort defaults to "high" server-side; the template prefills
    // <|think:start|>. No per-request toggle needed.
    chatTemplateKwargs: null,
    // 8K is the validated ceiling on this machine; output capped so prompt+output
    // stays within it (the server 400s if max_tokens overflows the context).
    maxOutputTokens: 4096,
    contextLimit: 8192,
    provenance: {
      provider: "local-vllm-fork",
      hfRepo: "nota-ai/Solar-Open2-250B-Nota-NVFP4",
      revision: "3cc673335f4c2f41181e05a98fc2b8324d586a64",
      quantization: "NVFP4 W4A4 (compressed-tensors)",
      // CRITICAL: this is an UNOFFICIAL third-party (Nota AI) quantization of
      // upstage/Solar-Open2-250B — never presented as the official BF16 checkpoint.
      official: false,
      quantizationSource: "Nota AI (third-party community quant)",
      servingRuntime: "Upstage vLLM fork v0.22.0-solar-open2 (CUDA 12.9.1)",
      servingImage: SOLAR_IMAGE,
      tensorParallel: 2,
      reasoningParser: "solar_open2",
      toolCallParser: "solar_open2",
      logitsProcessor: "SolarOpen2TemplateLogitsProcessor",
      maxNumSeqs: 256, // REQUIRED: hybrid attention+Mamba; default 1024 > Mamba cache blocks
      launcher: "kserve-solar.sh start 8192",
      port: 8102,
      notes:
        "Hybrid attention+Mamba MoE. UNOFFICIAL Nota NVFP4 quant — NOT equivalent to official BF16. Validated only to 8K context on this machine (131K does not fit). NVFP4-MoE runs via FLASHINFER_CUTLASS (no Marlin/Emulation fallback)."
    }
  }
};

export const LOCAL_MODEL_IDS = Object.keys(LOCAL_MODELS);

export function getLocalModelConfig(key) {
  if (typeof key !== "string") return null;
  return LOCAL_MODELS[key.toLowerCase()] || null;
}
