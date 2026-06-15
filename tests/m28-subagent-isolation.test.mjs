import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src/tools/create-registry.mjs";
import { createSession } from "../src/runtime/session.mjs";
import { listWorktrees } from "../src/core/worktree.mjs";

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "sub-iso-"));
  const g = (a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.dev"]);
  g(["config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

test("isolate:true runs the subagent in a worktree and cleans it up", async () => {
  const repo = await makeRepo();
  const registry = createRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  try {
    const result = await registry.execute(
      "run_subagent",
      { task: "/tools", role: "explorer", isolate: true, maxSteps: 1 },
      { cwd: repo, adapter: null, runtimeCache: {}, session: createSession(repo) }
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.isolated, true);
    assert.match(result.data.branch, /^upstage\/wt-/);
    // The worktree must be torn down — only the main checkout remains.
    assert.equal(listWorktrees(repo).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("isolate:true on a non-git directory falls back to a normal run", async () => {
  const plain = await mkdtemp(join(tmpdir(), "sub-plain-"));
  const registry = createRegistry({ allowHighRiskTools: true, requireConfirmationForHighRisk: false });
  try {
    const result = await registry.execute(
      "run_subagent",
      { task: "/tools", role: "explorer", isolate: true, maxSteps: 1 },
      { cwd: plain, adapter: null, runtimeCache: {}, session: createSession(plain) }
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.isolated, false);
  } finally {
    await rm(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
