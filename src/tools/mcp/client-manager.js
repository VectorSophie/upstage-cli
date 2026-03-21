export class McpClientManager {
  constructor() {
    this.servers = new Map();
  }

  registerServer(serverName, client) {
    if (typeof serverName !== "string" || serverName.length === 0) {
      throw new Error("serverName is required");
    }
    if (!client || typeof client.listTools !== "function" || typeof client.callTool !== "function") {
      throw new Error("client must implement listTools() and callTool()");
    }
    this.servers.set(serverName, client);
  }

  getServer(serverName) {
    return this.servers.get(serverName);
  }

  async listTools(serverName) {
    const server = this.getServer(serverName);
    if (!server) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    const tools = await server.listTools();
    return Array.isArray(tools) ? tools : [];
  }

  async callTool(serverName, toolName, args, context = {}) {
    const server = this.getServer(serverName);
    if (!server) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    return server.callTool(toolName, args, context);
  }

  listServerNames() {
    return Array.from(this.servers.keys());
  }
}
