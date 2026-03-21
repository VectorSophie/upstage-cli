import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { PolicyEngine } from "../../core/policy/engine.js";

function createPolicyViolationError(message, details = {}) {
  const error = new Error(message);
  error.code = "POLICY_VIOLATION";
  error.details = details;
  return error;
}

export const writeFileTool = {
  name: "write_file",
  description: "Create or overwrite a file within the workspace",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.path !== "string" || typeof args.content !== "string") {
      throw new Error("path and content are required");
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
        source: "write_file",
        tool: "write_file",
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
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, args.content, "utf8");
    return { path: relative(workspaceCwd, absolutePath), bytesWritten: Buffer.byteLength(args.content, "utf8") };
  }
};
