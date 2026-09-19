import { spawn } from "node:child_process";

import { resolveSandboxExecutor } from "./select-executor.mjs";
import { writeArtifact } from "../runtime/artifacts.mjs";

const DEFAULT_ALLOWED = new Set([
  // JavaScript / Node
  "node", "npm", "npx", "pnpm", "yarn", "bun",
  // TypeScript
  "tsc",
  // Test runners
  "jest", "vitest", "mocha", "ava", "tap",
  // Linters / formatters
  "eslint", "prettier", "biome",
  // Python
  "python", "python3", "pip", "pip3", "uv", "poetry", "pytest",
  "ruff", "black", "mypy", "flake8", "pylint", "isort",
  // Go
  "go",
  // Rust
  "cargo", "rustc", "rustfmt",
  // Ruby
  "ruby", "gem", "bundle", "rake",
  // Java / JVM
  "java", "javac", "mvn", "gradle",
  // Build tools
  "make", "cmake",
  // Git & GitHub
  "git", "gh",
  // Docker
  "docker", "docker-compose",
  // File operations (injection check already blocks rm -rf /)
  "ls", "find", "cat", "head", "tail", "wc",
  "mkdir", "cp", "mv", "rm", "touch", "diff", "patch",
  // Search
  "grep", "rg", "ag",
  // Archives
  "tar", "zip", "unzip", "gzip", "gunzip",
  // Environment inspection
  "which", "env", "echo", "pwd", "printenv",
  // Network (gated by networkBlocked flag)
  "curl", "wget"
]);

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "telnet", "ssh"]);

function hasShellMetacharacters(value) {
  return /[;&|`]/.test(value) || value.includes("$(");
}

function normalizeOptions(options = {}) {
  const {
    cwd,
    timeoutMs = 120000,
    outputLimit = 20000,
    allowlist = DEFAULT_ALLOWED,
    networkBlocked = false,
    env = process.env,
    sandbox = process.env.UPSTAGE_SANDBOX === "docker" ? "docker" : "local",
    sessionId,
    onStdout,
    onStderr
  } = options;
  return {
    cwd,
    timeoutMs,
    outputLimit,
    allowlist,
    networkBlocked,
    env,
    sandbox,
    sessionId,
    onStdout,
    onStderr
  };
}

function validateBinary(binary, allowlist, networkBlocked) {
  if (!allowlist.has(binary)) {
    throw new Error(`command not in allowlist: ${binary}`);
  }
  if (networkBlocked && NETWORK_COMMANDS.has(binary)) {
    throw new Error(`network command blocked: ${binary}`);
  }
}

export async function runSandboxedProcess(binary, args = [], options = {}) {
  const normalized = normalizeOptions(options);
  validateBinary(binary, normalized.allowlist, normalized.networkBlocked);

  for (const arg of args) {
    if (hasShellMetacharacters(String(arg))) {
      throw new Error("shell metacharacters are blocked in arguments");
    }
  }

  // Opt-in, fail-closed Docker path (3.3.0 Thread B) — resolveSandboxExecutor
  // throws DockerUnavailableError rather than falling back to the local
  // spawn below when sandbox:"docker" was explicitly requested.
  const dockerExecutor = resolveSandboxExecutor(normalized.sandbox);
  if (dockerExecutor) {
    // Deliberately `options.env` (the caller's raw input), NOT
    // `normalized.env` — normalizeOptions() defaults env to the full
    // `process.env` for the LOCAL executor below (correct: local execution
    // already runs in the host's own env). Forwarding that same default
    // into the container would leak every host env var (secrets included)
    // and — concretely, on Windows — overwrite the container's Linux PATH
    // with the host's Windows PATH, breaking binary lookup entirely. Only
    // an env object the caller explicitly passed is forwarded to Docker.
    const result = await dockerExecutor.exec(binary, args, {
      cwd: normalized.cwd,
      env: options.env,
      timeoutMs: normalized.timeoutMs,
      outputLimit: normalized.outputLimit,
      onStdout: normalized.onStdout,
      onStderr: normalized.onStderr
    });
    // Evidence store integration (3.3.0 Thread A) — the run's metadata +
    // stdout/stderr go to disk as a docker-log artifact; only the {path,
    // hash, kind, bytes} reference is attached to the result, never the
    // log bytes themselves. Skipped when no sessionId is available (e.g. a
    // bare library call with nowhere to file the artifact) — degrades to
    // "no evidence recorded," never to an error.
    if (normalized.sessionId) {
      const { image, network, durationMs, code, stdout, stderr } = result;
      const artifact = await writeArtifact(normalized.sessionId, {
        kind: "docker-log",
        ext: "json",
        data: JSON.stringify({ image, network, exitCode: code, durationMs, stdout, stderr })
      });
      return { ...result, artifact };
    }
    return result;
  }

  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: normalized.cwd,
      env: normalized.env,
      stdio: ["ignore", "pipe", "pipe"],
      // On Windows, `npm`/`npx`/`yarn` etc. are `.cmd` shims that cannot be
      // launched without a shell — `spawn("npm")` fails with ENOENT. Args are
      // already validated against shell metacharacters above and the binary
      // comes from the allowlist, so enabling the shell here is safe.
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, normalized.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (typeof normalized.onStdout === "function") {
        normalized.onStdout(text);
      }
      stdout += text;
      if (stdout.length > normalized.outputLimit) {
        stdout = stdout.slice(0, normalized.outputLimit);
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (typeof normalized.onStderr === "function") {
        normalized.onStderr(text);
      }
      stderr += text;
      if (stderr.length > normalized.outputLimit) {
        stderr = stderr.slice(0, normalized.outputLimit);
        truncated = true;
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code: timedOut ? -1 : code,
        stdout,
        stderr,
        truncated,
        timedOut
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: error.message,
        truncated,
        timedOut
      });
    });
  });
}

export async function runSandboxedCommand(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("command is required");
  }
  if (hasShellMetacharacters(command)) {
    throw new Error("shell metacharacters are blocked");
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const [binary, ...args] = parts;
  return runSandboxedProcess(binary, args, options);
}
