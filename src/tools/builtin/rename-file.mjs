import { rename, stat } from "node:fs/promises";
import { relative, resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { PolicyEngine } from "../../core/policy/engine.mjs";

function createPolicyViolationError(message, details = {}) {
  const error = new Error(message);
  error.code = "POLICY_VIOLATION";
  error.details = details;
  return error;
}

export const renameFileTool = {
  name: "rename_file",
  description: "Move or rename a file within the workspace",
  risk: "high",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Current path" },
      to:   { type: "string", description: "New path" }
    },
    required: ["from", "to"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.from !== "string" || typeof args.to !== "string") {
      throw new Error("from and to are required");
    }

    const workspaceCwd =
      typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();

    const candidatePolicyEngine = context.registry?.policyEngine || context.policyEngine;
    const policyEngine =
      candidatePolicyEngine && typeof candidatePolicyEngine.evaluateWritePath === "function"
        ? candidatePolicyEngine
        : new PolicyEngine();

    const fromDecision = policyEngine.evaluateWritePath(args.from, { ...context, cwd: workspaceCwd });
    const toDecision   = policyEngine.evaluateWritePath(args.to,   { ...context, cwd: workspaceCwd });
    const fromAbs = fromDecision.details?.absolutePath || resolve(workspaceCwd, args.from);
    const toAbs   = toDecision.details?.absolutePath   || resolve(workspaceCwd, args.to);

    if (!fromDecision.allowed) {
      throw createPolicyViolationError(`Rename blocked by policy for source: ${fromAbs}`, fromDecision.details);
    }
    if (!toDecision.allowed) {
      throw createPolicyViolationError(`Rename blocked by policy for destination: ${toAbs}`, toDecision.details);
    }

    try {
      const s = await stat(fromAbs);
      if (s.isDirectory()) throw new Error(`Source is a directory; rename_file only moves files`);
    } catch (err) {
      if (err.code === "ENOENT") throw new Error(`Source file not found: ${args.from}`);
      throw err;
    }

    // Create destination parent directory if needed
    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);

    return {
      from: relative(workspaceCwd, fromAbs),
      to:   relative(workspaceCwd, toAbs)
    };
  }
};
