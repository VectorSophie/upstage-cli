// Effective context budget for one agent run.
//
// By default the loop takes its context ceiling from the model capability
// table (or UPSTAGE_MODEL_CONTEXT_LIMIT), exactly as before. A caller that has
// VALIDATED the served model's limits (e.g. an evaluation harness talking to
// a locally served model the capability table does not know) can pass
// `contextBudget` to runAgentLoop. Then one ceiling drives everything the
// loop sends: the injected repository context, the conversation budget
// (after system prompt, context block and tool schemas), compaction, a
// per-tool-result cap and a pre-request fit check that fails closed — and it
// is never replaced by the generic 65,536-token fallback.
//
//   contextBudget = {
//     contextLimit,        // total tokens the server accepts (input + output)
//     maxOutputTokens,     // the output allowance sent as max_tokens
//     charsPerToken?,      // caller-calibrated chars per token (default 4)
//     safetyMarginRatio?,  // fraction of contextLimit held back (default 0.05)
//     source?              // free text, recorded in events
//   }
import { getModelCapabilities } from "../model/model-capabilities.mjs";

export class ContextBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_SAFETY_MARGIN_RATIO = 0.05;
const MIN_INPUT_BUDGET = 512;
// Same share of the budget the repository context used before (9%).
const REPO_CONTEXT_RATIO = 0.09;
// A single tool result may use at most this share of the conversation budget.
const TOOL_RESULT_RATIO = 0.25;

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

export function validateContextBudget(budget) {
  if (budget === undefined || budget === null) return null;
  if (typeof budget !== "object") throw new ContextBudgetError("contextBudget must be an object");
  const { contextLimit, maxOutputTokens } = budget;
  const charsPerToken = budget.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const safetyMarginRatio = budget.safetyMarginRatio ?? DEFAULT_SAFETY_MARGIN_RATIO;
  if (!isPositiveInt(contextLimit)) throw new ContextBudgetError(`contextLimit must be a positive integer (got ${contextLimit})`);
  if (!isPositiveInt(maxOutputTokens)) throw new ContextBudgetError(`maxOutputTokens must be a positive integer (got ${maxOutputTokens})`);
  if (maxOutputTokens >= contextLimit) {
    throw new ContextBudgetError(`maxOutputTokens (${maxOutputTokens}) must be smaller than contextLimit (${contextLimit}): input and output share the context`);
  }
  if (!(typeof charsPerToken === "number" && charsPerToken > 0 && charsPerToken <= 8)) {
    throw new ContextBudgetError(`charsPerToken must be in (0, 8] (got ${charsPerToken})`);
  }
  if (!(typeof safetyMarginRatio === "number" && safetyMarginRatio >= 0 && safetyMarginRatio < 0.5)) {
    throw new ContextBudgetError(`safetyMarginRatio must be in [0, 0.5) (got ${safetyMarginRatio})`);
  }
  const safetyMarginTokens = Math.ceil(contextLimit * safetyMarginRatio);
  const inputBudget = contextLimit - maxOutputTokens - safetyMarginTokens;
  if (inputBudget < MIN_INPUT_BUDGET) {
    throw new ContextBudgetError(`input budget ${inputBudget} tokens (contextLimit ${contextLimit} - maxOutputTokens ${maxOutputTokens} - margin ${safetyMarginTokens}) is below ${MIN_INPUT_BUDGET}`);
  }
  return {
    explicit: true,
    source: typeof budget.source === "string" ? budget.source : "caller",
    contextLimit,
    maxOutputTokens,
    charsPerToken,
    safetyMarginTokens,
    inputBudget,
    repoContextMaxChars: Math.floor(inputBudget * REPO_CONTEXT_RATIO * charsPerToken)
  };
}

/** Resolve the run's context ceiling. Caller budget > env > capability table. */
export function resolveEffectiveContext({ contextBudget, modelId, env = process.env } = {}) {
  const explicit = validateContextBudget(contextBudget);
  if (explicit) return explicit;
  const rawLimit = Number(env.UPSTAGE_MODEL_CONTEXT_LIMIT);
  const fromEnv = Number.isFinite(rawLimit) && rawLimit > 0;
  return {
    explicit: false,
    source: fromEnv ? "env:UPSTAGE_MODEL_CONTEXT_LIMIT" : "model-capabilities",
    contextLimit: fromEnv ? Math.floor(rawLimit) : getModelCapabilities(modelId).contextLimit,
    maxOutputTokens: null,
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    safetyMarginTokens: 0,
    inputBudget: null,
    repoContextMaxChars: null
  };
}

/** Token estimate at the caller-calibrated ratio (CJK-heavy text keeps the
 *  heuristic's 2.5 chars/token unless the calibration is stricter). */
export function estimateWith(effective, str) {
  if (!str) return 0;
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp >= 0x1100 && cp <= 0xd7a3) cjk++;
  }
  const ratio = cjk / str.length > 0.3 ? Math.min(2.5, effective.charsPerToken) : effective.charsPerToken;
  return Math.ceil(str.length / ratio);
}

export function estimateMessages(effective, messages) {
  let n = 0;
  for (const m of messages || []) {
    if (typeof m?.content === "string") n += estimateWith(effective, m.content);
    if (Array.isArray(m?.tool_calls)) for (const tc of m.tool_calls) n += estimateWith(effective, JSON.stringify(tc));
  }
  return n;
}

/** Cap for one tool result's serialized content, in characters. */
export function toolResultMaxChars(effective, conversationBudget) {
  return Math.max(1000, Math.floor(conversationBudget * TOOL_RESULT_RATIO * effective.charsPerToken));
}
