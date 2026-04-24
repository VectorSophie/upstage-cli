import { RuntimeEventBus } from "../core/events/bus.mjs";
import { HookSystem } from "../core/hooks/lifecycle.mjs";
import { PolicyEngine } from "../core/policy/engine.mjs";

function emitEvent(eventBus, type, payload) {
  if (!eventBus || typeof eventBus.emit !== "function") {
    return;
  }
  eventBus.emit(type, payload);
}

function summarizeContext(context = {}) {
  return {
    cwd: context.cwd || null,
    hasConfirm: typeof context.confirm === "function",
    hasSession: !!context.session,
    sessionId: context.session?.id || null,
    hasRuntimeCache: !!context.runtimeCache
  };
}

function summarizeResult(result) {
  if (result === null || typeof result === "undefined") {
    return null;
  }
  if (typeof result === "string") {
    return {
      type: "string",
      length: result.length
    };
  }
  if (Array.isArray(result)) {
    return {
      type: "array",
      length: result.length
    };
  }
  if (typeof result === "object") {
    return {
      type: "object",
      keys: Object.keys(result).slice(0, 10)
    };
  }
  return {
    type: typeof result
  };
}

async function fireHook(hookSystem, eventBus, hookName, payload) {
  if (!hookSystem || typeof hookSystem.fire !== "function") {
    return [];
  }
  emitEvent(eventBus, "HOOK_LIFECYCLE", {
    hook: hookName,
    stage: "start",
    tool: payload?.tool || null,
    context: summarizeContext(payload?.context || {})
  });
  const results = await hookSystem.fire(hookName, payload);
  emitEvent(eventBus, "HOOK_LIFECYCLE", {
    hook: hookName,
    stage: "end",
    tool: payload?.tool || null,
    context: summarizeContext(payload?.context || {}),
    results: summarizeResult(results)
  });
  return results;
}

export class ToolRegistry {
  constructor(config = {}) {
    this.policy = {
      allowHighRiskTools: false,
      requireConfirmationForHighRisk: true,
      ...config
    };
    this.eventBus = config.eventBus || new RuntimeEventBus();
    this.hookSystem = config.hookSystem || new HookSystem();
    this.policyEngine =
      config.policyEngine ||
      new PolicyEngine({
        allowHighRiskTools: this.policy.allowHighRiskTools,
        requireConfirmationForHighRisk: this.policy.requireConfirmationForHighRisk
      });
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.execute !== "function") {
      throw new Error("Invalid tool registration");
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, {
      risk: "low",
      actionClass: null,
      source: "builtin",
      permissions: [],
      timeoutMs: 120000,
      outputBudget: 20000,
      description: "",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true
      },
      ...tool
    });
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      source: tool.source,
      actionClass: tool.actionClass,
      permissions: tool.permissions,
      timeoutMs: tool.timeoutMs,
      outputBudget: tool.outputBudget,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  listActive(filter = {}) {
    const source = typeof filter.source === "string" ? filter.source : null;
    const risk = typeof filter.risk === "string" ? filter.risk : null;
    return this.list().filter((tool) => {
      if (source && tool.source !== source) {
        return false;
      }
      if (risk && tool.risk !== risk) {
        return false;
      }
      return true;
    });
  }

  sortedList() {
    const priorityBySource = {
      builtin: 0,
      discovered: 1,
      mcp: 2
    };
    return this.list().sort((a, b) => {
      const left = priorityBySource[a.source] ?? 9;
      const right = priorityBySource[b.source] ?? 9;
      if (left !== right) {
        return left - right;
      }
      return a.name.localeCompare(b.name);
    });
  }

  toModelTools() {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        parameters: tool.inputSchema || {
          type: "object",
          properties: {},
          additionalProperties: true
        }
      }
    }));
  }

  async execute(name, args = {}, context = {}) {
    const eventBus = context.eventBus || this.eventBus;
    const tool = this.get(name);
    if (!tool) {
      emitEvent(eventBus, "TOOL_LIFECYCLE", {
        stage: "not_found",
        tool: name,
        args: summarizeResult(args)
      });
      return {
        ok: false,
        error: { code: "TOOL_NOT_FOUND", message: `Unknown tool: ${name}` }
      };
    }

    await fireHook(this.hookSystem, eventBus, "BeforeTool", {
      tool: name,
      args,
      context
    });

    const policyDecision = this.policyEngine.evaluate(tool, args, context);
    emitEvent(eventBus, "POLICY_DECISION", {
      tool: name,
      risk: tool.risk,
      actionClass: policyDecision.actionClass,
      decision: policyDecision.reason,
      allowed: policyDecision.allowed,
      requiresConfirmation: policyDecision.requiresConfirmation
    });

    if (!policyDecision.allowed) {
      await fireHook(this.hookSystem, eventBus, "AfterTool", {
        tool: name,
        args,
        result: null,
        error: policyDecision.reason,
        context
      });
      return {
        ok: false,
        error: {
          code: "POLICY_BLOCKED",
          message: `Tool blocked by policy: ${name} (${policyDecision.reason})`
        }
      };
    }

    if (policyDecision.requiresConfirmation && typeof context.confirm === "function") {
      const approved = await context.confirm({
        tool: name,
        args,
        risk: tool.risk,
        description: tool.description,
        actionClass: policyDecision.actionClass
      });
      if (!approved) {
        await fireHook(this.hookSystem, eventBus, "AfterTool", {
          tool: name,
          args,
          result: null,
          error: "confirmation_denied",
          context
        });
        return {
          ok: false,
          error: {
            code: "POLICY_BLOCKED",
            message: `Execution denied for tool: ${name}`
          }
        };
      }
    }

    emitEvent(eventBus, "TOOL_LIFECYCLE", {
      stage: "start",
      tool: name,
      args: summarizeResult(args),
      risk: tool.risk
    });

    try {
      const data = await tool.execute(args, {
        ...context,
        eventBus,
        registry: this,
        executeTool: async (toolName, toolArgs = {}, childContext = {}) =>
          this.execute(toolName, toolArgs, { ...context, ...childContext, eventBus })
      });
      emitEvent(eventBus, "TOOL_LIFECYCLE", {
        stage: "end",
        tool: name,
        ok: true,
        result: summarizeResult(data)
      });
      await fireHook(this.hookSystem, eventBus, "AfterTool", {
        tool: name,
        args,
        result: data,
        error: null,
        context
      });
      return { ok: true, data };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown tool error";
      const errorCode =
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "TOOL_EXECUTION_FAILED";
      emitEvent(eventBus, "TOOL_LIFECYCLE", {
        stage: "end",
        tool: name,
        ok: false,
        error: errorMessage
      });
      await fireHook(this.hookSystem, eventBus, "AfterTool", {
        tool: name,
        args,
        result: null,
        error: errorMessage,
        context
      });
      return {
        ok: false,
        error: {
          code: errorCode,
          message: errorMessage
        }
      };
    }
  }
}
