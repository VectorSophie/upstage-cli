// Minimal MCP client to smoke-test src/mcp/upstage-server.mjs over stdio.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const serverPath = process.argv[2];
const workdir = process.argv[3] || process.cwd();
const task = process.argv[4] || "Create hello.mjs exporting a function greet(name) returning `Hello, ${name}!`.";

const child = spawn(process.execPath, [serverPath], {
  cwd: workdir,
  env: { ...process.env, UPSTAGE_MCP_CWD: workdir },
  stdio: ["pipe", "pipe", "inherit"]
});

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

function call(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const t0 = Date.now();
const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
console.log("INIT:", JSON.stringify(init.result));

const tools = await call("tools/list", {});
console.log("TOOLS:", tools.result.tools.map((t) => t.name).join(", "));

console.log("CALLING upstage_delegate ...");
const callRes = await call("tools/call", { name: "upstage_delegate", arguments: { task, cwd: workdir } });
console.log(`(elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log("RESULT isError:", callRes.result?.isError);
console.log("---- content ----");
console.log(callRes.result?.content?.[0]?.text || JSON.stringify(callRes));
child.kill();
process.exit(0);
