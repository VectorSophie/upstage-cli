import { runSandboxedCommand } from "../../sandbox/exec.mjs";

function normalizeSpec(spec) {
  if (!spec || typeof spec !== "object" || typeof spec.name !== "string") {
    return null;
  }

  return {
    name: spec.name,
    description: typeof spec.description === "string" ? spec.description : "",
    risk: typeof spec.risk === "string" ? spec.risk : "medium",
    actionClass: typeof spec.actionClass === "string" ? spec.actionClass : "exec",
    inputSchema:
      spec.inputSchema && typeof spec.inputSchema === "object"
        ? spec.inputSchema
        : {
            type: "object",
            properties: {},
            additionalProperties: true
          }
  };
}

export async function discoverToolSpecsFromCommand({ command, cwd, onLog }) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }

  const result = await runSandboxedCommand(command, {
    cwd,
    timeoutMs: 120000,
    outputLimit: 120000,
    networkBlocked: false,
    onStdout: (text) => onLog?.({ stage: "discover", channel: "stdout", text }),
    onStderr: (text) => onLog?.({ stage: "discover", channel: "stderr", text })
  });

  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "tool discovery command failed");
  }

  const payload = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(payload)) {
    throw new Error("tool discovery output must be a JSON array");
  }

  return payload.map(normalizeSpec).filter(Boolean);
}
