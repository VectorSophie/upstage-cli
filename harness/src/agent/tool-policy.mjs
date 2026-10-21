/**
 * Tool allow/deny enforcement for harness agents.
 *
 * Semantics:
 *   - deny wins over allow
 *   - empty allow list = every registered tool not denied
 *   - allow matches exact tool names only (a namespaced/aliased variant such as
 *     `mcp__srv__write_file` is NOT allowed by `allow: [write_file]`)
 *   - deny matches the exact name AND any alias of it: case-insensitive, with
 *     `-`/`_`/`.` treated alike and namespace prefixes (`srv__x`, `srv.x`,
 *     `srv/x`, `srv:x`) stripped — so `deny: [write_file]` also blocks
 *     `mcp__fs__write_file`, `Write-File`, `fs.write_file`, …
 */

const NAMESPACE_SEP = /__|[./:]/;

export function canonicalToolName(name) {
  const parts = String(name).split(NAMESPACE_SEP).filter(Boolean);
  const leaf = parts.length > 0 ? parts[parts.length - 1] : String(name);
  return leaf.toLowerCase().replace(/[-_.\s]+/g, "_");
}

export function createToolPolicy({ allow = [], deny = [] } = {}) {
  for (const list of [allow, deny]) {
    if (!Array.isArray(list) || list.some((n) => typeof n !== "string" || n.trim() === "")) {
      throw new Error("agent.tools.allow/deny must be arrays of non-empty strings");
    }
  }
  const allowSet = new Set(allow);
  const denyExact = new Set(deny);
  const denyCanonical = new Set(deny.map(canonicalToolName));

  function check(name) {
    if (typeof name !== "string" || name.length === 0) return { allowed: false, reason: "malformed_tool_name" };
    if (denyExact.has(name) || denyCanonical.has(canonicalToolName(name))) return { allowed: false, reason: "denied" };
    if (allowSet.size > 0 && !allowSet.has(name)) return { allowed: false, reason: "not_in_allowlist" };
    return { allowed: true, reason: null };
  }

  return { allow: [...allowSet], deny: [...denyExact], check, isAllowed: (name) => check(name).allowed };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Enforce `policy` on a src/tools ToolRegistry, in place:
 *   1. unauthorized tools are removed, so they are never advertised to the model
 *      (toModelTools/list) and an invocation hits TOOL_NOT_FOUND
 *   2. execute() re-checks the policy on every call (covers tools registered
 *      later and nested executeTool calls) and rejects malformed calls
 * Returns { advertised, removed }.
 */
export function enforceToolPolicy(registry, policy) {
  const removed = [];
  for (const name of [...registry.tools.keys()]) {
    if (!policy.isAllowed(name)) {
      registry.tools.delete(name);
      removed.push(name);
    }
  }

  const innerExecute = registry.execute.bind(registry);
  registry.execute = async (name, args = {}, context = {}) => {
    const verdict = policy.check(name);
    if (!verdict.allowed) {
      return { ok: false, error: { code: verdict.reason === "malformed_tool_name" ? "INVALID_TOOL_CALL" : "TOOL_DENIED", message: `Tool not permitted by task policy (${verdict.reason}): ${String(name)}` } };
    }
    if (!registry.tools.has(name)) {
      return { ok: false, error: { code: "TOOL_NOT_FOUND", message: `Unknown tool: ${name}` } };
    }
    if (!isPlainObject(args)) {
      return { ok: false, error: { code: "INVALID_TOOL_CALL", message: `Tool arguments must be a JSON object: ${name}` } };
    }
    return innerExecute(name, args, context);
  };

  const innerRegister = registry.register.bind(registry);
  registry.register = (tool) => {
    if (!policy.isAllowed(tool?.name)) {
      removed.push(tool?.name);
      return;
    }
    innerRegister(tool);
  };

  return { advertised: [...registry.tools.keys()].sort(), removed: removed.sort() };
}
