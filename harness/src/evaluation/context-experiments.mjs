import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { execSync } from "node:child_process";

const MAX_FULL_REPO_CHARS = 128_000;
const DEFAULT_MAX_FILES = 5;

/**
 * 6 context strategies behind --experimental-context.
 * Each returns { systemContext: string, files: string[], strategy }.
 */
export async function buildExperimentalContext(strategy, task, workdir) {
  switch (strategy) {
    case "full-repo":     return fullRepo(workdir);
    case "failing-test":  return failingTest(task, workdir);
    case "recent-diffs":  return recentDiffs(workdir);
    case "retrieval":     return retrieval(task, workdir);
    case "symbol-graph":  return symbolGraph(task, workdir);
    case "default":
    default:              return defaultContext(task, workdir);
  }
}

function defaultContext(task, workdir) {
  return {
    strategy: "default",
    systemContext: `Task: ${task.prompt}\nRepo: ${workdir}`,
    files: []
  };
}

function fullRepo(workdir) {
  const files = [];
  const parts = [];
  let total = 0;

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else {
        const ext = extname(e.name);
        if (![".py", ".js", ".mjs", ".ts", ".go", ".java", ".rb", ".rs", ".c", ".cpp", ".h"].includes(ext)) continue;
        try {
          const content = readFileSync(abs, "utf8");
          const chunk = `\n### ${abs}\n${content}`;
          if (total + chunk.length > MAX_FULL_REPO_CHARS) {
            parts.push("\n[...truncated: context limit reached...]");
            return;
          }
          parts.push(chunk);
          files.push(abs);
          total += chunk.length;
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(workdir);
  return { strategy: "full-repo", systemContext: parts.join(""), files, truncated: total >= MAX_FULL_REPO_CHARS };
}

function failingTest(task, workdir) {
  const failChecks = task.checks?.fail_to_pass || [];
  if (failChecks.length === 0) {
    return { strategy: "failing-test", systemContext: "No fail_to_pass checks configured.", files: [] };
  }
  const parts = [`Failing test commands:\n`];
  const files = [];
  for (const check of failChecks) {
    parts.push(`  ${check.command}`);
    // Try to capture test output
    try {
      execSync(check.command, { cwd: workdir, timeout: (check.timeout || 30) * 1000, stdio: "pipe" });
    } catch (err) {
      const output = ((err.stdout || "") + "\n" + (err.stderr || "")).trim().slice(0, 3000);
      parts.push(`\nFailure output:\n${output}`);
    }
  }
  return { strategy: "failing-test", systemContext: parts.join("\n"), files };
}

function recentDiffs(workdir) {
  let diff = "";
  try {
    diff = execSync("git log --oneline -10 && git diff HEAD~10..HEAD", {
      cwd: workdir,
      encoding: "utf8",
      timeout: 10000
    });
    if (diff.length > MAX_FULL_REPO_CHARS) {
      diff = diff.slice(0, MAX_FULL_REPO_CHARS) + "\n[...truncated...]";
    }
  } catch (err) {
    diff = `(git diff failed: ${err.message})`;
  }
  return { strategy: "recent-diffs", systemContext: `Recent git history:\n${diff}`, files: [] };
}

function retrieval(task, workdir) {
  // Simple keyword retrieval: grep for terms in the prompt
  const keywords = task.prompt.split(/\W+/).filter((w) => w.length > 4).slice(0, 5);
  const files = [];
  const parts = [`Keyword search for: ${keywords.join(", ")}\n`];
  for (const kw of keywords) {
    try {
      const result = execSync(`grep -rl "${kw}" .`, {
        cwd: workdir, encoding: "utf8", timeout: 5000
      }).trim().split("\n").filter(Boolean).slice(0, 3);
      for (const f of result) {
        if (!files.includes(f)) {
          files.push(f);
          try {
            const content = readFileSync(resolve(workdir, f), "utf8").slice(0, 2000);
            parts.push(`\n### ${f}\n${content}`);
          } catch { /* skip */ }
        }
      }
    } catch { /* keyword not found */ }
  }
  return { strategy: "retrieval", systemContext: parts.join(""), files };
}

function symbolGraph(task, workdir) {
  // Lightweight symbol extraction without tree-sitter: grep for function/class defs
  const files = [];
  const parts = ["Symbol graph (functions/classes):\n"];
  let entries;
  try { entries = readdirSync(workdir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (e.isFile() && [".py", ".js", ".mjs", ".ts"].includes(extname(e.name))) {
      const abs = join(workdir, e.name);
      try {
        const content = readFileSync(abs, "utf8");
        const symbols = extractSymbols(content);
        if (symbols.length > 0) {
          parts.push(`${e.name}: ${symbols.join(", ")}`);
          files.push(abs);
        }
      } catch { /* skip */ }
    }
  }
  return { strategy: "symbol-graph", systemContext: parts.join("\n"), files };
}

function extractSymbols(content) {
  const symbols = [];
  const patterns = [
    /^def\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^(?:export\s+)?class\s+(\w+)/gm
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) symbols.push(m[1]);
  }
  return symbols.slice(0, 20);
}
