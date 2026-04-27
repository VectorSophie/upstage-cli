import { spawn } from "node:child_process";

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

  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: normalized.cwd,
      env: normalized.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
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
