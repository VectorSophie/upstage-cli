import { checkGroundedness } from "../../upstage/groundedness.mjs";

// Upstage's Groundedness Check — verifies an answer is actually supported
// by its context, rather than the model grading its own homework. The
// actual API-calling logic (request shape, model id, response parsing) now
// lives in src/upstage/groundedness.mjs — see that module's header for the
// full provenance trail on the model id and response-label-enum caveats.
// This file's only job is adapting checkGroundedness()'s result into this
// tool's agent-facing contract, which is unchanged by that refactor.
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

    return checkGroundedness({ context, answer });
  }
};
