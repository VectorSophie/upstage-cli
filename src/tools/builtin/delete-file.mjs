import { unlink, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PolicyEngine } from "../../core/policy/engine.mjs";

function createPolicyViolationError(message, details = {}) {
  const error = new Error(message);
  error.code = "POLICY_VIOLATION";
  error.details = details;
  return error;
}

export const deleteFileTool = {
  name: "delete_file",
  description: "Delete a file from the workspace",
  risk: "high",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.path !== "string" || !args.path) {
      throw new Error("path is required");
    }

    const workspaceCwd =
      typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();

    const candidatePolicyEngine = context.registry?.policyEngine || context.policyEngine;
    const policyEngine =
      candidatePolicyEngine && typeof candidatePolicyEngine.evaluateWritePath === "function"
        ? candidatePolicyEngine
        : new PolicyEngine();

    const writePathDecision = policyEngine.evaluateWritePath(args.path, { ...context, cwd: workspaceCwd });
    const absolutePath = writePathDecision.details?.absolutePath || resolve(workspaceCwd, args.path);

    if (!writePathDecision.allowed) {
      throw createPolicyViolationError(`Delete blocked by policy for path: ${absolutePath}`, {
        ...writePathDecision.details,
        reason: writePathDecision.reason
      });
    }

    // Confirm the file exists before trying to delete
    try {
      const s = await stat(absolutePath);
      if (s.isDirectory()) throw new Error(`Path is a directory, not a file: ${args.path}`);
    } catch (err) {
      if (err.code === "ENOENT") throw new Error(`File not found: ${args.path}`);
      throw err;
    }

    await unlink(absolutePath);
    return { deleted: relative(workspaceCwd, absolutePath) };
  }
};
