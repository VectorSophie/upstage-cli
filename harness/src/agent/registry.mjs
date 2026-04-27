import { MockAgent } from "./adapters/mock.mjs";
import { UpstageAgent } from "./adapters/upstage.mjs";
import { ClaudeCodeAgent } from "./adapters/claude-code.mjs";
import { AiderAgent } from "./adapters/aider.mjs";
import { OpenCodeAgent } from "./adapters/opencode.mjs";

const BUILTIN_ADAPTERS = [
  { ids: ["mock"], factory: () => new MockAgent() },
  { ids: ["upstage", "solar", "solar-pro2"], factory: (opts) => new UpstageAgent(opts) },
  { ids: ["claude", "claude-code"], factory: (opts) => new ClaudeCodeAgent(opts) },
  { ids: ["aider"], factory: (opts) => new AiderAgent(opts) },
  { ids: ["opencode"], factory: (opts) => new OpenCodeAgent(opts) }
];

export class AgentRegistry {
  constructor() {
    this._adapters = [...BUILTIN_ADAPTERS];
  }

  register(ids, factory) {
    if (!Array.isArray(ids)) ids = [ids];
    this._adapters.push({ ids, factory });
  }

  resolve(agentId, options = {}) {
    const id = agentId.toLowerCase().trim();
    const entry = this._adapters.find((a) => a.ids.includes(id));
    if (!entry) {
      throw new Error(
        `Unknown agent: "${agentId}". Available: ${this.availableIds().join(", ")}`
      );
    }
    return entry.factory(options);
  }

  availableIds() {
    return this._adapters.flatMap((a) => a.ids);
  }

  listAvailable() {
    return this._adapters.flatMap((a) =>
      a.ids.map((id) => {
        try {
          const agent = a.factory({});
          return { id, displayName: agent.displayName, available: agent.isAvailable() };
        } catch {
          return { id, displayName: id, available: false };
        }
      })
    );
  }
}

export const defaultRegistry = new AgentRegistry();
