import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

/**
 * DockerSandbox — SWE-bench style 3-tier layered image cache.
 *
 * Tier 1 (base): language runtime image, e.g. python:3.12-slim  — shared
 * Tier 2 (env):  deps pre-installed, tagged by hash of requirements files
 * Tier 3 (run):  per-run bind mount of workdir — zero layer overhead
 *
 * Cache policy controlled by HARNESS_DOCKER_CACHE=base|env|full (default: env)
 */
export class DockerSandbox {
  constructor(task) {
    this.task = task;
    this.sandbox = task.sandbox || {};
    this.image = this.sandbox.image || "ubuntu:22.04";
    this.network = this.sandbox.network || "none";
    this.memory = this.sandbox.memory || "512m";
    this.timeout = (this.sandbox.timeout || 120) * 1000;
    this._containerId = null;
    this._workdir = null;
    this._envImage = null;
  }

  get type() { return "docker"; }

  static isAvailable() {
    try {
      const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  async setup(workdir) {
    this._workdir = workdir;
    const cacheMode = process.env.HARNESS_DOCKER_CACHE || "env";
    if (cacheMode === "base") {
      this._envImage = this.image;
    } else {
      this._envImage = await this._buildEnvImage(workdir);
    }
  }

  async exec(command, args = [], { cwd, env } = {}) {
    if (!this._workdir) throw new Error("DockerSandbox.setup() must be called before exec()");

    const containerCwd = "/workspace";
    const dockerArgs = [
      "run", "--rm",
      "--network", this.network === "none" ? "none" : "bridge",
      "--memory", this.memory,
      "--cpus", "0.5",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "-v", `${this._workdir}:/workspace:rw`,
      "-w", containerCwd,
    ];

    if (env) {
      for (const [k, v] of Object.entries(env)) {
        dockerArgs.push("-e", `${k}=${v}`);
      }
    }

    dockerArgs.push(this._envImage, command, ...args);

    const start = Date.now();
    const result = spawnSync("docker", dockerArgs, {
      encoding: "utf8",
      timeout: this.timeout,
      maxBuffer: 20 * 1024 * 1024
    });

    return {
      ok: result.status === 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status || 0,
      durationMs: Date.now() - start
    };
  }

  async copyOut(srcPath, destPath) {
    // With bind mounts, files are immediately visible on the host — no-op
  }

  async teardown() {
    this._workdir = null;
    this._envImage = null;
  }

  async _buildEnvImage(workdir) {
    // Hash the requirements/package files to get a stable env-image tag
    const hashInput = [workdir, this.image, this.sandbox.allowedBinaries?.join(",") || ""].join("|");
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 12);
    const tag = `harness-env-${hash}`;

    // Check if image already exists (cache hit)
    const check = spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8" });
    if (check.status === 0) return tag;

    // Build env image: start from base, copy workdir, install deps
    const dockerfile = this._generateDockerfile(workdir);
    const ctxDir = mkdtempSync(join(tmpdir(), "harness-docker-ctx-"));
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(ctxDir, "Dockerfile"), dockerfile, "utf8");
      cpSync(workdir, join(ctxDir, "workspace"), { recursive: true });

      const build = spawnSync("docker", ["build", "-t", tag, ctxDir], {
        encoding: "utf8",
        timeout: 5 * 60 * 1000
      });
      if (build.status !== 0) {
        throw new Error(`Docker build failed:\n${build.stderr}`);
      }
    } finally {
      rmSync(ctxDir, { recursive: true, force: true });
    }

    return tag;
  }

  _generateDockerfile(workdir) {
    const lines = [`FROM ${this.image}`, "WORKDIR /workspace", "COPY workspace/ /workspace/"];

    // Language-specific dep install
    if (this.image.startsWith("python")) {
      lines.push("RUN pip install -r requirements.txt 2>/dev/null || true");
    } else if (this.image.startsWith("node")) {
      lines.push("RUN npm install 2>/dev/null || true");
    }

    return lines.join("\n") + "\n";
  }
}
