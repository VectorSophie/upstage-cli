// Trusted read-only mount policy.
//
// Threat: `sandbox.readonlyMounts` lets a task bind-mount a host file into the
// container. Task YAML is NOT always trusted (benchmark datasets / third-party
// task definitions reach loadTask the same way), so a task must never be able to
// name an arbitrary host path — even read-only, that exposes host files to the
// agent, which can exfiltrate them.
//
// Fail-closed design, authorization held in HARNESS code (never in task YAML):
//   1. Tasks reference a mount by NAME from this registry; they cannot supply a
//      host or container path. A task therefore cannot expand its own mount
//      permissions — it can only pick a pre-approved, fixed {host, container}.
//   2. Independently, every host path that reaches the sandbox is canonicalised
//      (realpath, resolving symlinks and `..`) and must fall within an allowed
//      root (the harness `fixtures/` tree, plus any operator-configured roots in
//      HARNESS_MOUNT_ALLOW_ROOTS — an environment setting, not task input). This
//      catches symlink escapes and any path that bypasses the registry.
// The container path is additionally restricted (absolute, outside /workspace)
// here and in buildDockerRunArgs.

import { realpathSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_DIR = join(HARNESS_DIR, "fixtures");
const CONTAINER_CWD = "/workspace";

export class MountPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MountPolicyError";
  }
}

// The ONLY read-only mounts a task may request, by logical name. Host paths are
// harness-owned, version-controlled fixture files the agent cannot write.
const TRUSTED_MOUNT_ASSETS = {
  "t3-challenge-v3": {
    host: join(FIXTURES_DIR, "tool-continuation-v3", "challenge.mjs"),
    container: "/opt/t3/challenge.mjs"
  }
};

function allowedRoots() {
  const roots = [FIXTURES_DIR];
  const extra = process.env.HARNESS_MOUNT_ALLOW_ROOTS;
  if (extra) {
    for (const p of extra.split(":").map((s) => s.trim()).filter(Boolean)) roots.push(resolve(p));
  }
  // Canonicalise the roots themselves; drop any that do not resolve.
  const real = [];
  for (const r of roots) {
    try { real.push(realpathSync(r)); } catch { /* skip missing root */ }
  }
  return real;
}

function assertContainerPath(container) {
  if (typeof container !== "string" || !container.startsWith("/") || container === CONTAINER_CWD || container.startsWith(`${CONTAINER_CWD}/`)) {
    throw new MountPolicyError(`read-only mount container path must be absolute and outside ${CONTAINER_CWD}: ${container}`);
  }
}

/** Resolve a task's named mount asset → {host, container}. Throws (fail-closed) on unknown names. */
export function resolveMountAsset(name) {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(TRUSTED_MOUNT_ASSETS, name)) {
    throw new MountPolicyError(`unknown read-only mount asset '${name}' — tasks may only reference the trusted registry (${Object.keys(TRUSTED_MOUNT_ASSETS).join(", ") || "none"})`);
  }
  const asset = TRUSTED_MOUNT_ASSETS[name];
  const resolved = { host: asset.host, container: asset.container };
  assertMountAllowed(resolved); // the registry's own entries must also satisfy the policy
  return resolved;
}

/**
 * Independent allowlist check applied to every mount before Docker runs.
 * Canonicalises the host (symlinks + traversal resolved) and requires it inside
 * an allowed root; validates the container path. Throws MountPolicyError.
 */
export function assertMountAllowed(mount) {
  if (!mount || typeof mount.host !== "string" || typeof mount.container !== "string") {
    throw new MountPolicyError("read-only mount needs string host and container");
  }
  assertContainerPath(mount.container);
  let realHost;
  try {
    realHost = realpathSync(mount.host);
  } catch {
    throw new MountPolicyError(`read-only mount host does not exist: ${mount.host}`);
  }
  const roots = allowedRoots();
  const ok = roots.some((root) => realHost === root || realHost.startsWith(root + sep));
  if (!ok) {
    throw new MountPolicyError(`read-only mount host '${mount.host}' resolves outside the trusted asset roots (${roots.join(", ")}) — denied`);
  }
  return { host: realHost, container: mount.container };
}

export const _TRUSTED_MOUNT_ASSET_NAMES = Object.keys(TRUSTED_MOUNT_ASSETS);
