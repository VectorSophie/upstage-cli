import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Interpreter/test caches created by baseline or check runs must never show up
// in the agent's patch.
const EXCLUDES = ["__pycache__/", "*.pyc", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".harness-*"];
const IDENT = ["-c", "user.email=harness@upstage", "-c", "user.name=Harness", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];

export class PatchTracker {
  constructor(workdir) {
    this.workdir = workdir;
  }

  _git(args, { allowFail = false } = {}) {
    try {
      return execFileSync("git", [...IDENT, ...args], { cwd: this.workdir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).toString("utf8").trim();
    } catch (err) {
      if (allowFail) return err.stdout ? err.stdout.toString("utf8").trim() : "";
      throw new Error(`git ${args.join(" ")} failed: ${err.stderr?.toString("utf8") || err.message}`, { cause: err });
    }
  }

  /** True when workdir is itself the root of a git repo (not nested in an outer one). */
  _isOwnRepo() {
    const top = this._git(["rev-parse", "--show-toplevel"], { allowFail: true });
    if (!top) return false;
    try {
      return realpathSync(top) === realpathSync(this.workdir);
    } catch {
      return false;
    }
  }

  /**
   * Prepare the workspace and return the commit every diff is taken against.
   * `commit` (optional) pins an existing repo to a specific revision first.
   * Whatever the starting state (clean, dirty, or not a repo), the returned
   * commit is a snapshot of exactly what the agent will see.
   */
  async captureInitial({ commit = null } = {}) {
    if (!this._isOwnRepo()) {
      if (commit) throw new Error(`Task pins commit ${commit} but its repo is not a git repository`);
      this._git(["init", "-q"]);
    } else if (commit) {
      this._git(["checkout", "-q", "--force", commit]);
      this._git(["clean", "-fdxq"]);
    }
    const infoDir = join(this.workdir, ".git", "info");
    mkdirSync(infoDir, { recursive: true });
    appendFileSync(join(infoDir, "exclude"), `\n${EXCLUDES.join("\n")}\n`);
    this._git(["add", "-A"]);
    this._git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "harness: initial state"]);
    return this._git(["rev-parse", "HEAD"]);
  }

  /** Restore the workspace to `commit` (discarding baseline-run side effects). */
  async reset(commit) {
    this._git(["reset", "-q", "--hard", commit]);
    this._git(["clean", "-fdq"]);
  }

  /** Apply a unified diff (e.g. a SWE-bench test_patch). Throws on failure. */
  async applyPatch(patchText) {
    const file = join(this.workdir, ".harness-test.patch");
    writeFileSync(file, patchText.endsWith("\n") ? patchText : `${patchText}\n`, "utf8");
    try {
      this._git(["apply", "--whitespace=nowarn", file]);
    } finally {
      rmSync(file, { force: true });
    }
  }

  async captureDiff(initialCommit) {
    // Stage all changes so diff is accurate even without agent committing
    this._git(["add", "-A"], { allowFail: true });

    const unifiedDiff = this._git(["diff", "--cached", initialCommit], { allowFail: true });
    const numstat = this._git(["diff", "--cached", "--numstat", initialCommit], { allowFail: true });
    const filesChanged = this._git(["diff", "--cached", "--name-only", initialCommit], { allowFail: true }).split("\n").filter(Boolean);

    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [a, d] = line.split("\t");
      // binary files report "-"
      linesAdded += Number.parseInt(a, 10) || 0;
      linesRemoved += Number.parseInt(d, 10) || 0;
    }

    // Unstage so later git operations (test patch, reset) see a normal tree
    this._git(["reset", "-q"], { allowFail: true });

    return {
      initialCommit,
      unifiedDiff: unifiedDiff || "",
      filesChanged,
      linesAdded,
      linesRemoved,
      stat: numstat || ""
    };
  }
}
