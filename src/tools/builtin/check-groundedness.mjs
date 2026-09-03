import { UpstageAdapter } from "../../model/upstage-adapter.mjs";

// Upstage's Groundedness Check — verifies an answer is actually supported
// by its context, rather than the model grading its own homework. Real
// endpoint/payload confirmed from langchain-upstage's (now-deprecated but
// still-functional) UpstageGroundednessCheck tool: it's a plain chat
// completion against a dedicated verification checkpoint
// ("solar-1-mini-answer-verification"), sent as [user: context, assistant:
// answer], non-streaming. The response content is literally the string
// "grounded" | "notGrounded" | "notSure" — no JSON envelope.
const VERIFICATION_MODEL = process.env.UPSTAGE_GROUNDEDNESS_MODEL || "solar-1-mini-answer-verification";

export const checkGroundednessTool = {
  name: "check_groundedness",
  description:
    "Verify that an answer/claim is actually supported by its source context, using Upstage's Groundedness Check " +
    "(a real second model call, not self-critique). Use this before presenting a summary, explanation, or factual " +
    "claim about retrieved/read content when uncertain — per Solar Pro2's own prompting guidance, it's better to " +
    "admit uncertainty than assert an ungrounded claim. Returns 'grounded', 'notGrounded', or 'notSure'.",
  risk: "low",
  actionClass: "network",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string", description: "The source text the answer should be checked against" },
      answer: { type: "string", description: "The claim/answer/summary to verify" }
    },
    required: ["context", "answer"],
    additionalProperties: false
  },
  async execute(args) {
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const answer = typeof args.answer === "string" ? args.answer.trim() : "";
    if (!context) throw new Error("context is required");
    if (!answer) throw new Error("answer is required");

    const adapter = new UpstageAdapter({ model: VERIFICATION_MODEL, temperature: 0 });
    if (!adapter.isConfigured()) {
      throw new Error("UPSTAGE_API_KEY is not configured — groundedness check requires it");
    }

    const completion = await adapter.complete({
      messages: [
        { role: "user", content: context },
        { role: "assistant", content: answer }
      ],
      tools: [],
      stream: false
    });

    const raw = String(completion?.content || "").trim();
    const normalized = raw.toLowerCase().replace(/\s+/g, "");
    const grounded =
      normalized.includes("notgrounded") ? "notGrounded" :
      normalized.includes("grounded") ? "grounded" :
      "notSure";

    return { grounded, raw };
  }
};
