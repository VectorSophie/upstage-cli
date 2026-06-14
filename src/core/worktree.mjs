import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Git-worktree isolation — run a (sub)agent on an isolated checkout so parallel
 * or risky edits never touch the user's working tree. The worktree lives under
 * the OS temp dir (not inside the repo, to avoid polluting it) on its own
 * branch; collect its diff, then remove it.
 */

function git(cwd, args, opts = {}) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

export function isGitRepo(dir) {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Create an isolated worktree on a new branch off HEAD. Returns { id, path, branch }. */
export function createWorktree(repoRoot, { branch } = {}) {
  const id = randomBytes(3).toString("hex");
  const br = branch || `upstage/wt-${id}`;
  const path = join(tmpdir(), "upstage-worktrees", id);
  git(repoRoot, ["worktree", "add", "-b", br, path, "HEAD"]);
  return { id, path, branch: br };
}

/** Stage everything in the worktree and return its unified diff. */
export function worktreeDiff(worktreePath) {
  try {
    git(worktreePath, ["add", "-A"]);
    return git(worktreePath, ["diff", "--cached"]);
  } catch {
    return "";
  }
}

/** Remove a worktree and prune the bookkeeping. Best-effort. */
export function removeWorktree(repoRoot, worktreePath) {
  try { git(repoRoot, ["worktree", "remove", "--force", worktreePath]); } catch { /* ignore */ }
  try { git(repoRoot, ["worktree", "prune"]); } catch { /* ignore */ }
}

export function listWorktrees(repoRoot) {
  try {
    return git(repoRoot, ["worktree", "list", "--porcelain"])
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  } catch {
    return [];
  }
}

/**
 * Run `fn(worktreePath)` inside a fresh isolated worktree, returning
 * { result, diff }. The worktree is always removed afterward. Throws if the
 * directory is not a git repo.
 */
export async function withWorktree(repoRoot, fn, { branch } = {}) {
  if (!isGitRepo(repoRoot)) throw new Error("not a git repository");
  const wt = createWorktree(repoRoot, { branch });
  try {
    const result = await fn(wt.path);
    return { result, diff: worktreeDiff(wt.path), worktree: wt };
  } finally {
    removeWorktree(repoRoot, wt.path);
  }
}
