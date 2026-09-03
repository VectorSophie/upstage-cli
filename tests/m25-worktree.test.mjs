import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRepo, createWorktree, worktreeDiff, removeWorktree, withWorktree } from "../src/core/worktree.mjs";

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "wt-repo-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.dev"]);
  g(["config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

test("isGitRepo distinguishes repos from plain dirs", async () => {
  const repo = await makeRepo();
  const plain = await mkdtemp(join(tmpdir(), "plain-"));
  try {
    assert.equal(isGitRepo(repo), true);
    assert.equal(isGitRepo(plain), false);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("create/diff/remove an isolated worktree", async () => {
  const repo = await makeRepo();
  try {
    const wt = createWorktree(repo);
    assert.equal(existsSync(wt.path), true);
    assert.equal(isGitRepo(wt.path), true);

    // An edit in the worktree must not affect the main checkout.
    await writeFile(join(wt.path, "a.txt"), "changed in worktree\n");
    const diff = worktreeDiff(wt.path);
    assert.match(diff, /changed in worktree/);

    removeWorktree(repo, wt.path);
    assert.equal(existsSync(wt.path), false);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("withWorktree runs fn isolated, returns diff, and always cleans up", async () => {
  const repo = await makeRepo();
  try {
    const { result, diff, worktree } = await withWorktree(repo, async (p) => {
      await writeFile(join(p, "new.txt"), "hello\n");
      return "done";
    });
    assert.equal(result, "done");
    assert.match(diff, /new\.txt/);
    assert.equal(existsSync(worktree.path), false); // cleaned up
    // The main repo is untouched.
    assert.equal(existsSync(join(repo, "new.txt")), false);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("withWorktree throws on a non-repo", async () => {
  const plain = await mkdtemp(join(tmpdir(), "plain-"));
  try {
    await assert.rejects(() => withWorktree(plain, async () => 1), /not a git repository/);
  } finally {
    await rm(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
