export function createDiscoveredTool(spec, invoke) {
  if (!spec || typeof spec.name !== "string") {
    throw new Error("invalid discovered tool spec");
  }
  if (typeof invoke !== "function") {
    throw new Error("invoke must be a function");
  }

  return {
    name: `discovered__${spec.name}`,
    source: "discovered",
    risk: spec.risk || "medium",
    actionClass: spec.actionClass || "exec",
    description: spec.description || `Discovered tool ${spec.name}`,
    inputSchema:
      spec.inputSchema || {
        type: "object",
        properties: {},
        additionalProperties: true
      },
    async execute(args, context) {
      return invoke(spec.name, args, context);
    }
  };
}
