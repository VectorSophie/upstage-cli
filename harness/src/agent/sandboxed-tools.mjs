import { readdirSync, realpathSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";

/**
 * Restricting a src/tools ToolRegistry to what is safe when the task runs in
 * a DockerSandbox. Agent-controlled *execution* (run_shell, run_tests) is
 * routed into the container; tools that would execute or reach out on the
 * host (lint/typecheck subprocesses, web, browser, GitHub, subagents, skills
 * read from host dirs, …) are removed. In-process file tools stay, but every
 * path argument is resolved through realpath and must land inside the
 * workspace — the container can create symlinks, so a lexical check alone
 * would let `ln -s ~/.ssh/id_rsa x; read_file x` read host files.
 */
export const DOCKER_SAFE_TOOLS = new Set([
  "echo", "list_files", "read_file", "write_file", "edit_file", "multi_edit",
  "create_patch", "apply_patch", "search_code", "glob", "delete_file", "rename_file",
  "todo_write", "todo_read", "repo_map", "find_symbol", "find_references",
  "list_modules", "index_health", "run_shell", "run_tests"
]);

// Every filesystem path argument of each confinable tool, per its inputSchema
// (nested ones included). A tool in DOCKER_SAFE_TOOLS that is missing here
// takes no path (it only reads the workspace root); h11 asserts that this map
// and the schemas stay in sync.
export const PATH_ARGS = {
  list_files: (a) => [a.path],
  read_file: (a) => [a.path],
  write_file: (a) => [a.path],
  edit_file: (a) => [a.path],
  multi_edit: (a) => [a.path],
  create_patch: (a) => [a.path],
  apply_patch: (a) => [a.patch?.path],
  glob: (a) => [a.path],
  delete_file: (a) => [a.path],
  rename_file: (a) => [a.from, a.to]
};
const META = /[;&|`]|\$\(/;

export class IsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IsolationError";
  }
}

function lexists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function realInside(root, target) {
  const rootReal = realpathSync(root);
  // Resolve the deepest existing ancestor (target may not exist yet, e.g.
  // write_file). lstat, so a dangling symlink counts as existing and fails
  // realpath below instead of being written through.
  let probe = resolve(root, target);
  while (!lexists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let real;
  try {
    real = realpathSync(probe);
  } catch {
    return false; // dangling symlink etc.
  }
  return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

/** Remove symlinks under `root` that resolve outside it. Returns their relative paths. */
export function removeEscapingSymlinks(root) {
  const found = [];
  const rootReal = realpathSync(root);
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let ok = false;
        try {
          const r = realpathSync(p);
          ok = r === rootReal || r.startsWith(rootReal + sep);
        } catch { /* dangling → treat as escaping */ }
        if (!ok) {
          // remove the link itself, never its target (Windows directory
          // links/junctions need rmdir; rmSync refuses them)
          try { unlinkSync(p); } catch { rmdirSync(p); }
          found.push(p.slice(root.length + 1));
        }
      } else if (ent.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(root);
  return found;
}

// One lock per registry: a container command (which can create symlinks)
// never runs between a file tool's path check and its filesystem access, even
// when the loop executes tool calls in parallel.
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function guardPaths(tool, workdir, locked, pathsOf) {
  const inner = tool.execute;
  return {
    ...tool,
    execute: (args, context) => locked(async () => {
      for (const v of pathsOf(args ?? {})) {
        if (v === undefined) continue;
        if (typeof v !== "string" || !realInside(workdir, v)) {
          throw new IsolationError(`Path resolves outside the task workspace: ${String(v)}`);
        }
      }
      return inner.call(tool, args, context);
    })
  };
}

/**
 * Confine every in-process file tool's path arguments to `workdir` (realpath,
 * so symlinks cannot point out). Used for docker and native tasks alike.
 * Limits: only the tools in PATH_ARGS are path-checked; a native task's
 * run_shell is not confined at all (native is not a sandbox).
 */
export function confineFileTools(registry, workdir, locked = createLock()) {
  for (const [name, tool] of [...registry.tools.entries()]) {
    if (PATH_ARGS[name]) registry.tools.set(name, guardPaths(tool, workdir, locked, PATH_ARGS[name]));
  }
  return locked;
}

function splitCommand(command) {
  if (typeof command !== "string" || command.trim() === "") throw new Error("command is required");
  if (META.test(command)) throw new Error("shell metacharacters are blocked");
  return command.trim().split(/\s+/);
}

function dockerExecTool(base, executor, workdir, locked, toArgv, defaultTimeoutMs) {
  return {
    ...base,
    description: `${base.description} (runs inside the task's Docker sandbox)`,
    // The model must not be able to pick the sandbox or re-enable networking
    inputSchema: {
      type: "object",
      properties: base.name === "run_shell"
        ? { command: { type: "string" }, timeoutMs: { type: "number" } }
        : { command: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number" } },
      required: base.name === "run_shell" ? ["command"] : [],
      additionalProperties: false
    },
    execute: (args) => locked(async () => {
      const [binary, ...rest] = toArgv(args);
      const timeoutMs = Math.min(Number.isInteger(args.timeoutMs) ? args.timeoutMs : defaultTimeoutMs, defaultTimeoutMs);
      const r = await executor.exec(binary, rest, { timeoutMs });
      if (r.infraError) throw new Error(`sandbox error: ${r.infraError}`);
      const escaped = removeEscapingSymlinks(workdir);
      return {
        ok: r.ok,
        code: r.exitCode,
        stdout: r.stdout,
        stderr: escaped.length ? `${r.stderr}\n[harness] removed symlinks escaping the workspace: ${escaped.join(", ")}` : r.stderr,
        timedOut: r.timedOut,
        sandbox: "docker"
      };
    })
  };
}

/**
 * Mutates `registry` so that it is safe for a Docker-isolated task.
 * Throws IsolationError if the task explicitly allows a host-only tool.
 * Returns { removed } (tools dropped because they cannot be isolated).
 */
export function confineRegistryToSandbox(registry, executor, workdir, { explicitAllow = [] } = {}) {
  const unsafeRequested = explicitAllow.filter((n) => !DOCKER_SAFE_TOOLS.has(n));
  if (unsafeRequested.length > 0) {
    throw new IsolationError(`Task allows tools that cannot be isolated in the Docker sandbox: ${unsafeRequested.join(", ")}`);
  }
  const removed = [];
  for (const [name, tool] of [...registry.tools.entries()]) {
    if (!DOCKER_SAFE_TOOLS.has(name) || tool.source !== "builtin") {
      registry.tools.delete(name);
      removed.push(name);
    }
  }
  const locked = confineFileTools(registry, workdir);
  const runShell = registry.tools.get("run_shell");
  if (runShell) {
    registry.tools.set("run_shell", dockerExecTool(runShell, executor, workdir, locked, (a) => splitCommand(a.command), executor.timeoutMs));
  }
  const runTests = registry.tools.get("run_tests");
  if (runTests) {
    registry.tools.set("run_tests", dockerExecTool(runTests, executor, workdir, locked, (a) => {
      const cmd = Array.isArray(a.command) && a.command.length > 0 ? a.command.map(String) : ["npm", "run", "test", "--if-present"];
      if (cmd.some((x) => META.test(x))) throw new Error("shell metacharacters are blocked");
      return cmd;
    }, executor.timeoutMs));
  }
  return { removed: removed.sort() };
}
