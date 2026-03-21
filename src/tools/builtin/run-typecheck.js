import { runSandboxedProcess } from "../../sandbox/exec.js";

export const runTypecheckTool = {
  name: "run_typecheck",
  description: "Run type checking",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "array", items: { type: "string" } },
      timeoutMs: { type: "number" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    const cmd =
      Array.isArray(args.command) && args.command.length > 0
        ? args.command
        : ["npm", "run", "typecheck", "--if-present"];
    const [binary, ...commandArgs] = cmd;
    const result = await runSandboxedProcess(binary, commandArgs, {
      cwd: context.cwd,
      timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : 120000,
      outputLimit: 60000,
      networkBlocked: true,
      onStdout: (text) => context.onLog?.({ stage: "typecheck", channel: "stdout", text }),
      onStderr: (text) => context.onLog?.({ stage: "typecheck", channel: "stderr", text })
    });
    return { stage: "typecheck", ...result };
  }
};
