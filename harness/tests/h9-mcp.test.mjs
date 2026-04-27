import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";

// We test the MCP server by spawning it as a child process and communicating
// over stdio with newline-delimited JSON-RPC 2.0 messages.

const MCP_SERVER = new URL("../src/mcp/server.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

function sendAndReceive(workdir, messages) {
  // Build a small driver script that sends the messages and collects responses
  const driver = `
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const serverPath = ${JSON.stringify(MCP_SERVER)};
const messages = ${JSON.stringify(messages)};
const workdir = ${JSON.stringify(workdir)};

// Use spawnSync with stdin piped
const input = messages.map((m) => JSON.stringify(m)).join("\\n") + "\\n";

const result = spawnSync(process.execPath, [serverPath], {
  input,
  encoding: "utf8",
  env: { ...process.env },
  cwd: workdir,
  timeout: 10000
});

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
`;
  const driverPath = join(workdir, "_driver.mjs");
  writeFileSync(driverPath, driver, "utf8");

  const out = spawnSync(process.execPath, [driverPath], {
    encoding: "utf8",
    cwd: workdir,
    timeout: 15000
  });

  const lines = (out.stdout || "").split("\n").filter((l) => l.trim());
  return lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

describe("MCP stdio server", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "h9-"));
    writeFileSync(join(tmpDir, "hello.txt"), "hello world\n", "utf8");
    mkdirSync(join(tmpDir, "subdir"), { recursive: true });
    writeFileSync(join(tmpDir, "subdir", "nested.txt"), "nested\n", "utf8");
    // init git so git/diff and git/status work
    try {
      execSync("git init && git config user.email t@t.com && git config user.name T && git add -A && git commit -m init", {
        cwd: tmpDir, stdio: "pipe"
      });
    } catch { /* ok if git unavailable */ }
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("server sends capabilities on startup", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    ]);
    // First message should be server/capabilities notification (no id)
    const cap = responses.find((r) => r.method === "server/capabilities");
    assert.ok(cap, "server/capabilities notification expected");
    assert.ok(Array.isArray(cap.params?.tools), "tools array expected");
    assert.ok(cap.params.tools.length >= 8, "at least 8 tools expected");
  });

  it("initialize returns protocolVersion", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    ]);
    const init = responses.find((r) => r.id === 1);
    assert.ok(init);
    assert.equal(init.result?.protocolVersion, "2024-11-05");
  });

  it("tools/list returns all 8 tools", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    ]);
    const res = responses.find((r) => r.id === 2);
    assert.ok(res);
    assert.ok(Array.isArray(res.result?.tools));
    const names = res.result.tools.map((t) => t.name);
    assert.ok(names.includes("filesystem/read"), "filesystem/read");
    assert.ok(names.includes("filesystem/write"), "filesystem/write");
    assert.ok(names.includes("filesystem/list"), "filesystem/list");
    assert.ok(names.includes("shell/run"), "shell/run");
    assert.ok(names.includes("git/diff"), "git/diff");
    assert.ok(names.includes("git/status"), "git/status");
    assert.ok(names.includes("test/run"), "test/run");
    assert.ok(names.includes("static_analysis/run"), "static_analysis/run");
  });

  it("filesystem/read returns file content", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "filesystem/read", arguments: { path: "hello.txt" } } }
    ]);
    const res = responses.find((r) => r.id === 3);
    assert.ok(res);
    const content = JSON.parse(res.result.content[0].text);
    assert.ok(content.content.includes("hello world"));
  });

  it("filesystem/write creates a file", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "filesystem/write", arguments: { path: "new-file.txt", content: "created\n" } } }
    ]);
    const res = responses.find((r) => r.id === 4);
    assert.ok(res);
    const result = JSON.parse(res.result.content[0].text);
    assert.equal(result.ok, true);
    const written = readFileSync(join(tmpDir, "new-file.txt"), "utf8");
    assert.ok(written.includes("created"));
  });

  it("filesystem/list returns directory entries", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "filesystem/list", arguments: { path: "." } } }
    ]);
    const res = responses.find((r) => r.id === 5);
    assert.ok(res);
    const result = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(result.files));
    const names = result.files.map((f) => f.name);
    assert.ok(names.includes("hello.txt"));
  });

  it("shell/run executes a command and returns stdout", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "shell/run", arguments: { command: "echo harness-test" } } }
    ]);
    const res = responses.find((r) => r.id === 6);
    assert.ok(res);
    const result = JSON.parse(res.result.content[0].text);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.includes("harness-test"));
  });

  it("unknown tool returns JSON-RPC error", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "does/not/exist", arguments: {} } }
    ]);
    const res = responses.find((r) => r.id === 7);
    assert.ok(res);
    assert.ok(res.error, "expected error response");
    assert.equal(res.error.code, -32601);
  });

  it("unknown method returns JSON-RPC error", () => {
    const responses = sendAndReceive(tmpDir, [
      { jsonrpc: "2.0", id: 8, method: "no/such/method", params: {} }
    ]);
    const res = responses.find((r) => r.id === 8);
    assert.ok(res);
    assert.ok(res.error);
    assert.equal(res.error.code, -32601);
  });
});
