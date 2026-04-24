export const AgentEventType = {
  LIFECYCLE: "lifecycle",
  PLAN: "plan",
  THINKING: "thinking",
  STREAM_START: "stream_start",
  STREAM_TOKEN: "stream_token",
  STREAM_END: "stream_end",
  TOOL_START: "tool_start",
  TOOL_LOG: "tool_log",
  TOOL_RESULT: "tool_result",
  PATCH_PREVIEW: "patch_preview",
  VERIFY_START: "verify_start",
  VERIFY_END: "verify_end",
  TOKEN_USAGE: "token_usage",
  SYSTEM_WARNING: "system_warning",
  COMPACTION: "compaction",
  HOOK_PERMISSION_RESULT: "hook_permission_result",
  ERROR: "error",
  STOP: "stop"
};

export const LifecycleStage = {
  AGENT_START: "agent_start",
  AGENT_END: "agent_end",
  HOOK_PRE_AGENT: "hook_pre_agent",
  HOOK_POST_AGENT: "hook_post_agent",
  HOOK_PRE_TOOL_SELECTION: "hook_pre_tool_selection",
  HOOK_POST_TOOL_SELECTION: "hook_post_tool_selection"
};

export function createEvent(type, payload = {}) {
  return { type, ...payload, timestamp: Date.now() };
}

export function createLifecycleEvent(stage, payload = {}) {
  return createEvent(AgentEventType.LIFECYCLE, { stage, ...payload });
}
