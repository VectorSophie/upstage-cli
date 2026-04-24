import { runAgentLoop } from "../../agent/loop.mjs";
import { createSession } from "../../runtime/session.mjs";
import { createDefaultAgentRoleRegistry } from "../../agent/registry/index.mjs";

function createScopedRegistry(parentRegistry, allowedTools) {
  const allowlist = new Set(allowedTools);
  return {
    eventBus: parentRegistry.eventBus,
    hookSystem: parentRegistry.hookSystem,
    toModelTools() {
      return parentRegistry
        .toModelTools()
        .filter((item) => allowlist.has(item.function?.name));
    },
    list() {
      return parentRegistry.list().filter((tool) => allowlist.has(tool.name));
    },
    execute(name, args, context) {
      if (!allowlist.has(name)) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "POLICY_BLOCKED",
            message: `Subagent tool blocked by allowlist: ${name}`
          }
        });
      }
      return parentRegistry.execute(name, args, context);
    }
  };
}

const DEFAULT_ALLOWED_TOOLS = [
  "read_file",
  "search_code",
  "find_symbol",
  "find_references",
  "list_modules",
  "repo_map",
  "index_health"
];

export const runSubagentTool = {
  name: "run_subagent",
  description: "Run a scoped subagent task with restricted tools",
  risk: "medium",
  actionClass: "exec",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string" },
      role: { type: "string" },
      allowedTools: {
        type: "array",
        items: { type: "string" }
      },
      maxSteps: { type: "number" }
    },
    required: ["task"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.task !== "string" || args.task.trim().length === 0) {
      throw new Error("task is required");
    }

    const roleRegistry = createDefaultAgentRoleRegistry();
    const role = roleRegistry.get(args.role || "explorer") || roleRegistry.get("explorer");

    const allowedTools =
      Array.isArray(args.allowedTools) && args.allowedTools.length > 0
        ? args.allowedTools
        : DEFAULT_ALLOWED_TOOLS;

    const scopedRegistry = createScopedRegistry(context.registry, allowedTools);
    const subSession = createSession(context.cwd);
    subSession.parentSessionId = context.session?.id || null;
    subSession.role = role.name;

    const subResult = await runAgentLoop({
      input: args.task,
      registry: scopedRegistry,
      cwd: context.cwd,
      adapter: context.adapter,
      stream: false,
      session: subSession,
      runtimeCache: context.runtimeCache || {},
      budget: {
        maxSteps: Number.isInteger(args.maxSteps) ? args.maxSteps : 4,
        maxToolCalls: 6,
        maxWallTimeMs: 15000
      }
    });

    return {
      role: role.name,
      allowedTools,
      stopReason: subResult.stopReason,
      ok: subResult.ok,
      response: subResult.response,
      trace: subResult.trace,
      summary: {
        steps: Array.isArray(subResult.trace) ? subResult.trace.length : 0,
        runtimeEvents: Array.isArray(subResult.session?.runtimeEvents)
          ? subResult.session.runtimeEvents.length
          : 0
      }
    };
  }
};
