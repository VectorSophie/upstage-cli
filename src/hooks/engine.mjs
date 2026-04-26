import { execFile } from "node:child_process";

// ── Command hook runner ────────────────────────────────────────────────────

async function runCommandHook(hook, eventType, payload) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOOK_EVENT: eventType,
      HOOK_TOOL: payload.tool || "",
      HOOK_INPUT_JSON: JSON.stringify(payload)
    };
    const timeout = typeof hook.timeout === "number" ? hook.timeout : 10_000;

    execFile(hook.command, [], { env, timeout }, (error, stdout) => {
      if (error) {
        resolve({ _error: error });
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (_e) {
        resolve({});
      }
    });
  });
}

async function runHookDef(hook, eventType, payload, failOpen = true) {
  try {
    if (hook.type === "handler" && typeof hook.fn === "function") {
      const result = await hook.fn({ event: eventType, ...payload });
      return result && typeof result === "object" ? result : {};
    }
    if (hook.type === "command" && typeof hook.command === "string") {
      const result = await runCommandHook(hook, eventType, payload);
      if (result._error) {
        return failOpen ? {} : { _denied: true };
      }
      return result;
    }
  } catch (_e) {
    return failOpen ? {} : { _denied: true };
  }
  return {};
}

// ── HookEngine ─────────────────────────────────────────────────────────────

export class HookEngine {
  constructor(settingsHooks = {}) {
    this._settingsHooks = settingsHooks;
    this._handlers = new Map(); // hookName → Set<handler>
  }

  // ── Backward compat: in-memory handler registry ──────────────────────────

  on(hookName, handler) {
    if (!this._handlers.has(hookName)) {
      this._handlers.set(hookName, new Set());
    }
    this._handlers.get(hookName).add(handler);
    return () => this._handlers.get(hookName)?.delete(handler);
  }

  async fire(hookName, payload) {
    const handlers = this._handlers.get(hookName);
    if (!handlers || handlers.size === 0) return [];
    const results = [];
    for (const handler of handlers) {
      const result = await handler(payload);
      if (result !== undefined) results.push(result);
    }
    return results;
  }

  // ── Structured hook runners ──────────────────────────────────────────────

  async runPreToolUse(toolName, input) {
    // Fire legacy in-memory BeforeTool handlers
    await this.fire("BeforeTool", { tool: toolName, args: input }).catch(() => {});

    const hooks = this._settingsHooks.PreToolUse || [];
    for (const hook of hooks) {
      const failOpen = hook.failOpen !== false;
      const result = await runHookDef(hook, "PreToolUse", { tool: toolName, input }, failOpen);
      if (result._denied || result.decision === "deny") {
        return { allow: false, message: result.message || `PreToolUse hook denied ${toolName}` };
      }
    }
    return { allow: true };
  }

  async runPostToolUse(toolName, result) {
    await this.fire("AfterTool", { tool: toolName, result }).catch(() => {});

    const hooks = this._settingsHooks.PostToolUse || [];
    let finalResult = result;
    for (const hook of hooks) {
      const res = await runHookDef(hook, "PostToolUse", { tool: toolName, result: finalResult }, true);
      if (res.modifiedResult !== undefined) {
        finalResult = res.modifiedResult;
      }
    }
    return finalResult;
  }

  async runStop() {
    const hooks = this._settingsHooks.Stop || [];
    for (const hook of hooks) {
      const res = await runHookDef(hook, "Stop", {}, true);
      if (res.preventStop) return false;
    }
    return true;
  }

  runNotification(event, data) {
    Promise.resolve()
      .then(() => this.fire("Notification", { event, data }))
      .catch(() => {});
    const hooks = this._settingsHooks.Notification || [];
    for (const hook of hooks) {
      runHookDef(hook, "Notification", { event, data }, true).catch(() => {});
    }
  }

  runSessionStart(sessionId) {
    this.runNotification("SessionStart", { sessionId });
  }
}
