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
