// Sandbox selection for 3.3.0 Thread B, Task B.3. Docker execution is
// opt-in (never auto-preferred over local) and FAILS CLOSED when
// explicitly requested but unavailable — see the owner decision in
// docs/superpowers/specs/2026-09-19-3.3.0-verification-evidence-design.md
// §B. `isAvailable` is an injectable seam so tests can exercise both
// branches deterministically without depending on whether this machine
// actually has Docker installed.

import { DockerExecutor } from "./docker-executor.mjs";

export class DockerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DockerUnavailableError";
    this.code = "DOCKER_UNAVAILABLE";
  }
}

/** Returns a DockerExecutor when `sandbox === "docker"` and Docker is
 *  available, `null` when `sandbox` is "local"/unset (caller should use its
 *  existing local path), or throws DockerUnavailableError — never a silent
 *  fallback to local. */
export function resolveSandboxExecutor(sandbox = "local", { isAvailable = DockerExecutor.isAvailable, dockerOptions } = {}) {
  if (sandbox !== "docker") return null;
  if (!isAvailable()) {
    throw new DockerUnavailableError(
      "sandbox:'docker' was requested but Docker is not available — install/start Docker, or drop --sandbox docker to run locally"
    );
  }
  return new DockerExecutor(dockerOptions);
}
