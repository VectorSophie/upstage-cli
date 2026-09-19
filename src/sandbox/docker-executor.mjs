// Docker-backed executor for the main agent (3.3.0 Thread B, Task B.2) —
// ad-hoc single-command execution against the current working directory,
// conforming to the same {ok, code, stdout, stderr, truncated, timedOut}
// shape src/sandbox/exec.mjs's runSandboxedProcess() (the local executor)
// already returns, so select-executor.mjs (Task B.3) and every call site
// (Task B.4) can treat "local" and "docker" interchangeably.
//
// Deliberately NOT the eval harness's DockerSandbox (harness/src/sandbox/
// docker.mjs): that class is SWE-bench-task-shaped — setup(workdir) builds
// a per-task env image via a generated Dockerfile + a full workdir copy
// into the build context, which fits a benchmark run but not an
// interactive agent re-running `run_shell` against files already on disk.
// What *is* shared is the actual security posture (network isolation,
// read-only root, resource caps) — that lives in docker-flags.mjs and both
// classes build their `docker run` invocation from it, so the one part
// that actually needs to never drift, doesn't.

import { spawn, spawnSync } from "node:child_process";

import { buildDockerRunArgs } from "./docker-flags.mjs";

const DEFAULT_IMAGE = process.env.UPSTAGE_SANDBOX_DOCKER_IMAGE || "ubuntu:22.04";

export class DockerExecutor {
  constructor(options = {}) {
    this.image = options.image || DEFAULT_IMAGE;
    this.network = options.network || "none";
    this.memory = options.memory || "512m";
    this.cpus = options.cpus || "0.5";
  }

  static isAvailable() {
    try {
      const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  async exec(binary, args = [], options = {}) {
    const { cwd, env, timeoutMs = 120000, outputLimit = 20000 } = options;
    if (!cwd) throw new Error("DockerExecutor.exec requires options.cwd (bind-mounted into the container)");

    const dockerArgs = buildDockerRunArgs({
      image: this.image,
      workdir: cwd,
      network: this.network,
      memory: this.memory,
      cpus: this.cpus,
      env,
      command: binary,
      commandArgs: args
    });

    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        options.onStdout?.(text);
        stdout += text;
        if (stdout.length > outputLimit) {
          stdout = stdout.slice(0, outputLimit);
          truncated = true;
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        options.onStderr?.(text);
        stderr += text;
        if (stderr.length > outputLimit) {
          stderr = stderr.slice(0, outputLimit);
          truncated = true;
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          code: timedOut ? -1 : code,
          stdout, stderr, truncated, timedOut,
          image: this.image,
          network: this.network,
          durationMs: Date.now() - start
        });
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false, code: -1, stdout, stderr: error.message, truncated, timedOut,
          image: this.image,
          network: this.network,
          durationMs: Date.now() - start
        });
      });
    });
  }
}
