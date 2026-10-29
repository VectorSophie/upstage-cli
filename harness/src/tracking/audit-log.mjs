export class AuditLog {
  constructor(runId) {
    this.runId = runId;
    this._turns = [];
    this._toolCalls = [];
    this._compactions = [];
    this._events = [];
    this._agentResult = null;
    this._currentTurn = null;
  }

  recordEvents(events) {
    for (const event of events) {
      this._events.push(event);
      if (event.type === "tool_start") {
        this._toolCalls.push({
          tool: event.tool,
          args: event.args || {},
          durationMs: 0,
          ok: null
        });
      } else if (event.type === "tool_result") {
        const last = this._toolCalls.findLast((tc) => tc.tool === event.tool && tc.ok === null);
        if (last) {
          last.ok = event.ok;
          last.durationMs = event.durationMs || 0;
          if (event.result !== undefined) last.result = truncate(event.result);
          // Preserve a STRUCTURED, length-capped copy of an execution result
          // (run_shell/run_tests return {ok,code,stdout,stderr,timedOut}). A
          // trace-aware evaluator needs stdout isolated from stderr/metadata and
          // the exit/timeout flags — the stringified `result` above conflates
          // them. Only kept for exec-shaped results (a string `stdout` field).
          if (event.result && typeof event.result === "object" && typeof event.result.stdout === "string") {
            last.resultData = {
              // The command's own success (exit 0 / not failed), not the
              // registry-level "tool didn't throw" flag.
              ok: event.result.ok === true,
              code: typeof event.result.code === "number" ? event.result.code : null,
              stdout: capText(event.result.stdout, 8000),
              stderr: capText(event.result.stderr, 2000),
              timedOut: event.result.timedOut === true,
              truncated: event.result.truncated === true
            };
          }
        }
      } else if (event.type === "thinking") {
        if (!this._currentTurn) {
          this._currentTurn = { index: this._turns.length, toolCalls: [], thoughtSummary: "", response: "" };
        }
        this._currentTurn.thoughtSummary = (event.thought?.subject || "").slice(0, 200);
      } else if (event.type === "stream_token") {
        if (this._currentTurn) {
          this._currentTurn.response += event.text || "";
        }
      } else if (event.type === "context_compaction") {
        this._compactions.push({ turn: this._turns.length, at: Date.now() });
      }
    }
    if (this._currentTurn) {
      this._turns.push(this._currentTurn);
      this._currentTurn = null;
    }
  }

  setAgentResult(result) {
    this._agentResult = result;
  }

  turns() {
    return this._turns;
  }

  toolCalls() {
    return this._toolCalls;
  }

  compactions() {
    return this._compactions;
  }

  events() {
    return this._events;
  }
}

function capText(value, limit) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]` : value;
}

function truncate(value, limit = 2000) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text && text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
}
