const EVENT_TYPES = new Set([
  "AGENT_LIFECYCLE",
  "AGENT_PLAN",
  "AGENT_OBSERVATION",
  "TOOL_LIFECYCLE",
  "POLICY_DECISION",
  "HOOK_LIFECYCLE",
  "VERIFY_RESULT",
  "VERIFY_LOG",
  "TOKEN_USAGE",
  "SYSTEM_WARNING"
]);

function toStringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

export function createRuntimeEvent(type, payload = {}) {
  const normalizedType = toStringOrEmpty(type);
  if (!EVENT_TYPES.has(normalizedType)) {
    throw new Error(`Unsupported runtime event type: ${normalizedType}`);
  }

  return {
    type: normalizedType,
    at: Date.now(),
    ...payload
  };
}

export function isRuntimeEvent(event) {
  return !!event && typeof event === "object" && EVENT_TYPES.has(event.type);
}

export function listRuntimeEventTypes() {
  return Array.from(EVENT_TYPES.values());
}
