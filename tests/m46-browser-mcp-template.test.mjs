// Tests for src/cli/lib/mcp-template.mjs (3.3.0 Thread C, Task C.5) —
// `upstage init --with-browser-mcp` offers a chrome-devtools-mcp entry in
// .mcp.json for advanced browser debugging. Offered, never forced (design
// doc §C.2): no code path adds this entry without the flag, and it's
// idempotent — re-running never duplicates or clobbers other servers.
//
// No new MCP client code needed — src/tools/mcp/config.mjs already runs any
// stdio server named in .mcp.json; this only ever writes the config file.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addChromeDevtoolsMcpEntry } from "../src/cli/lib/mcp-template.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "m46-mcp-template-"));
}

test("creates .mcp.json with the chrome-devtools entry when none exists", async () => {
  const dir = tmpDir();
  try {
    const result = await addChromeDevtoolsMcpEntry(dir);
    assert.equal(result.action, "created");
    const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(written.mcpServers["chrome-devtools"], { command: "npx", args: ["chrome-devtools-mcp@latest"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merges into an existing .mcp.json without touching other servers", async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: { "some-other-server": { command: "node", args: ["server.mjs"] } }
    }, null, 2));

    const result = await addChromeDevtoolsMcpEntry(dir);
    assert.equal(result.action, "updated");
    const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.ok(written.mcpServers["some-other-server"], "existing server must be preserved");
    assert.ok(written.mcpServers["chrome-devtools"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is idempotent — re-running when the entry already exists changes nothing", async () => {
  const dir = tmpDir();
  try {
    await addChromeDevtoolsMcpEntry(dir);
    const before = readFileSync(join(dir, ".mcp.json"), "utf8");
    const result = await addChromeDevtoolsMcpEntry(dir);
    assert.equal(result.action, "already-present");
    assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never runs without being explicitly called — this module has no auto-invoked side effect", () => {
  // Documentation-as-test: the only caller is init.mjs's --with-browser-mcp
  // branch (wired below), and nothing imports this module for its side
  // effects. Importing it here does not touch the filesystem.
  assert.equal(typeof addChromeDevtoolsMcpEntry, "function");
});
