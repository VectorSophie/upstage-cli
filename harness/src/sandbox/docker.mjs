import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { buildDockerRunArgs } from "../../../src/sandbox/docker-flags.mjs";
import { spawnWithTimeout } from "./native.mjs";
import { assertMountAllowed } from "./mount-registry.mjs";

const DEP_FILES = { python: "requirements.txt", node: "package.json" };
const DOCKER_DAEMON_ERROR = 125;

export class SandboxConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

/**
 * DockerSandbox — every command (agent tool calls and evaluation checks) runs
 * in a fresh `docker run --rm` container with only the task workspace
 * bind-mounted. Enforced: network (none by default), read-only root, memory
 * (+swap), CPU, pids, wall-clock timeout (container is force-removed on
 * timeout), dropped capabilities, no-new-privileges.
 *
 * Dependencies (sandbox.dependencies):
 *   "image" (default) — the image is used as-is; nothing from the repo is
 *     installed. Benchmark tasks should pin a prebuilt image (ideally by digest).
 *   "build" — requirements.txt / package.json from the workspace is installed
 *     into a derived image by `docker build`. Package installs run arbitrary
 *     code (setup.py, npm lifecycle scripts) WITH network access, so this is a
 *     trusted-preparation step: it requires the operator to opt in with
 *     HARNESS_ALLOW_DEPENDENCY_BUILD=1, otherwise setup fails closed. A task
 *     file alone can never turn it on.
 */
export class DockerSandbox {
  constructor(task) {
    this.task = task;
    this.sandbox = task.sandbox || {};
    this.image = this.sandbox.image || "ubuntu:22.04";
    const network = this.sandbox.network || "none";
    if (network === "allowlist") {
      throw new SandboxConfigError("sandbox.network=allowlist is not supported by the Docker sandbox (no egress filter is implemented); use 'none' or 'host'");
    }
    this.requestedNetwork = network;
    // "host" means "allow outbound"; we never use --network host, only the default bridge
    this.network = network === "none" ? "none" : "bridge";
    this.memory = this.sandbox.memory || "512m";
    this.cpus = String(this.sandbox.cpus || "1");
    this.pidsLimit = this.sandbox.pids || 256;
    this.timeoutMs = (this.sandbox.timeout || 120) * 1000;
    // Run as the invoking user on POSIX so bind-mounted files stay removable by the harness
    this.user = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined;
    this._workdir = null;
    // Trusted read-only bind mounts (e.g. an immutable challenge generator).
    // Host paths are resolved by the task loader; container paths must be
    // absolute and outside the workspace (buildDockerRunArgs enforces this).
    this.readonlyMounts = Array.isArray(this.sandbox.readonlyMounts) ? this.sandbox.readonlyMounts : [];
    this.dependencies = this.sandbox.dependencies || "image";
    if (!["image", "build"].includes(this.dependencies)) {
      throw new SandboxConfigError(`sandbox.dependencies must be "image" or "build", got: ${this.dependencies}`);
    }
    this._envImage = null;
    this._depInfo = null;
    this._live = new Set();
  }

  get type() { return "docker"; }

  static isAvailable() {
    try {
      const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 10000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  async setup(workdir) {
    if (this.dependencies === "build" && process.env.HARNESS_ALLOW_DEPENDENCY_BUILD !== "1") {
      throw new SandboxConfigError("sandbox.dependencies=build installs repository dependencies with network access; set HARNESS_ALLOW_DEPENDENCY_BUILD=1 only for trusted repositories");
    }
    // Independent trust-boundary check: every read-only mount host must
    // canonicalise within an allowed root (fail-closed), regardless of how this
    // sandbox was constructed. Resolve to the canonical host for the bind.
    this.readonlyMounts = this.readonlyMounts.map((m) => assertMountAllowed(m));
    this._workdir = workdir;
    if (this.dependencies === "build") {
      this._envImage = this._buildEnvImage(workdir);
    } else {
      this._envImage = this.image;
      this._depInfo = { mode: "image", method: "none", network: null, depFile: null, depFileSha256: null };
    }
  }

  async exec(command, args = [], { timeoutMs = this.timeoutMs, env } = {}) {
    if (!this._workdir) throw new Error("DockerSandbox.setup() must be called before exec()");
    const name = `harness-${randomBytes(6).toString("hex")}`;
    const dockerArgs = buildDockerRunArgs({
      image: this._envImage,
      workdir: this._workdir,
      network: this.network,
      memory: this.memory,
      cpus: this.cpus,
      env,
      command,
      commandArgs: args,
      name,
      pidsLimit: this.pidsLimit,
      user: this.user,
      hardened: true,
      mounts: this.readonlyMounts
    });
    this._live.add(name);
    try {
      const r = await spawnWithTimeout("docker", dockerArgs, {
        timeoutMs,
        onTimeout: () => removeContainer(name)
      });
      if (r.timedOut) removeContainer(name);
      // 125 = docker itself failed (bad image, daemon error) — not the command's fault
      const infraError = r.spawnError || r.exitCode === DOCKER_DAEMON_ERROR
        ? (r.spawnError || r.stderr.trim().slice(0, 500) || "docker run failed")
        : null;
      return { ...r, infraError, container: name };
    } finally {
      this._live.delete(name);
    }
  }

  async execShell(command, opts = {}) {
    return this.exec("sh", ["-c", command], opts);
  }

  async copyOut(_srcPath, _destPath) {
    // With bind mounts, files are immediately visible on the host — no-op
  }

  async teardown() {
    for (const name of this._live) removeContainer(name);
    this._live.clear();
    this._workdir = null;
  }

  describe() {
    return {
      type: "docker",
      trusted: false,
      image: this.image,
      envImage: this._envImage,
      envImageId: this._envImage ? imageId(this._envImage) : null,
      dependencies: this._depInfo,
      network: { requested: this.requestedNetwork, effective: this.network, enforced: true },
      memory: this.memory,
      cpus: this.cpus,
      pidsLimit: this.pidsLimit,
      timeoutMs: this.timeoutMs,
      readonlyMounts: this.readonlyMounts.map((m) => ({ container: m.container })),
      user: this.user || "image-default",
      enforced: { network: true, filesystem: true, cpu: true, memory: true, pids: true, time: true, readOnlyRoot: true, capDropAll: true },
      warnings: []
    };
  }

  _depFile(workdir) {
    const lang = this.image.startsWith("python") ? "python" : this.image.startsWith("node") ? "node" : null;
    const file = lang && DEP_FILES[lang];
    return file && existsSync(join(workdir, file)) ? { lang, file } : null;
  }

  _buildEnvImage(workdir) {
    const dep = this._depFile(workdir);
    if (!dep) return this.image;

    const hash = createHash("sha256")
      .update(this.image).update("\0")
      .update(readFileSync(join(workdir, dep.file)))
      .digest("hex").slice(0, 16);
    const tag = `harness-env:${hash}`;
    if (spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" }).status === 0) return tag;

    const install = dep.lang === "python"
      ? "RUN pip install --no-cache-dir -r /deps/requirements.txt"
      // node deps go outside /workspace (which is bind-mounted over at run time)
      : "RUN cd /deps && npm install --omit=dev\nENV NODE_PATH=/deps/node_modules";
    const ctxDir = mkdtempSync(join(tmpdir(), "harness-docker-ctx-"));
    try {
      copyFileSync(join(workdir, dep.file), join(ctxDir, dep.file));
      writeFileSync(join(ctxDir, "Dockerfile"), `FROM ${this.image}\nCOPY ${dep.file} /deps/${dep.file}\n${install}\n`, "utf8");
      const build = spawnSync("docker", ["build", "-t", tag, ctxDir], { encoding: "utf8", timeout: 10 * 60 * 1000 });
      if (build.status !== 0) {
        throw new Error(`Docker env image build failed for ${this.image} (${dep.file}):\n${(build.stderr || build.error?.message || "").slice(-2000)}`);
      }
    } finally {
      rmSync(ctxDir, { recursive: true, force: true });
    }
    return tag;
  }
}

function imageId(image) {
  const r = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", timeout: 30000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function removeContainer(name) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30000 });
}
