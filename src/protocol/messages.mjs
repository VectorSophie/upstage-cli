export const AgentState = {
  IDLE: "idle",
  PLANNING: "planning",
  ACTING: "acting",
  VERIFYING: "verifying",
  AWAITING_USER: "awaiting_user",
  OBSERVING: "observing",
  DONE: "done",
  FAIL: "fail"
};

export const StopReason = {
  DONE: "done",
  NEEDS_USER_INPUT: "needs_user_input",
  BUDGET_EXHAUSTED: "budget_exhausted",
  TOOL_ERROR: "tool_error",
  MODEL_ERROR: "model_error",
  POLICY_BLOCKED: "policy_blocked",
  // The model stopped before finishing an ordinary turn — the provider reported
  // finish_reason=length (output budget exhausted) or content_filter. The
  // generation is UNFINISHED, so it must never be reported as a normal DONE
  // completion, and any tool call it was mid-way through must not be executed.
  OUTPUT_TRUNCATED: "output_truncated"
};
