export const runVerificationTool = {
  name: "run_verification",
  description: "Run linter, typecheck, and tests in order",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      stopOnFailure: { type: "boolean" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    const stopOnFailure = args.stopOnFailure !== false;
    const stages = ["run_linter", "run_typecheck", "run_tests"];
    const results = [];

    for (const stage of stages) {
      const result = await context.executeTool(stage, {}, { onLog: context.onLog });
      const entry = {
        stage,
        ok: result.ok,
        data: result.data,
        error: result.error
      };
      results.push(entry);
      context.onLog?.({ stage: "verify", channel: "summary", text: `${stage}: ${result.ok ? "ok" : "failed"}` });
      if (stopOnFailure && !result.ok) {
        break;
      }
    }

    return {
      ok: results.every((item) => item.ok),
      results
    };
  }
};
