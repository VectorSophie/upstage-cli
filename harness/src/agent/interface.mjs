/**
 * Abstract base class for all coding agents.
 *
 * AgentResult shape:
 * {
 *   ok: boolean,
 *   error?: string,
 *   turns: number,
 *   toolCalls: number,
 *   usage: { promptTokens, completionTokens, totalTokens } | null,   // null = unknown
 *   events: AgentEvent[],
 *   stopReason?: string,
 *   model?: { provider, id, revision, sampling, maxOutputTokens, contextLimit },
 *   tools?: { advertised, removedByPolicy, removedForIsolation, schemaHash }
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
   * True only if every command this agent executes goes through
   * context.executor (the task sandbox). Agents that spawn their own host
   * processes must leave this false — the runner refuses to run them on
   * sandbox.type=docker tasks rather than pretend they are isolated.
   */
  get supportsSandbox() {
    return false;
  }

  /**
   * @param {object} task - resolved task spec
   * @param {object} context - { workdir, sandbox (config), executor (NativeSandbox|DockerSandbox), auditLog, costTracker, task }
   * @returns {Promise<AgentResult>}
   */
  async run(_task, _context) {
    throw new Error(`${this.constructor.name}.run() not implemented`);
  }
}
