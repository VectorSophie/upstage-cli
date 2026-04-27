/**
 * Abstract base class for all coding agents.
 *
 * AgentResult shape:
 * {
 *   ok: boolean,
 *   error?: string,
 *   turns: number,
 *   toolCalls: number,
 *   usage: { promptTokens, completionTokens, totalTokens } | null,
 *   events: AgentEvent[],
 *   stopReason?: string
 * }
 */
export class CodingAgent {
  get id() {
    return "";
  }

  get displayName() {
    return this.id;
  }

  isAvailable() {
    return true;
  }

  /**
   * @param {object} task - resolved task spec
   * @param {object} context - { workdir, sandbox, auditLog, costTracker, task }
   * @returns {Promise<AgentResult>}
   */
  async run(_task, _context) {
    throw new Error(`${this.constructor.name}.run() not implemented`);
  }
}
