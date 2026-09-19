// Shared `docker run` security-flag builder (3.3.0 Thread B, Task B.2).
// The main agent's DockerExecutor (docker-executor.mjs) and the eval
// harness's DockerSandbox (harness/src/sandbox/docker.mjs) both build
// container invocations from this one place, so the security posture
// (network isolation, read-only root, resource caps) can't drift between
// the two copies that used to exist independently.
//
// Deliberately excludes: --privileged, any docker.sock mount, --network
// host, any wholesale process.env pass-through. If a caller needs one of
// those, that's a decision for the caller to make explicitly elsewhere —
// this builder never produces them.

const CONTAINER_CWD = "/workspace";

export function buildDockerRunArgs({
  image,
  workdir,
  network = "none",
  memory = "512m",
  cpus = "0.5",
  env,
  command,
  commandArgs = []
} = {}) {
  if (!image) throw new Error("buildDockerRunArgs requires an `image`");
  if (!workdir) throw new Error("buildDockerRunArgs requires a `workdir`");

  const args = [
    "run", "--rm",
    "--network", network === "none" ? "none" : network,
    "--memory", memory,
    "--cpus", cpus,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "-v", `${workdir}:${CONTAINER_CWD}:rw`,
    "-w", CONTAINER_CWD
  ];

  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(image);
  if (command) {
    args.push(command, ...commandArgs);
  }

  return args;
}

export { CONTAINER_CWD };
