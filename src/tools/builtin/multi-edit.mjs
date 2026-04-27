import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PolicyEngine } from "../../core/policy/engine.mjs";

function createPolicyViolationError(message, details = {}) {
  const error = new Error(message);
  error.code = "POLICY_VIOLATION";
  error.details = details;
  return error;
}

export const multiEditTool = {
  name: "multi_edit",
  description: "Apply multiple search-and-replace edits to a single file in one call",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        description: "Ordered list of edits to apply sequentially",
        items: {
          type: "object",
          properties: {
            oldText:    { type: "string" },
            newText:    { type: "string" },
            replaceAll: { type: "boolean" }
          },
          required: ["oldText", "newText"],
          additionalProperties: false
        },
        minItems: 1
      }
    },
    required: ["path", "edits"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.path !== "string") throw new Error("path is required");
    if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error("edits array is required");

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
      throw createPolicyViolationError(`Write blocked by policy for path: ${absolutePath}`, {
        ...writePathDecision.details,
        reason: writePathDecision.reason
      });
    }

    let content = await readFile(absolutePath, "utf8");
    const applied = [];
    const failed = [];

    for (let i = 0; i < args.edits.length; i++) {
      const { oldText, newText, replaceAll } = args.edits[i];
      if (!content.includes(oldText)) {
        failed.push({ index: i, oldText: oldText.slice(0, 60), reason: "oldText not found" });
        continue;
      }
      content = replaceAll
        ? content.split(oldText).join(newText)
        : content.replace(oldText, newText);
      applied.push({ index: i, replaceAll: !!replaceAll });
    }

    if (failed.length > 0 && applied.length === 0) {
      throw new Error(`All edits failed: ${failed.map((f) => f.reason).join("; ")}`);
    }

    await writeFile(absolutePath, content, "utf8");
    return {
      path: relative(workspaceCwd, absolutePath),
      applied: applied.length,
      failed: failed.length,
      failures: failed
    };
  }
};
