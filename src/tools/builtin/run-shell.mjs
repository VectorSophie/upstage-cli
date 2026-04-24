import { runSandboxedCommand } from "../../sandbox/exec.mjs";

export const runShellTool = {
  name: "run_shell",
  description: "Execute an allowlisted shell command in sandbox",
  risk: "high",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "number" },
      outputLimit: { type: "number" },
      networkBlocked: { type: "boolean" }
    },
    required: ["command"],
    additionalProperties: false
  },
  async execute(args, context) {
    const result = await runSandboxedCommand(args.command, {
      cwd: context.cwd,
      timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : 120000,
      outputLimit: Number.isInteger(args.outputLimit) ? args.outputLimit : 40000,
      networkBlocked: args.networkBlocked !== false,
      onStdout: (text) => context.onLog?.({ channel: "stdout", text }),
      onStderr: (text) => context.onLog?.({ channel: "stderr", text })
    });
    return result;
  }
};
