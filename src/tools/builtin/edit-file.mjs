import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PolicyEngine } from "../../core/policy/engine.mjs";

function createPolicyViolationError(message, details = {}) {
  const error = new Error(message);
  error.code = "POLICY_VIOLATION";
  error.details = details;
  return error;
}

export const editFileTool = {
  name: "edit_file",
  description: "Edit a file by replacing oldText with newText",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      replaceAll: { type: "boolean" }
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.path !== "string") {
      throw new Error("path is required");
    }
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      throw new Error("oldText and newText are required");
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
      const message = `Write blocked by policy for path: ${absolutePath}`;

      context.onLog?.({
        stage: "policy",
        channel: "security",
        text: `${message} (${writePathDecision.reason})`
      });
      context.eventBus?.emit?.("POLICY_DECISION", {
        source: "edit_file",
        tool: "edit_file",
        actionClass: "write",
        approved: false,
        decision: writePathDecision.reason,
        allowed: false,
        reason: writePathDecision.reason
      });

      throw createPolicyViolationError(message, {
        ...writePathDecision.details,
        reason: writePathDecision.reason
      });
    }

    const original = await readFile(absolutePath, "utf8");

    if (!original.includes(args.oldText)) {
      throw new Error("oldText not found in file");
    }

    const updated = args.replaceAll
      ? original.split(args.oldText).join(args.newText)
      : original.replace(args.oldText, args.newText);

    await writeFile(absolutePath, updated, "utf8");
    return {
      path: relative(workspaceCwd, absolutePath),
      replaced: args.replaceAll ? "all" : "first"
    };
  }
};
