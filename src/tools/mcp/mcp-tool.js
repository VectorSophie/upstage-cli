export function createMcpTool({ serverName, toolName, description, inputSchema, risk, actionClass, manager }) {
  if (!manager) {
    throw new Error("manager is required");
  }

  return {
    name: `${serverName}__${toolName}`,
    source: "mcp",
    risk: risk || "medium",
    actionClass: actionClass || "network",
    description: description || `${toolName} (MCP:${serverName})`,
    inputSchema: inputSchema || {
      type: "object",
      properties: {},
      additionalProperties: true
    },
    async execute(args, context) {
      return manager.callTool(serverName, toolName, args, context);
    }
  };
}
