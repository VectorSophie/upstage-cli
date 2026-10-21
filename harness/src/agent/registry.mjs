import { MockAgent } from "./adapters/mock.mjs";
import { UpstageAgent } from "./adapters/upstage.mjs";
import { ClaudeCodeAgent } from "./adapters/claude-code.mjs";
import { AiderAgent } from "./adapters/aider.mjs";
import { OpenCodeAgent } from "./adapters/opencode.mjs";

const BUILTIN_ADAPTERS = [
  { ids: ["mock"], factory: () => new MockAgent() },
  { ids: ["upstage", "solar"], factory: (opts) => new UpstageAgent(opts) },
  // Legacy alias: means what it says — pin solar-pro2 unless --model overrides
  { ids: ["solar-pro2"], factory: (opts) => new UpstageAgent({ ...opts, model: opts.model || "solar-pro2" }) },
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
    if (typeof factory !== "function") throw new Error("register(ids, factory): factory must be a function");
    this._adapters.unshift({ ids: ids.map((i) => i.toLowerCase()), factory });
  }

  resolve(agentId, options = {}) {
    if (typeof agentId !== "string" || agentId.trim() === "") {
      throw new Error(`Agent id must be a non-empty string. Available: ${this.availableIds().join(", ")}`);
    }
    const id = agentId.toLowerCase().trim();
    const entry = this._adapters.find((a) => a.ids.includes(id));
    if (!entry) {
      throw new Error(
        `Unknown agent: "${agentId}". Available: ${this.availableIds().join(", ")}`
      );
    }
    const agent = entry.factory(options);
    if (!agent || typeof agent.run !== "function" || typeof agent.isAvailable !== "function") {
      throw new Error(`Agent "${agentId}" adapter is malformed (must implement run() and isAvailable())`);
    }
    return agent;
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
