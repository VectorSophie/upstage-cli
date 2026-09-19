// Upstage Groundedness Check — verifies an answer/claim is actually
// supported by its source context, as a real second model call rather than
// self-critique. Unlike every other module in this directory, it rides the
// SAME POST /v1/chat/completions route Solar Pro4 chat uses — there is no
// dedicated /groundedness-check path. Context is sent as a `user`-role
// message, the answer/claim as an `assistant`-role message, non-streaming.
// The response is a plain string in choices[0].message.content — no JSON
// envelope.
//
// Because this is a chat-completions-shaped call (not a multipart/JSON
// document-AI-style call), this module deliberately calls UpstageAdapter
// (src/model/upstage-adapter.mjs) directly instead of going through
// upstageRequest()/client.mjs. client.mjs's own header explicitly scopes
// itself to having "no per-endpoint knowledge" of chat-completions concerns
// (tool_choice resolution, parallel_tool_calls, reasoning_effort gating by
// model capability, SSE streaming) — all of which UpstageAdapter already
// implements correctly and is what check-groundedness.mjs already used
// before this refactor. Reimplementing a second, parallel chat-completions
// caller inside client.mjs (or bypassing UpstageAdapter's capability-gating
// with a bare fetch) would be the mismatched abstraction here, not this
// choice. Every other src/upstage/*.mjs module targets a genuine
// Document-AI-family multipart/JSON endpoint, where upstageRequest() is the
// right fit — groundedness is the one exception, and is documented as such.
//
// Model id provenance: this repo's pre-refactor default was
// "solar-1-mini-answer-verification", sourced from langchain-upstage's
// (now-deprecated) UpstageGroundednessCheck tool documentation. The 3.2.0
// release plan's own research (docs/superpowers/plans/2026-09-04-3.2.0-release-plan.md,
// §3's Groundedness Check row and §13) found evidence pointing to
// "groundedness-check" as the current live model id instead — described
// there as "dated-snapshot resolved" (i.e. the live API is expected to
// resolve this base name to a specific dated model version server-side, the
// same pattern Upstage uses elsewhere). This was NOT independently
// live-verified against a real API call in this session (no UPSTAGE_API_KEY
// was available) — it is this session's best-effort correction of a
// citation that was itself already secondhand (a third-party library's
// docs, not Upstage's own), not a confirmed replacement. If a live
// verification pass later finds a different id, update DEFAULT_MODEL and
// this comment together.
import { UpstageAdapter } from "../model/upstage-adapter.mjs";

// See module header for the full provenance/citation trail on this default.
const DEFAULT_MODEL = "groundedness-check";

// UPSTAGE_GROUNDEDNESS_MODEL was already read by the pre-refactor
// check-groundedness.mjs but was never added to src/config/env.mjs's
// ENV_SCHEMA (an undocumented-but-live env var) — this task adds it there
// (see env.mjs) so `upstage config`/`listEnvVars()` and this default agree
// on one documented name, matching the precedent set by
// UPSTAGE_EMBEDDING_MODEL's equivalent fix in embeddings.mjs. Resolved
// per-call (not once at module load) so a runtime override takes effect
// immediately — matching embeddings.mjs's resolveModel(), not the
// pre-refactor tool's module-load-time constant.
function resolveModel() {
  return process.env.UPSTAGE_GROUNDEDNESS_MODEL || DEFAULT_MODEL;
}

// Response label enum: plan §3 describes the three possible plain-string
// values as "grounded" | "notGrounded" | "notSure", but only "notGrounded"
// was DIRECTLY observed by that research pass — "grounded" and "notSure"
// are inferred from the label set's shape (the natural complement of a
// binary-plus-abstain grounding check), not independently confirmed against
// a real response. This substring-match parse (rather than a strict
// equality check) is carried over unchanged from the pre-refactor
// check-groundedness.mjs, which already handled this defensively — it's
// robust to incidental whitespace/casing without needing the exact enum to
// be verified first.
function parseLabel(rawContent) {
  const raw = String(rawContent || "").trim();
  const normalized = raw.toLowerCase().replace(/\s+/g, "");
  const grounded = normalized.includes("notgrounded")
    ? "notGrounded"
    : normalized.includes("grounded")
      ? "grounded"
      : "notSure";
  return { grounded, raw };
}

/**
 * Verify that `answer` is supported by `context`, via Upstage's Groundedness
 * Check (a real second model call, not self-critique of the same model).
 *
 * @param {object} options
 * @param {string} options.context - the source text the answer should be checked against.
 * @param {string} options.answer - the claim/answer/summary to verify.
 * @returns {Promise<{grounded: "grounded"|"notGrounded"|"notSure", raw: string}>}
 * @throws {Error} if UPSTAGE_API_KEY is not configured, or on an API error
 *   (via UpstageAdapter, which throws plain Error for chat-completions
 *   failures — see src/upstage/errors.mjs's header for why UpstageApiError
 *   is not used on this path).
 */
export async function checkGroundedness({ context, answer } = {}) {
  const trimmedContext = typeof context === "string" ? context.trim() : "";
  const trimmedAnswer = typeof answer === "string" ? answer.trim() : "";
  if (!trimmedContext) throw new Error("checkGroundedness() requires a `context`");
  if (!trimmedAnswer) throw new Error("checkGroundedness() requires an `answer`");

  const adapter = new UpstageAdapter({ model: resolveModel(), temperature: 0 });
  if (!adapter.isConfigured()) {
    throw new Error("UPSTAGE_API_KEY is not configured — groundedness check requires it");
  }

  const completion = await adapter.complete({
    messages: [
      { role: "user", content: trimmedContext },
      { role: "assistant", content: trimmedAnswer }
    ],
    tools: [],
    stream: false
  });

  return parseLabel(completion?.content);
}
