#!/usr/bin/env bun
/**
 * Builds a standalone `upstage` executable for the CURRENT host platform via
 * `bun build --compile`, then packages it with the runtime assets that don't
 * survive single-file compilation (see comments in src/skills/loader.mjs and
 * src/indexer/parsers/adapter.mjs — anything read from disk relative to
 * import.meta.url/node_modules at runtime, rather than statically imported,
 * resolves to nothing inside a compiled binary's virtual filesystem):
 *   - skills/          the bundled first-party + adapted k-skill pack
 *   - tree-sitter/      the .wasm grammars used for real (non-regex) symbol search
 *   - LICENSE
 *
 * Deliberately builds for the CURRENT host only, not a cross-compile matrix —
 * @opentui/core's native rendering core ships a separate prebuilt addon per
 * OS/arch as an optionalDependency (@opentui/core-<platform>-<arch>), resolved
 * dynamically at runtime based on the CURRENT platform. Only the matching
 * optional package is ever installed, so `bun build --compile
 * --target=bun-<other-platform>` fails to statically resolve that addon's
 * import — this has to run once per real target platform (see
 * .github/workflows/release.yml's build matrix), not cross-compiled from one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARSERS } from "../src/indexer/parsers/adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const PLATFORM_NAMES = { linux: "linux", darwin: "darwin", win32: "windows" };
const platform = PLATFORM_NAMES[process.platform] || process.platform;
const arch = process.arch; // "x64" | "arm64"
const isWindows = process.platform === "win32";

const distName = `upstage-${platform}-${arch}`;
const stageDir = join(root, "dist", distName);
const binName = isWindows ? "upstage.exe" : "upstage";

console.log(`Building ${distName}...`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const build = spawnSync(
  "bun",
  ["build", "--compile", join(root, "src", "cli", "index.mjs"), "--outfile", join(stageDir, binName)],
  { cwd: root, stdio: "inherit" }
);
if (build.status !== 0) {
  console.error(`bun build --compile failed (exit ${build.status})`);
  process.exit(build.status || 1);
}

// skills/ — the bundled first-party + adapted k-skill pack (src/skills/loader.mjs's
// EXECUTABLE_SIBLING_SKILLS_DIR looks for exactly this: <binary's dir>/skills).
cpSync(join(root, "skills"), join(stageDir, "skills"), { recursive: true });

// tree-sitter/*.wasm — same idea, for src/indexer/parsers/adapter.mjs's fallback.
const treeSitterDir = join(stageDir, "tree-sitter");
mkdirSync(treeSitterDir, { recursive: true });
const wasmFiles = new Set(Object.values(PARSERS).map((p) => p.wasm));
for (const wasm of wasmFiles) {
  const moduleName = Object.values(PARSERS).find((p) => p.wasm === wasm).module;
  const src = join(root, "node_modules", moduleName, wasm);
  if (existsSync(src)) {
    cpSync(src, join(treeSitterDir, wasm));
  } else {
    console.warn(`  ! missing ${src} — ${wasm} grammar won't ship, symbol search for that language will fall back to regex`);
  }
}

cpSync(join(root, "LICENSE"), join(stageDir, "LICENSE"));

// Archive: .zip on Windows (no built-in CLI tar/gzip story that matches user
// expectations there), .tar.gz elsewhere.
const archiveName = isWindows ? `${distName}.zip` : `${distName}.tar.gz`;
const archivePath = join(root, "dist", archiveName);
rmSync(archivePath, { force: true });

const archive = isWindows
  ? spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${archivePath}'`], { stdio: "inherit" })
  : spawnSync("tar", ["-czf", archivePath, "-C", join(root, "dist"), distName], { stdio: "inherit" });

if (archive.status !== 0) {
  console.error(`archiving failed (exit ${archive.status})`);
  process.exit(archive.status || 1);
}

console.log(`Packaged: dist/${archiveName}`);
