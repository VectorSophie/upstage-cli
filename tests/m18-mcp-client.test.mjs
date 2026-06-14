import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { StdioMcpClient } from "../src/tools/mcp/stdio-client.mjs";
import { loadMcpServerConfigs, connectConfiguredServers } from "../src/tools/mcp/config.mjs";
import { createRegistryWithExtensions } from "../src/tools/create-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = join(__dirname, "fixtures", "mock-mcp-server.mjs");

function newClient() {
  return new StdioMcpClient({ command: process.execPath, args: [MOCK], name: "mock", timeoutMs: 8000 });
}

test("client connects and negotiates serverInfo", async () => {
  const client = newClient();
  const init = await client.connect();
  assert.equal(init.protocolVersion, "2024-11-05");
  assert.equal(client.serverInfo.name, "mock-mcp");
  await client.close();
});

test("listTools returns the server's tools", async () => {
  const client = newClient();
  await client.connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["add", "echo"]);
  await client.close();
});

test("callTool executes a tool and returns MCP content", async () => {
  const client = newClient();
  await client.connect();
  const res = await client.callTool("add", { a: 2, b: 40 });
  assert.equal(res.content[0].text, "42");
  await client.close();
});

test("callTool rejects on a server error", async () => {
  const client = newClient();
  await client.connect();
  await assert.rejects(() => client.callTool("nope", {}), /Unknown tool/);
  await client.close();
});

test("a failing server is isolated, not fatal", async () => {
  const { servers } = await connectConfiguredServers([
    { name: "broken", command: process.execPath, args: ["-e", "process.exit(1)"], env: {} }
  ], {});
  assert.equal(servers.length, 0);
});

test(".mcp.json config connects and registers tools into the registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-cfg-"));
  try {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { calc: { command: process.execPath, args: [MOCK] } } })
    );
    const configs = await loadMcpServerConfigs(dir, {});
    assert.equal(configs.length, 1);
    assert.equal(configs[0].name, "calc");

    const { servers, closeAll } = await connectConfiguredServers(configs, { cwd: dir });
    assert.equal(servers.length, 1);

    const registry = await createRegistryWithExtensions({ cwd: dir, mcpServers: servers });
    const tool = registry.list().find((t) => t.name === "calc__add");
    assert.ok(tool, "registry should expose calc__add");

    const result = await registry.execute("calc__add", { a: 5, b: 6 }, { cwd: dir });
    const text = JSON.stringify(result);
    assert.match(text, /11/);

    await closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("remote (url) entries are skipped, not connected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-cfg-"));
  try {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp" }, local: { command: process.execPath, args: [MOCK] } } })
    );
    const configs = await loadMcpServerConfigs(dir, {});
    assert.deepEqual(configs.map((c) => c.name), ["local"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
