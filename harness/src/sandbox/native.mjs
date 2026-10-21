import { spawn, spawnSync } from "node:child_process";

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

// Harness-process state that must not leak into checks: under `node --test`,
// NODE_TEST_CONTEXT makes a nested `node --test` check report to the parent
// runner and exit 0 — a failing check would read as passing.
const HARNESS_ONLY_ENV = new Set(["NODE_TEST_CONTEXT", "NODE_OPTIONS", "NODE_CHANNEL_FD"]);

/** Host env minus credentials and harness-internal state — checks never need them. */
export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV_RE.test(k) && !HARNESS_ONLY_ENV.has(k)));
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    // detached:true made the child a process-group leader — kill the whole group
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * spawn() with a hard timeout that kills the whole process tree (execSync's
 * timeout only kills the immediate shell, leaving grandchildren running).
 * `onTimeout` runs before the tree kill — DockerSandbox uses it to `docker rm -f`.
 */
export function spawnWithTimeout(command, args, { cwd, env, timeoutMs, shell = false, outputLimit = 20000, onTimeout } = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch (err) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: err.message, timedOut: false, spawnError: err.message, durationMs: 0 });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    const cap = (s) => (s.length > outputLimit ? s.slice(0, outputLimit) : s);
    child.stdout.on("data", (c) => { stdout = cap(stdout + c); });
    child.stderr.on("data", (c) => { stderr = cap(stderr + c); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { onTimeout?.(); } catch { /* best effort */ }
      killTree(child);
    }, timeoutMs);
    child.on("error", (err) => { spawnError = err.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut && !spawnError,
        exitCode: timedOut ? null : code,
        stdout,
        stderr: spawnError ? `${stderr}${spawnError}` : stderr,
        timedOut,
        spawnError,
        durationMs: Date.now() - start
      });
    });
  });
}

/**
 * NativeSandbox — runs commands directly on the host. Only for trusted local
 * development tasks: it enforces a wall-clock timeout (with process-tree kill)
 * and strips credential-looking env vars, nothing else. describe() says so.
 */
export class NativeSandbox {
  constructor(task) {
    this.task = task;
    this.sandbox = task.sandbox || {};
    this.timeoutMs = (this.sandbox.timeout || 120) * 1000;
    this._workdir = null;
  }

  get type() { return "native"; }

  async setup(workdir) {
    this._workdir = workdir;
  }

  /** Run a shell command string (check commands are shell strings). */
  async execShell(command, { timeoutMs = this.timeoutMs, cwd = this._workdir } = {}) {
    return spawnWithTimeout(command, [], { cwd, env: scrubbedEnv(), timeoutMs, shell: true });
  }

  async exec(command, args = [], { cwd = this._workdir, timeoutMs = this.timeoutMs } = {}) {
    return spawnWithTimeout(command, args, { cwd, env: scrubbedEnv(), timeoutMs, shell: process.platform === "win32" });
  }

  async copyOut(_srcPath, _destPath) {
    // Native: files are already in the workdir, nothing to copy
  }

  async teardown() {
    this._workdir = null;
  }

  describe() {
    const requested = this.sandbox.network || "none";
    return {
      type: "native",
      trusted: true,
      network: { requested, enforced: false },
      enforced: { network: false, filesystem: false, cpu: false, memory: false, pids: false, time: true, secretEnvScrubbed: true },
      warnings: requested === "none"
        ? ["sandbox.network=none is NOT enforced by the native sandbox; use type: docker for untrusted execution"]
        : []
    };
  }
}
