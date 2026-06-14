// Minimal standards-compliant MCP stdio server used by the StdioMcpClient tests.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout. Exposes two tools: add, echo.
import { createInterface } from "node:readline";

const TOOLS = {
  add: {
    description: "Add two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    run: ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
  },
  echo: {
    description: "Echo a message",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    run: ({ msg }) => ({ content: [{ type: "text", text: msg }] })
  }
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try { req = JSON.parse(t); } catch { return; }
  const { id, method, params = {} } = req;

  // Notifications carry no id — never reply.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "0.0.1" } } });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: Object.entries(TOOLS).map(([name, t2]) => ({ name, description: t2.description, inputSchema: t2.inputSchema })) } });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOLS[params.name];
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: tool.run(params.arguments || {}) });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
});
