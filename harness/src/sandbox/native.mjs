import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const CLI_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../src");

async function importFromCli(relPath) {
  return import(pathToFileURL(resolve(CLI_ROOT, relPath)).href);
}

/**
 * Thin wrapper around src/sandbox/exec.mjs.
 * Provides the same interface as DockerSandbox so TaskRunner can use either.
 */
export class NativeSandbox {
  constructor(task) {
    this.task = task;
    this._allowedBinaries = new Set(task.sandbox?.allowedBinaries || []);
  }

  get type() { return "native"; }

  async setup() {
    // No-op for native; workdir is already prepared by TaskRunner
  }

  async exec(command, args = [], { cwd, timeoutMs, env } = {}) {
    const { runSandboxedProcess } = await importFromCli("sandbox/exec.mjs");
    const sandbox = this.task.sandbox || {};
    const timeout = timeoutMs || (sandbox.timeout || 120) * 1000;

    return runSandboxedProcess(command, args, {
      cwd,
      timeoutMs: timeout,
      outputLimit: 20000,
      networkBlocked: sandbox.network === "none",
      env
    });
  }

  async copyOut(_srcPath, _destPath) {
    // Native: files are already in the workdir, nothing to copy
  }

  async teardown() {
    // No-op
  }
}
