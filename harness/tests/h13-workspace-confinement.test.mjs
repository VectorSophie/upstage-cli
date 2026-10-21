// PR #9 review follow-up: trusted write root, nested path confinement,
// dependency-build trust gate, pristine baseline reset. Everything goes
// through buildAgentRegistry() — the registry the live Upstage adapter uses —
// and the real src/tools builtins. No Docker, no model API.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildAgentRegistry } from "../src/agent/adapters/upstage.mjs";
import { DOCKER_SAFE_TOOLS, PATH_ARGS } from "../src/agent/sandboxed-tools.mjs";
import { DockerSandbox, SandboxConfigError } from "../src/sandbox/docker.mjs";
import { validate } from "../src/task/schema.mjs";
import { PatchTracker } from "../src/tracking/patch-tracker.mjs";
import { createRegistry } from "../../src/tools/create-registry.mjs";

const TASK = { id: "h13", agent: { tools: { allow: [], deny: [] } } };

// Directory junctions need no privilege on Windows; file symlinks do.
const LINK_DIR_TYPE = process.platform === "win32" ? "junction" : "dir";
const CAN_FILE_SYMLINK = (() => {
  const d = mkdtempSync(join(tmpdir(), "h13-ln-"));
  try { symlinkSync(join(d, "a"), join(d, "b")); return true; } catch { return false; } finally { rmSync(d, { recursive: true, force: true }); }
})();

function fakeDockerExecutor() {
  const calls = [];
  return {
    type: "docker",
    timeoutMs: 5000,
    calls,
    async exec(binary, args) {
      calls.push([binary, ...args]);
      return { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, infraError: null };
    }
  };
}

let root, ws, outside, savedOverride;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "h13-"));
  ws = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(ws, "a.txt"), "one\n");
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  // The fix must not depend on the global escape hatch
  savedOverride = process.env.SECURITY_OVERRIDE;
  delete process.env.SECURITY_OVERRIDE;
});
afterEach(() => {
  if (savedOverride !== undefined) process.env.SECURITY_OVERRIDE = savedOverride;
  rmSync(root, { recursive: true, force: true });
});

for (const mode of ["native", "docker"]) {
  const build = () => buildAgentRegistry(TASK, { workdir: ws, executor: mode === "docker" ? fakeDockerExecutor() : undefined });

  describe(`agent registry write policy (${mode} task)`, () => {
    it("trusts the attempt workdir, not the harness process cwd", async () => {
      assert.notEqual(process.cwd(), ws);
      const { registry } = await build();
      const exec = (n, a) => registry.execute(n, a, { cwd: ws });

      assert.equal((await exec("write_file", { path: "a.txt", content: "two\n" })).ok, true);
      assert.equal((await exec("edit_file", { path: "a.txt", oldText: "two", newText: "three" })).ok, true);
      const r = await exec("apply_patch", { patch: { version: 1, path: "a.txt", newContent: "four\n" } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal((await exec("write_file", { path: "sub/new.txt", content: "x" })).ok, true);
      assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "four\n");
      assert.ok(existsSync(join(ws, "sub/new.txt")));
    });

    it("rejects writes outside the workspace, top-level and nested", async () => {
      const { registry } = await build();
      const exec = (n, a) => registry.execute(n, a, { cwd: ws });
      const attempts = [
        ["write_file", { path: "../outside/x.txt", content: "x" }],
        ["write_file", { path: join(outside, "x.txt"), content: "x" }],
        ["edit_file", { path: "../outside/secret.txt", oldText: "TOP", newText: "PWN" }],
        ["apply_patch", { patch: { version: 1, path: "../outside/secret.txt", newContent: "PWN" } }],
        ["apply_patch", { patch: { version: 1, path: join(outside, "secret.txt"), newContent: "PWN" } }],
        ["rename_file", { from: "a.txt", to: "../outside/a.txt" }],
        ["delete_file", { path: "../outside/secret.txt" }],
        ["read_file", { path: "../outside/secret.txt" }],
        ["write_file", { path: ["../outside/x.txt"], content: "x" }]
      ];
      for (const [name, args] of attempts) {
        const r = await exec(name, args);
        assert.equal(r.ok, false, `${name} ${JSON.stringify(args)} must be rejected`);
        assert.ok(!JSON.stringify(r).includes("TOP-SECRET"));
      }
      assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP-SECRET");
      assert.ok(!existsSync(join(outside, "x.txt")) && !existsSync(join(outside, "a.txt")));
      assert.ok(existsSync(join(ws, "a.txt")));
    });

    it("rejects writes through a directory symlink/junction that escapes", async () => {
      symlinkSync(outside, join(ws, "linkdir"), LINK_DIR_TYPE);
      const { registry } = await build();
      if (mode === "docker") {
        // docker tasks drop escaping links up front (removing the link, not its target)
        assert.ok(!existsSync(join(ws, "linkdir")), "escaping link removed");
      } else {
        for (const [name, args] of [
          ["write_file", { path: "linkdir/x.txt", content: "x" }],
          ["apply_patch", { patch: { version: 1, path: "linkdir/secret.txt", newContent: "PWN" } }],
          ["read_file", { path: "linkdir/secret.txt" }],
          ["list_files", { path: "linkdir" }]
        ]) {
          const r = await registry.execute(name, args, { cwd: ws });
          assert.equal(r.ok, false, `${name} through an escaping link must be rejected`);
        }
      }
      assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP-SECRET");
      assert.ok(!existsSync(join(outside, "x.txt")));
    });

    it("rejects writes through a dangling file symlink pointing outside", { skip: CAN_FILE_SYMLINK ? false : "host cannot create file symlinks (Windows without Developer Mode)" }, async () => {
      const link = join(ws, "dangling.txt");
      const isLink = () => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } };
      symlinkSync(join(outside, "planted.txt"), link);
      const { registry } = await build();
      const write = () => registry.execute("write_file", { path: "dangling.txt", content: "x" }, { cwd: ws });
      if (mode === "docker") {
        // setup drops escaping links (dangling counts as escaping), so the
        // same name is now an ordinary in-workspace file
        assert.ok(!isLink(), "escaping link removed at setup");
        assert.equal((await write()).ok, true);
        assert.ok(lstatSync(link).isFile());
        rmSync(link);
        // a link planted later (e.g. by a container command) hits the per-call guard
        symlinkSync(join(outside, "planted.txt"), link);
      }
      const r = await write();
      assert.equal(r.ok, false, "write through an escaping link must be rejected");
      assert.ok(isLink(), "rejected write leaves the link untouched");
      assert.ok(!existsSync(join(outside, "planted.txt")));
    });
  });
}

describe("Docker-safe tool path confinement", () => {
  it("PATH_ARGS covers every path-like argument in the Docker-safe tools' schemas", () => {
    const registry = createRegistry({});
    const pathy = /^(path|paths|file|files|dir|directory|from|to|src|dest|target|cwd|root)$/i;
    const findPathKeys = (schema, prefix = "") => {
      const found = [];
      for (const [k, v] of Object.entries(schema?.properties || {})) {
        if (pathy.test(k)) found.push(prefix + k);
        if (v?.type === "object") found.push(...findPathKeys(v, `${prefix}${k}.`));
        if (v?.type === "array" && v.items?.type === "object") found.push(...findPathKeys(v.items, `${prefix}${k}[].`));
      }
      return found;
    };
    for (const name of DOCKER_SAFE_TOOLS) {
      if (name === "run_shell" || name === "run_tests") continue; // routed into the container
      const tool = registry.tools.get(name);
      assert.ok(tool, `${name} exists`);
      const keys = findPathKeys(tool.inputSchema);
      if (keys.length > 0) assert.ok(PATH_ARGS[name], `${name} has path args ${keys.join(", ")} but no PATH_ARGS entry`);
    }
    // the nested one specifically
    assert.deepEqual(PATH_ARGS.apply_patch({ patch: { path: "p" } }), ["p"]);
  });

  it("a file-tool path check and a container command never interleave", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const order = [];
    const executor = {
      type: "docker",
      timeoutMs: 5000,
      async exec() {
        order.push("exec:start");
        await gate;
        order.push("exec:end");
        return { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, infraError: null };
      }
    };
    // acceptEdits (the default) denies run_shell outright; bypass so it reaches the executor
    const { registry } = await buildAgentRegistry({ ...TASK, agent: { ...TASK.agent, permissions: "bypassPermissions" } }, { workdir: ws, executor });
    const shell = registry.execute("run_shell", { command: "ln -s /etc/passwd a.txt" }, { cwd: ws });
    await new Promise((r) => setTimeout(r, 20));
    const read = registry.execute("read_file", { path: "a.txt" }, { cwd: ws }).then((r) => { order.push("read"); return r; });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ["exec:start"], `read_file must wait for the in-flight container command: ${JSON.stringify(order)}`);
    release();
    await Promise.all([shell, read]);
    assert.deepEqual(order, ["exec:start", "exec:end", "read"]);
  });
});

describe("Docker dependency preparation trust gate", () => {
  const saved = process.env.HARNESS_ALLOW_DEPENDENCY_BUILD;
  afterEach(() => {
    if (saved === undefined) delete process.env.HARNESS_ALLOW_DEPENDENCY_BUILD;
    else process.env.HARNESS_ALLOW_DEPENDENCY_BUILD = saved;
  });

  it("by default installs nothing: the image is used as-is even when requirements.txt exists", async () => {
    writeFileSync(join(ws, "requirements.txt"), "evil-package==1.0\n");
    const sb = new DockerSandbox({ sandbox: { type: "docker", image: "python:3.12-slim" } });
    await sb.setup(ws);
    assert.equal(sb._envImage, "python:3.12-slim");
    const d = sb.describe();
    assert.equal(d.dependencies.mode, "image");
    assert.equal(d.dependencies.method, "none");
    assert.equal(d.network.effective, "none");
  });

  it("a task asking for a dependency build fails closed without operator opt-in", async () => {
    delete process.env.HARNESS_ALLOW_DEPENDENCY_BUILD;
    writeFileSync(join(ws, "requirements.txt"), "evil-package==1.0\n");
    // network:"none" in the task does not make an install safe either
    const sb = new DockerSandbox({ sandbox: { type: "docker", image: "python:3.12-slim", network: "none", dependencies: "build" } });
    await assert.rejects(() => sb.setup(ws), (err) => err instanceof SandboxConfigError && /HARNESS_ALLOW_DEPENDENCY_BUILD/.test(err.message));
    assert.equal(sb._envImage, null, "no image may be built");
  });

  it("only the exact opt-in value counts", async () => {
    process.env.HARNESS_ALLOW_DEPENDENCY_BUILD = "true";
    const sb = new DockerSandbox({ sandbox: { type: "docker", image: "python:3.12-slim", dependencies: "build" } });
    await assert.rejects(() => sb.setup(ws), SandboxConfigError);
  });

  it("rejects unknown dependency modes in the sandbox and the schema", () => {
    assert.throws(() => new DockerSandbox({ sandbox: { type: "docker", dependencies: "install" } }), SandboxConfigError);
    const { valid, errors } = validate({ id: "x", repo: ".", prompt: "p", sandbox: { type: "docker", dependencies: "pip" } });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => /sandbox.dependencies/.test(e)));
  });
});

describe("PatchTracker.reset restores the pristine start state", () => {
  it("removes baseline artifacts (ignored too) and restores pre-existing ignored files", async () => {
    writeFileSync(join(ws, ".gitignore"), "build/\n*.log\n");
    mkdirSync(join(ws, "build"));
    writeFileSync(join(ws, "build", "fixture-output.bin"), "original");
    mkdirSync(join(ws, ".pytest_cache"));
    writeFileSync(join(ws, ".pytest_cache", "seed"), "seed");
    writeFileSync(join(ws, "keep.log"), "log");

    const tracker = new PatchTracker(ws);
    const initial = await tracker.captureInitial();

    // what a baseline check run might leave behind
    mkdirSync(join(ws, "__pycache__"));
    writeFileSync(join(ws, "__pycache__", "a.cpython-312.pyc"), "bytecode");
    writeFileSync(join(ws, "build", "fixture-output.bin"), "rebuilt");
    writeFileSync(join(ws, "build", "new.o"), "obj");
    writeFileSync(join(ws, ".pytest_cache", "lastfailed"), "{}");
    writeFileSync(join(ws, "run.log"), "noise");
    writeFileSync(join(ws, "a.txt"), "changed by baseline\n");
    writeFileSync(join(ws, "untracked.txt"), "new");
    mkdirSync(join(ws, "nested"));
    writeFileSync(join(ws, "nested", "x"), "x");

    await tracker.reset(initial);

    assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(ws, "build", "fixture-output.bin"), "utf8"), "original");
    assert.equal(readFileSync(join(ws, ".pytest_cache", "seed"), "utf8"), "seed");
    assert.equal(readFileSync(join(ws, "keep.log"), "utf8"), "log");
    for (const gone of ["__pycache__", "build/new.o", ".pytest_cache/lastfailed", "run.log", "untracked.txt", "nested"]) {
      assert.ok(!existsSync(join(ws, gone)), `${gone} must be removed`);
    }
    // nothing outside the workspace touched
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP-SECRET");
    // and the agent starts from an empty diff
    const diff = await tracker.captureDiff(initial);
    assert.equal(diff.unifiedDiff, "");
    assert.deepEqual(diff.filesChanged, []);
  });
});
