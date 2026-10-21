import { readdirSync, realpathSync, existsSync, rmSync } from "node:fs";
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

const PATH_ARG_KEYS = ["path", "from", "to"];
const META = /[;&|`]|\$\(/;

export class IsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IsolationError";
  }
}

function realInside(root, target) {
  const rootReal = realpathSync(root);
  // Resolve the deepest existing ancestor (target may not exist yet, e.g. write_file)
  let probe = resolve(root, target);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
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
          rmSync(p, { force: true });
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

function guardPaths(tool, workdir) {
  const inner = tool.execute;
  return {
    ...tool,
    async execute(args, context) {
      for (const key of PATH_ARG_KEYS) {
        const v = args?.[key];
        if (typeof v === "string" && !realInside(workdir, v)) {
          throw new IsolationError(`Path resolves outside the task workspace: ${v}`);
        }
      }
      return inner.call(tool, args, context);
    }
  };
}

function splitCommand(command) {
  if (typeof command !== "string" || command.trim() === "") throw new Error("command is required");
  if (META.test(command)) throw new Error("shell metacharacters are blocked");
  return command.trim().split(/\s+/);
}

function dockerExecTool(base, executor, workdir, toArgv, defaultTimeoutMs) {
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
    async execute(args) {
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
    }
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
    } else if (name === "run_shell") {
      registry.tools.set(name, dockerExecTool(tool, executor, workdir, (a) => splitCommand(a.command), executor.timeoutMs));
    } else if (name === "run_tests") {
      registry.tools.set(name, dockerExecTool(tool, executor, workdir, (a) => {
        const cmd = Array.isArray(a.command) && a.command.length > 0 ? a.command.map(String) : ["npm", "run", "test", "--if-present"];
        if (cmd.some((x) => META.test(x))) throw new Error("shell metacharacters are blocked");
        return cmd;
      }, executor.timeoutMs));
    } else {
      registry.tools.set(name, guardPaths(tool, workdir));
    }
  }
  return { removed: removed.sort() };
}
