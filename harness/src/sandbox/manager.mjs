import { NativeSandbox } from "./native.mjs";
import { DockerSandbox } from "./docker.mjs";

/**
 * selectSandbox(task) → NativeSandbox | DockerSandbox
 *
 * Prefers the type declared in task.sandbox.type.
 * Falls back to native gracefully if Docker is unavailable.
 */
export function selectSandbox(task) {
  const type = task.sandbox?.type || "native";

  if (type === "docker") {
    if (!DockerSandbox.isAvailable()) {
      console.warn("[harness] Docker not available — falling back to native sandbox");
      return new NativeSandbox(task);
    }
    return new DockerSandbox(task);
  }

  return new NativeSandbox(task);
}
