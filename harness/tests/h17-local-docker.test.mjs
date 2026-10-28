// REAL Docker-isolated integration test for LocalModelAgent. Only the model HTTP
// endpoint is mocked (that call is host-side, by the adapter); the agent's shell
// command and the evaluation checks run INSIDE the container via the real
// DockerSandbox. When Docker is unavailable every test is SKIPPED (not passed).
// Hermetic: uses the already-present alpine image with busybox (sh/grep/test) —
// no network pull.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerSandbox } from "../src/sandbox/docker.mjs";
import { loadTask } from "../src/task/loader.mjs";
import { TaskRunner } from "../src/task/runner.mjs";
import { defaultRegistry } from "../src/agent/registry.mjs";

const DOCKER = process.env.SKIP_DOCKER !== "1" && DockerSandbox.isAvailable();
const skip = DOCKER ? false : "Docker not available — NOT EXECUTED";
const IMAGE = process.env.HARNESS_TEST_IMAGE || "alpine:latest";

const realFetch = globalThis.fetch;
let callCount = 0;
function stubModel(handler) {
  callCount = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/chat/completions")) { callCount += 1; return handler(callCount, opts); }
    return realFetch(url, opts);
  };
}
function json(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } }); }
function toolCall(n, name, args) {
  return json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
}
function stop(text) { return json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }); }

let root, savedCritic;
before(() => { savedCritic = process.env.UPSTAGE_CRITIC_DISABLED; process.env.UPSTAGE_CRITIC_DISABLED = "true"; });
after(() => { if (savedCritic === undefined) delete process.env.UPSTAGE_CRITIC_DISABLED; else process.env.UPSTAGE_CRITIC_DISABLED = savedCritic; });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "h17-"));
  const fx = join(root, "fixture");
  mkdirSync(fx);
  writeFileSync(join(fx, "bug.txt"), "BROKEN\n");
  // Busybox-only checks (no node/python): grep for the fix, confirm the file.
  writeFileSync(join(root, "task.yaml"), [
    "id: local-docker-edit",
    "repo: ./fixture",
    "prompt: 'Replace BROKEN with FIXED in bug.txt and verify.'",
    "sandbox:",
    `  type: docker`,
    `  image: ${IMAGE}`,
    "  network: none",
    "  timeout: 60",
    "agent:",
    "  permissions: bypassPermissions",
    "  maxTurns: 6",
    "  tools:",
    "    allow: [write_file, run_shell]",
    "checks:",
    "  fail_to_pass:",
    "    - id: has-fixed",
    "      command: grep -q FIXED bug.txt",
    "      timeout: 20",
    "  pass_to_pass:",
    "    - id: file-exists",
    "      command: test -f bug.txt",
    "      timeout: 20"
  ].join("\n"));
});
afterEach(() => { globalThis.fetch = realFetch; try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("LocalModelAgent — real Docker isolation", { skip }, () => {
  it("edits the workspace and runs an agent shell command in the container → PASS, isolated", async () => {
    // turn 1: write the fix (host-confined write_file); turn 2: verify via a shell
    // command that executes INSIDE the container; turn 3: stop.
    stubModel((n) => {
      if (n === 1) return toolCall(n, "write_file", { path: "bug.txt", content: "FIXED\n" });
      if (n === 2) return toolCall(n, "run_shell", { command: "grep -c FIXED bug.txt" });
      return stop("Done.");
    });

    const task = loadTask(join(root, "task.yaml"));
    const adapter = defaultRegistry.resolve("kanana");
    const result = await new TaskRunner({ runsDir: null }).run(task, adapter);

    assert.equal(result.status, "pass", `expected pass, got ${result.status} (${result.outcome?.detail})`);
    // Isolation really was Docker, not native.
    assert.equal(result.sandbox.type, "docker");
    assert.equal(result.sandbox.trusted, false);
    assert.equal(result.sandbox.network.enforced, true);
    // The edit was captured in the patch.
    assert.ok(result.patch.filesChanged.includes("bug.txt"));
    // An agent shell command was routed through the sandbox and produced a result.
    const toolResults = result.trace.toolCalls.filter((t) => t.tool === "run_shell");
    assert.ok(toolResults.length >= 1, "agent run_shell executed via the sandbox");
    // Provenance still records the model correctly.
    assert.equal(result.provenance.model.provider, "local-vllm");
    assert.equal(result.provenance.model.official, true);
  });

  it("host-only tool exclusion / isolation flags are present on the run record", async () => {
    stubModel((n) => (n === 1 ? toolCall(n, "write_file", { path: "bug.txt", content: "FIXED\n" }) : stop("done")));
    const task = loadTask(join(root, "task.yaml"));
    const result = await new TaskRunner({ runsDir: null }).run(task, defaultRegistry.resolve("ax"));
    assert.equal(result.status, "pass");
    assert.equal(result.sandbox.trusted, false);
    assert.equal(result.sandbox.network.enforced, true);
    // tools provenance records what the policy/isolation removed (fail-closed path ran)
    assert.ok(result.provenance.tools, "tools provenance present");
    assert.ok(Array.isArray(result.provenance.tools.advertised));
  });
});

// T3 tool-result-continuation evaluator under REAL Docker isolation: the
// challenge runs INSIDE the container (node:22-alpine), and the trusted
// trace-aware evaluator (host-side) verifies it from the bind-mounted workspace
// + the harness trace — proving the mechanism is isolation-agnostic.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as presolve } from "node:path";

const NODE_IMG = process.env.HARNESS_NODE_IMAGE || "node:22-alpine";
const hasNodeImg = DOCKER && (() => { try { return spawnSync("docker", ["image", "inspect", NODE_IMG], { stdio: "ignore" }).status === 0; } catch { return false; } })();
const skipT3 = DOCKER ? (hasNodeImg ? false : `${NODE_IMG} image not present — NOT EXECUTED`) : skip;

const HERE18 = dirname(fileURLToPath(import.meta.url));
const V2_FIXTURE = presolve(HERE18, "../fixtures/tool-continuation-v2");
const V2_GEN_SHA = createHash("sha256").update(readFileSync(join(V2_FIXTURE, "challenge.mjs"))).digest("hex");

function tokenFromBody(opts) {
  const body = typeof opts?.body === "string" ? opts.body : "";
  const m = body.match(/T3-[0-9a-f]{32}/g);
  return m ? m[m.length - 1] : null;
}

describe("T3 trace evaluator — real Docker isolation", { skip: skipT3 }, () => {
  let t3root;
  beforeEach(() => {
    t3root = mkdtempSync(join(tmpdir(), "h17t3-"));
    cpSync(V2_FIXTURE, join(t3root, "fixture"), { recursive: true });
    writeFileSync(join(t3root, "task.yaml"), [
      "id: t3-docker",
      "version: 2",
      "repo: ./fixture",
      "prompt: 'Run node challenge.mjs and write its token to out.txt.'",
      `sandbox: { type: docker, image: ${NODE_IMG}, network: none, timeout: 60 }`,
      "agent: { permissions: bypassPermissions, maxTurns: 6, tools: { allow: [run_shell, write_file] } }",
      "checks:",
      "  custom:",
      "    - id: t3",
      "      evaluator: tool-result-continuation",
      "      required: true",
      "      config:",
      "        command: 'challenge.mjs'",
      "        outputFile: 'out.txt'",
      "        tokenPattern: 'T3-[0-9a-f]{32}'",
      "        generatorFile: 'challenge.mjs'",
      `        generatorSha256: '${V2_GEN_SHA}'`,
      "  pass_to_pass:",
      "    - { id: gen-exists, command: 'test -f challenge.mjs', timeout: 20, weight: 0.0 }"
    ].join("\n"));
  });
  afterEach(() => { globalThis.fetch = realFetch; try { rmSync(t3root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it("challenge executes in-container; agent writes the emitted token → PASS, isolated", async () => {
    stubModel((n, opts) => {
      if (n === 1) return toolCall(n, "run_shell", { command: "node challenge.mjs" });
      if (n === 2) { const tok = tokenFromBody(opts); assert.ok(tok, "stub must see the token the container emitted"); return toolCall(n, "write_file", { path: "out.txt", content: tok }); }
      return stop("Done.");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(join(t3root, "task.yaml")), defaultRegistry.resolve("kanana"));
    assert.equal(result.status, "pass", `expected pass, got ${result.status} (${result.outcome?.detail})`);
    assert.equal(result.sandbox.type, "docker");
    assert.equal(result.sandbox.trusted, false);
    assert.equal(result.sandbox.network.enforced, true);
    assert.ok(result.patch.filesChanged.includes("out.txt"));
    assert.ok(!result.patch.filesChanged.includes("challenge.mjs"));
  });

  it("writing a token the container never emitted → FAIL (result not consumed), still isolated", async () => {
    stubModel((n) => {
      if (n === 1) return toolCall(n, "run_shell", { command: "node challenge.mjs" });
      if (n === 2) return toolCall(n, "write_file", { path: "out.txt", content: `T3-${"0".repeat(32)}` });
      return stop("done");
    });
    const result = await new TaskRunner({ runsDir: null }).run(loadTask(join(t3root, "task.yaml")), defaultRegistry.resolve("ax"));
    assert.equal(result.status, "fail", `expected fail, got ${result.status}`);
    assert.equal(result.sandbox.type, "docker");
  });
});
