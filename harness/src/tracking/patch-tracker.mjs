import { execSync } from "node:child_process";

export class PatchTracker {
  constructor(workdir) {
    this.workdir = workdir;
  }

  async captureInitial() {
    const git = (cmd) => execSync(cmd, { cwd: this.workdir, stdio: "pipe" }).toString("utf8").trim();

    // Ensure this is a git repo; if not, initialise one
    try {
      git("git rev-parse --git-dir");
    } catch {
      git("git init");
      git('git config user.email "harness@upstage"');
      git('git config user.name "Harness"');
      git("git add -A");
      git('git commit -m "harness: initial state"');
    }

    try {
      return git("git rev-parse HEAD");
    } catch {
      // Repo with no commits yet
      git("git add -A");
      git('git commit -m "harness: initial state"');
      return git("git rev-parse HEAD");
    }
  }

  async captureDiff(initialCommit) {
    const git = (cmd) => {
      try {
        return execSync(cmd, { cwd: this.workdir, stdio: "pipe" }).toString("utf8").trim();
      } catch (err) {
        return err.stdout ? err.stdout.toString("utf8").trim() : "";
      }
    };

    // Stage all changes so diff is accurate even without agent committing
    git("git add -A");

    const unifiedDiff = git(`git diff --cached ${initialCommit}`);
    const statOutput = git(`git diff --cached --stat ${initialCommit}`);
    const filesChangedRaw = git(`git diff --cached --name-only ${initialCommit}`);

    const filesChanged = filesChangedRaw ? filesChangedRaw.split("\n").filter(Boolean) : [];

    let linesAdded = 0;
    let linesRemoved = 0;
    const addRe = /(\d+) insertion/;
    const delRe = /(\d+) deletion/;
    const addMatch = addRe.exec(statOutput);
    const delMatch = delRe.exec(statOutput);
    if (addMatch) linesAdded = parseInt(addMatch[1], 10);
    if (delMatch) linesRemoved = parseInt(delMatch[1], 10);

    return {
      initialCommit,
      unifiedDiff: unifiedDiff || "",
      filesChanged,
      linesAdded,
      linesRemoved,
      stat: statOutput || ""
    };
  }
}
