export { HookEngine } from "../../hooks/engine.mjs";

const HOOK_NAMES = new Set([
  "BeforeAgent",
  "BeforeToolSelection",
  "BeforeTool",
  "AfterTool",
  "AfterAgent"
]);

export class HookSystem {
  constructor() {
    this.handlers = new Map();
    for (const hookName of HOOK_NAMES) {
      this.handlers.set(hookName, new Set());
    }
  }

  on(hookName, handler) {
    if (!HOOK_NAMES.has(hookName)) {
      throw new Error(`Unsupported hook name: ${hookName}`);
    }
    if (typeof handler !== "function") {
      throw new Error("hook handler must be a function");
    }

    this.handlers.get(hookName).add(handler);
    return () => {
      this.handlers.get(hookName).delete(handler);
    };
  }

  async fire(hookName, payload) {
    if (!HOOK_NAMES.has(hookName)) {
      throw new Error(`Unsupported hook name: ${hookName}`);
    }

    const hookHandlers = this.handlers.get(hookName);
    const results = [];
    for (const handler of hookHandlers) {
      const result = await handler(payload);
      if (typeof result !== "undefined") {
        results.push(result);
      }
    }
    return results;
  }
}

export function listHookNames() {
  return Array.from(HOOK_NAMES.values());
}
