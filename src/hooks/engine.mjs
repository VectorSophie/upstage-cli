import { spawn } from "node:child_process";

// ── Command hook runner ────────────────────────────────────────────────────
//
// Claude-Code-compatible contract so community hook scripts run unmodified:
//   - the event payload is delivered as JSON on STDIN
//   - exit code 2 = block (stderr is the reason)
//   - other non-zero = non-blocking error (fail-open)
//   - stdout may be JSON: { decision: "block"|"approve", reason, continue,
//     additionalContext, modifiedResult, hookSpecificOutput }
// Legacy env vars (HOOK_EVENT/HOOK_TOOL/HOOK_INPUT_JSON) are kept for back-compat.

async function runCommandHook(hook, eventType, payload) {
  return new Promise((resolve) => {
    const inputJson = JSON.stringify({ hook_event_name: eventType, ...payload });
    const env = {
      ...process.env,
      HOOK_EVENT: eventType,
      HOOK_TOOL: payload.tool || "",
      HOOK_INPUT_JSON: inputJson
    };
    const timeout = typeof hook.timeout === "number" ? hook.timeout : 10_000;

    // On Windows, shell only for bare shim commands (e.g. `prettier` → .cmd);
    // a path/`.exe` command must not use the shell (it breaks stdin forwarding
    // and arg quoting). Same heuristic as the MCP stdio client.
    const isBare = !/[\\/]/.test(hook.command) && !/\.(exe|com)$/i.test(hook.command);
    const useShell = process.platform === "win32" && isBare;
    let child;
    try {
      child = spawn(hook.command, Array.isArray(hook.args) ? hook.args : [], {
        env,
        timeout,
        shell: useShell,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      resolve({ _error: err });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { stdout += String(c); });
    child.stderr?.on("data", (c) => { stderr += String(c); });
    child.on("error", (err) => resolve({ _error: err }));
    child.on("close", (code) => {
      // Exit 2 = blocking decision per the Claude hook contract.
      if (code === 2) {
        resolve({ _denied: true, decision: "block", reason: (stderr || stdout).trim() });
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim() || "null"); } catch { /* not JSON */ }
      if (parsed && typeof parsed === "object") {
        resolve({ ...parsed, _stdout: stdout, _stderr: stderr, _exitCode: code });
        return;
      }
      resolve({ _stdout: stdout.trim(), _stderr: stderr, _exitCode: code });
    });

    try {
      child.stdin?.write(inputJson);
      child.stdin?.end();
    } catch { /* stdin may already be closed */ }
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

function isBlocking(result) {
  return result._denied === true || result.decision === "deny" || result.decision === "block";
}

function collectContext(result) {
  if (typeof result.additionalContext === "string" && result.additionalContext) {
    return result.additionalContext;
  }
  // Plain-stdout hooks contribute their output as context (UserPromptSubmit etc.).
  if (typeof result._stdout === "string" && result._stdout) return result._stdout;
  return "";
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

  // ── Claude-compatible lifecycle events ────────────────────────────────────

  /** Runs before the agent processes a user prompt. A hook may block the prompt
   *  (exit 2 / decision:block) or inject additional context (stdout/
   *  additionalContext). Returns { allow, reason, additionalContext }. */
  async runUserPromptSubmit(prompt, extra = {}) {
    await this.fire("UserPromptSubmit", { prompt, ...extra }).catch(() => {});
    const hooks = this._settingsHooks.UserPromptSubmit || [];
    let additionalContext = "";
    for (const hook of hooks) {
      const failOpen = hook.failOpen !== false;
      const result = await runHookDef(hook, "UserPromptSubmit", { prompt, ...extra }, failOpen);
      if (isBlocking(result)) {
        return { allow: false, reason: result.reason || "UserPromptSubmit hook blocked the prompt", additionalContext };
      }
      const ctx = collectContext(result);
      if (ctx) additionalContext += (additionalContext ? "\n" : "") + ctx;
    }
    return { allow: true, additionalContext };
  }

  async runSessionEnd(sessionId, reason = "exit") {
    await this.fire("SessionEnd", { sessionId, reason }).catch(() => {});
    const hooks = this._settingsHooks.SessionEnd || [];
    for (const hook of hooks) {
      await runHookDef(hook, "SessionEnd", { sessionId, reason }, true);
    }
  }

  /** Runs before context compaction. A hook may veto via preventCompact/
   *  decision:block. Returns true if compaction should proceed. */
  async runPreCompact(info = {}) {
    await this.fire("PreCompact", info).catch(() => {});
    const hooks = this._settingsHooks.PreCompact || [];
    for (const hook of hooks) {
      const result = await runHookDef(hook, "PreCompact", info, true);
      if (result.preventCompact === true || isBlocking(result)) return false;
    }
    return true;
  }

  async runSubagentStop(info = {}) {
    await this.fire("SubagentStop", info).catch(() => {});
    const hooks = this._settingsHooks.SubagentStop || [];
    for (const hook of hooks) {
      const result = await runHookDef(hook, "SubagentStop", info, true);
      if (result.preventStop === true) return false;
    }
    return true;
  }
}
