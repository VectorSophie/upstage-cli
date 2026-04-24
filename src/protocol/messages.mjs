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
  POLICY_BLOCKED: "policy_blocked"
};
