import { NativeSandbox } from "./native.mjs";
import { DockerSandbox, SandboxConfigError } from "./docker.mjs";

/**
 * selectSandbox(task) → NativeSandbox | DockerSandbox
 *
 * Uses the type declared in task.sandbox.type (default: native). A task that
 * asks for Docker gets Docker or an error — never a silent native fallback.
 */
export function selectSandbox(task, { isDockerAvailable = DockerSandbox.isAvailable } = {}) {
  const type = task.sandbox?.type || "native";

  if (type === "docker") {
    if (!isDockerAvailable()) {
      throw new SandboxConfigError(`Task '${task.id}' requires sandbox.type=docker but Docker is not available — refusing to fall back to native execution`);
    }
    return new DockerSandbox(task);
  }
  if (type !== "native") {
    throw new SandboxConfigError(`Unknown sandbox.type: ${type}`);
  }
  return new NativeSandbox(task);
}

export { SandboxConfigError };
