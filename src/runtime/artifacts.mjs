// Shared evidence store for 3.3.0's "see it, run it, prove it" verification
// work (docs/superpowers/specs/2026-09-19-3.3.0-verification-evidence-design.md
// §A). Docker execution, browser verification, and the vision sidecar all
// write binary/large evidence here instead of inlining it into
// session.toolResults, which is a size-capped array of small JSON entries
// (src/runtime/session.mjs's MAX_HISTORY_ITEMS trim). Tool results carry
// only the `{path, hash, kind, bytes}` returned here.
//
// ponytail: `--include-artifacts` session-export embedding (design doc's
// Task A.2) is deferred — every field it would need already exists (this
// module's return shape), but with zero real producers yet (browser/Docker
// tools land in later 3.3 sessions) there's no real convention to build
// against. Add it once a producer exists and the field shape it actually
// puts in toolResults is known.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";

import { sessionRoot } from "./session.mjs";

const ARTIFACT_KINDS = new Set([
  "screenshot",
  "console-log",
  "network-log",
  "docker-log",
  "vision-response"
]);

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  throw new TypeError("writeArtifact: data must be a Buffer or string");
}

export function sessionArtifactsDir(sessionId) {
  return join(sessionRoot(), sessionId, "artifacts");
}

/** Content-addressed write: `data` is hashed (sha256) and stored at
 *  `sessionArtifactsDir(sessionId)/<kind>/<hash>.<ext>` — identical bytes
 *  for the same kind dedupe to one file. Returns the metadata that should
 *  go into a tool result, never the bytes themselves. */
export async function writeArtifact(sessionId, { kind, ext, data } = {}) {
  if (!ARTIFACT_KINDS.has(kind)) {
    throw new Error(`unknown artifact kind: ${kind} (expected one of ${[...ARTIFACT_KINDS].join(", ")})`);
  }
  if (!ext || typeof ext !== "string") {
    throw new Error("writeArtifact requires a string `ext`");
  }
  const buffer = toBuffer(data);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const dir = join(sessionArtifactsDir(sessionId), kind);
  const path = join(dir, `${hash}.${ext}`);

  await mkdir(dir, { recursive: true });
  await writeFile(path, buffer);

  return { path, hash, kind, bytes: buffer.length };
}

export async function readArtifact(path) {
  return readFile(path);
}
