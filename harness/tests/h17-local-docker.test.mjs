// REAL Docker-isolated integration test for LocalModelAgent. Only the model HTTP
// endpoint is mocked (that call is host-side, by the adapter); the agent's shell
// command and the evaluation checks run INSIDE the container via the real
// DockerSandbox. When Docker is unavailable every test is SKIPPED (not passed).
// Hermetic: uses the already-present alpine image with busybox (sh/grep/test) —
// no network pull.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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
