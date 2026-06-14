import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "../src/plugins/loader.mjs";

async function makePlugin(cwd) {
  const root = join(cwd, ".claude", "plugins", "demo");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skills", "greet"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });

  await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "1.2.3" }));
  await writeFile(join(root, "commands", "deploy.md"), "---\ndescription: Deploy the app\n---\nRun the deploy steps.");
  await writeFile(join(root, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews code\ntools: [read_file, grep]\n---\nYou review code.");
  await writeFile(join(root, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: say hi\n---\nSay hello to $ARGUMENTS.");
  await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({ PreToolUse: [{ type: "command", command: "echo", args: ["hi"] }] }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "server-fs"] } } }));
}

test("loads plugin manifest and all component types", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "plug-"));
  try {
    await makePlugin(cwd);
    const loader = await new PluginLoader().load(cwd);

    assert.deepEqual(loader.list(), [{ name: "demo", version: "1.2.3" }]);

    assert.equal(loader.commands.length, 1);
    assert.equal(loader.commands[0].name, "/deploy");
    assert.match(loader.commands[0].description, /Deploy the app/);

    assert.equal(loader.agents.length, 1);
    assert.equal(loader.agents[0].name, "reviewer");
    assert.deepEqual(loader.agents[0].tools, ["read_file", "grep"]);

    assert.equal(loader.skills.length, 1);
    assert.equal(loader.skills[0].name, "greet");

    assert.ok(Array.isArray(loader.hooks.PreToolUse));
    assert.equal(loader.hooks.PreToolUse.length, 1);

    assert.ok(loader.mcpServers.fs);
    assert.equal(loader.mcpServers.fs.command, "npx");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("directories without a plugin.json are ignored", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "plug-"));
  try {
    await mkdir(join(cwd, ".claude", "plugins", "notaplugin"), { recursive: true });
    const loader = await new PluginLoader().load(cwd);
    assert.equal(loader.plugins.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
