import { CodingAgent } from "../agent/interface.mjs";

/**
 * ReplayEngine — replays a recorded run without calling the live model.
 *
 * Inspired by OpenHands mock LLM pattern:
 * - Loads trace.turns[] → stubs adapter.complete() to return recorded responses
 * - Loads trace.toolCalls[] → stubs registry.execute() to return recorded results
 * - Detects divergence when the agent calls a different tool than recorded
 */
export class ReplayEngine {
  constructor(runArtifact) {
    this._run = runArtifact;
    this._turns = runArtifact.trace?.turns || [];
    this._recordedToolCalls = runArtifact.trace?.toolCalls || [];
    this._divergences = [];
    this._stopAtTurn = null;
  }

  setStopAtTurn(n) {
    this._stopAtTurn = typeof n === "number" ? n : null;
    return this;
  }

  get divergences() {
    return [...this._divergences];
  }

  /**
   * Returns a stub CodingAgent that replays recorded turns instead of calling
   * the live model. The agent's run() yields the recorded events and returns
   * the recorded result.
   */
  createStubAgent() {
    const turns = this._turns;
    const stopAtTurn = this._stopAtTurn;
    const divergences = this._divergences;
    const recordedToolCalls = [...this._recordedToolCalls];
    const runId = this._run.id;

    const metrics = this._run.metrics || null;
    return new ReplayAgent({ turns, stopAtTurn, divergences, recordedToolCalls, runId, metrics });
  }

  /**
   * Re-runs the task with the stub agent, optionally with a different context
   * strategy (for context injection experiments).
   */
  async replay(task, runner, options = {}) {
    const stubAgent = this.createStubAgent();
    const result = await runner.run(task, stubAgent, options);
    result.replay = {
      sourceRunId: this._run.id,
      divergences: this._divergences,
      stoppedAtTurn: this._stopAtTurn
    };
    return result;
  }
}

class ReplayAgent extends CodingAgent {
  constructor({ turns, stopAtTurn, divergences, recordedToolCalls, runId, metrics }) {
    super();
    this._turns = turns;
    this._stopAtTurn = stopAtTurn;
    this._divergences = divergences;
    this._recordedToolCalls = recordedToolCalls;
    this._runId = runId;
    this._metrics = metrics;
    this._toolCallIdx = 0;
  }

  get id() { return `replay:${this._runId}`; }
  get displayName() { return `Replay (${this._runId})`; }
  isAvailable() { return true; }

  async run(task, context) {
    const { auditLog } = context;
    const events = [];
    let toolCalls = 0;
    let turns = 0;

    const limit = this._stopAtTurn !== null
      ? Math.min(this._stopAtTurn, this._turns.length)
      : this._turns.length;

    for (let i = 0; i < limit; i++) {
      const turn = this._turns[i];
      turns++;

      // Emit thinking if recorded
      if (turn.thoughtSummary) {
        events.push({ type: "thinking", thought: { subject: turn.thoughtSummary } });
      }

      // Replay tool calls for this turn
      for (const tc of (turn.toolCalls || [])) {
        const recorded = this._recordedToolCalls[this._toolCallIdx];
        if (recorded && recorded.tool !== tc.tool) {
          this._divergences.push({
            turn: i,
            expected: recorded.tool,
            actual: tc.tool,
            args: tc.args
          });
        }
        events.push({ type: "tool_start", tool: tc.tool || (recorded?.tool), args: tc.args || {} });
        events.push({ type: "tool_result", tool: tc.tool || (recorded?.tool), ok: recorded?.ok ?? true, result: recorded?.result });
        toolCalls++;
        this._toolCallIdx++;
      }

      // Emit response tokens
      if (turn.response) {
        for (const chunk of chunkText(turn.response, 80)) {
          events.push({ type: "stream_token", text: chunk });
        }
      }
    }

    if (auditLog) auditLog.recordEvents(events);

    return {
      ok: true,
      turns,
      toolCalls,
      usage: this._metrics ? {
        promptTokens: this._metrics.promptTokens || 0,
        completionTokens: this._metrics.completionTokens || 0,
        totalTokens: this._metrics.totalTokens || 0
      } : null,
      events,
      stopReason: this._stopAtTurn !== null ? `replay_stopped_at_turn_${this._stopAtTurn}` : "replay_complete"
    };
  }
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
