// Tests for `scripts/install.sh` — Task 7.12 of the 3.2.0 release plan
// ("installer hardening").
//
// `install.sh` is a bash script, not JS — there's no precedent in this repo
// for testing a shell script directly (the closest is m33-completion.test.mjs's
// `bash -n` syntax-only check on *generated* completion output). This suite
// goes further: it actually RUNS install.sh end-to-end against a local
// fixture HTTP server (node:http, no real network), the way the task spec
// asks for.
//
// Testability additions this required (see scripts/install.sh's own header
// comment for the authoritative list):
//   - UPSTAGE_RELEASE_BASE_URL — overrides "https://github.com/<repo>" so the
//     script downloads from our local fixture server instead.
//   - UPSTAGE_INSTALL_PLATFORM / UPSTAGE_INSTALL_ARCH — override the
//     `uname`-derived platform/arch so this suite gets a deterministic
//     "upstage-linux-x64.tar.gz" asset name regardless of the host OS this
//     test happens to run on (this dev/CI box is Windows).
//
// Bash availability: per Task 7.18's own findings (see m33-completion.test.mjs),
// `spawnSync("bash", ...)` resolves to Git Bash on this Windows dev box, and a
// real Linux/macOS CI runner always has one too. Verified directly below at
// module load; if genuinely absent, every test in this suite is skipped with
// a clearly logged reason rather than silently vanishing or failing.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  realpathSync,
  symlinkSync,
  lstatSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");

const bashCheck = spawnSync("bash", ["--version"], { encoding: "utf8" });
const BASH_AVAILABLE = !(bashCheck.error && bashCheck.error.code === "ENOENT");

if (!BASH_AVAILABLE) {
  console.log(
    "[m34-install-script] NOTE: no `bash` executable found on PATH in this " +
    "environment — skipping every test in this suite (they run scripts/install.sh " +
    "for real, which requires bash). See m33-completion.test.mjs for how bash " +
    "availability was verified on this project's own dev/CI boxes."
  );
}

// Whether this environment can create real symlinks. Some Windows dev boxes
// lack SeCreateSymbolicLinkPrivilege (Developer Mode off, not elevated); Git
// Bash's `ln -s` then silently falls back to copying the target's *content*
// into a plain regular file instead of creating a real symlink (confirmed by
// direct lstat/inode inspection — no error is raised either way). install.sh
// is documented macOS/Linux-only (see its own header comment) and real CI
// runs on genuine Unix runners where `ln -s` always creates true symlinks —
// so this is a known Windows-dev-box-only limitation of *testing* the
// script here, not a bug in install.sh. Probe for it so the "is really a
// symlink to $INSTALL_DIR" assertions can degrade to a content-equivalence
// check on such boxes instead of failing for a reason unrelated to
// install.sh's own correctness.
let SYMLINKS_SUPPORTED = true;
if (BASH_AVAILABLE) {
  const probeDir = mkdtempSync(join(tmpdir(), "upstage-symlink-probe-"));
  try {
    writeFileSync(join(probeDir, "target"), "x");
    symlinkSync(join(probeDir, "target"), join(probeDir, "link"));
    SYMLINKS_SUPPORTED = lstatSync(join(probeDir, "link")).isSymbolicLink();
  } catch {
    SYMLINKS_SUPPORTED = false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  if (!SYMLINKS_SUPPORTED) {
    console.log(
      "[m34-install-script] NOTE: this environment cannot create real symlinks " +
      "(no SeCreateSymbolicLinkPrivilege — common on non-elevated Windows dev " +
      "boxes without Developer Mode). install.sh's `ln -sf` then degrades to a " +
      "content copy rather than a true symlink; the affected assertions check " +
      "content equivalence instead of symlink identity here. Real CI " +
      "(Linux/macOS runners) exercises the actual symlink path."
    );
  }
}

/**
 * Asserts that $BIN_DIR/upstage is properly linked to $INSTALL_DIR/upstage —
 * a real symlink where the environment supports it (see SYMLINKS_SUPPORTED
 * above), content equivalence otherwise.
 */
function assertLinkedToInstall(binDir, installDir) {
  const linkPath = join(binDir, "upstage");
  const targetPath = join(installDir, "upstage");
  if (SYMLINKS_SUPPORTED) {
    assert.equal(realpathSync(linkPath), realpathSync(targetPath));
  } else {
    assert.equal(readFileSync(linkPath, "utf8"), readFileSync(targetPath, "utf8"));
  }
}

/**
 * Test-only: removes any PATH entry that already contains a real executable
 * named `name` (any of the platform-relevant extensions) from a Windows
 * semicolon-separated PATH string. Used so "BIN_DIR is genuinely not on
 * PATH" tests aren't polluted by an unrelated pre-existing `upstage` on this
 * dev machine's PATH (e.g. an unrelated global npm package of the same
 * name) — without this, `command -v upstage` could resolve to that instead
 * of failing the way the test needs it to.
 */
function pathWithoutExecutable(windowsPath, name) {
  const candidates = [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`];
  return windowsPath
    .split(";")
    .filter((dir) => !dir || !candidates.some((n) => existsSync(join(dir, n))))
    .join(";");
}

const FIXTURE_VERSION = "9.9.9-test";
const PLATFORM = "linux";
const ARCH = "x64";
const ASSET_NAME = `upstage-${PLATFORM}-${ARCH}.tar.gz`;

// ── fixture archive building ────────────────────────────────────────────
//
// Shells out to the real `tar`/`sha256sum`-equivalent tooling (already a
// hard requirement for install.sh itself to work) rather than pulling in an
// npm tar library — this project ships zero build-time dependencies.

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Builds a fixture `upstage-linux-x64.tar.gz` whose `upstage` binary is a
 * tiny shell script. `versionBehavior` controls what running `--version`
 * does, so tests can exercise both the happy path and the "binary doesn't
 * actually run" smoke-test-failure path.
 */
function buildFixtureArchive(workDir, { version = FIXTURE_VERSION, versionBehavior = "ok" } = {}) {
  const stageParent = join(workDir, "stage");
  const stageDir = join(stageParent, `upstage-${PLATFORM}-${ARCH}`);
  mkdirSync(stageDir, { recursive: true });

  const binPath = join(stageDir, "upstage");
  let script;
  if (versionBehavior === "ok") {
    script = `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "upstage-cli ${version}"\n  exit 0\nfi\necho "fake upstage binary"\n`;
  } else if (versionBehavior === "fail") {
    script = `#!/bin/sh\necho "boom: this binary does not actually work" >&2\nexit 1\n`;
  } else {
    throw new Error(`unknown versionBehavior: ${versionBehavior}`);
  }
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  const archivePath = join(workDir, ASSET_NAME);
  // --force-local: on Windows, GNU tar otherwise misparses an absolute path
  // with a drive letter ("C:\...") as a "host:path" remote-tar spec (the
  // colon after the drive letter looks like the remote-shell syntax) and
  // fails with "Cannot connect to C: resolve failed". install.sh itself
  // never hits this — its own tmp dirs come from `mktemp -d` under Git
  // Bash, which returns MSYS-style paths with no drive-letter colon.
  const tarResult = spawnSync("tar", ["-czf", archivePath, "--force-local", "-C", stageParent, `upstage-${PLATFORM}-${ARCH}`]);
  assert.equal(tarResult.status, 0, `fixture tar build failed: ${tarResult.stderr}`);

  const archiveBytes = readFileSync(archivePath);
  const checksumLine = `${sha256Hex(archiveBytes)}  ${ASSET_NAME}\n`;
  return { archiveBytes, checksumLine };
}

// ── local fixture "GitHub release" HTTP server ──────────────────────────

function startFixtureServer(routes) {
  // routes: Map<path, Buffer|string> — served verbatim; anything else 404s.
  const requestedPaths = [];
  const server = createServer((req, res) => {
    requestedPaths.push(req.url);
    const body = routes.get(req.url);
    if (body === undefined) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200);
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        requestedPaths,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

// ── install.sh runner ────────────────────────────────────────────────────

// IMPORTANT: this must use ASYNC spawn, not spawnSync. The fixture HTTP
// server started by startFixtureServer() runs in this very Node process's
// event loop — install.sh shells out to `curl` against that server.
// spawnSync blocks the whole JS thread (event loop included) until the
// child exits, so if the server lived in-process, the request curl sends
// could never be serviced: curl waits forever for a response, spawnSync
// waits forever for curl, deadlock. (Confirmed by direct repro: an
// otherwise-identical spawnSync call against an in-process http.Server
// hangs indefinitely; switching only to async spawn resolves immediately.)
// Using async spawn lets the event loop keep servicing the fixture server
// while curl runs as a child process.
function runInstall({ baseUrl, installDir, binDir, home, extraEnv = {}, args = [] }) {
  const env = {
    ...process.env,
    HOME: home,
    UPSTAGE_INSTALL_DIR: installDir,
    UPSTAGE_BIN_DIR: binDir,
    UPSTAGE_RELEASE_BASE_URL: baseUrl,
    UPSTAGE_INSTALL_PLATFORM: PLATFORM,
    UPSTAGE_INSTALL_ARCH: ARCH,
    ...extraEnv
  };
  // UPSTAGE_VERSION must be genuinely absent (not just ""), unless a test
  // explicitly wants it set — delete any inherited value from this process.
  if (!("UPSTAGE_VERSION" in extraEnv)) {
    delete env.UPSTAGE_VERSION;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [INSTALL_SH, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    // non-interactive stdin — confirm() in install.sh must treat this as "no"
    child.stdin.end("");
  });
}

function withTempLayout(run) {
  const root = mkdtempSync(join(tmpdir(), "upstage-install-sh-"));
  const home = join(root, "home");
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  return Promise.resolve()
    .then(() => run({ root, home, installDir, binDir }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

const describeOrSkip = BASH_AVAILABLE ? test : test.skip;

// ── 1. successful install (§7.19 #2 happy path + #3 extract/swap) ────────

describeOrSkip("successful install: downloads, verifies checksum, extracts, swaps into place, symlinks", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    const { archiveBytes, checksumLine } = buildFixtureArchive(root);
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, close }) => {
      return runInstall({ baseUrl, installDir, binDir, home }).then((result) => {
        assert.equal(result.status, 0, `expected success, got:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.match(result.stdout, /Installed:/);

        assertLinkedToInstall(binDir, installDir);

        const versionCheck = spawnSync("bash", [join(binDir, "upstage"), "--version"], { encoding: "utf8" });
        assert.equal(versionCheck.status, 0);
        assert.match(versionCheck.stdout, new RegExp(FIXTURE_VERSION.replace(/[.+]/g, "\\$&")));
      }).finally(() => close());
    });
  });
});

// ── 2. checksum-mismatch rejection (§7.19 #2) ─────────────────────────────

describeOrSkip("checksum mismatch: install is rejected before extraction, nothing installed", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    const { archiveBytes } = buildFixtureArchive(root);
    const wrongChecksum = `${"0".repeat(64)}  ${ASSET_NAME}\n`;
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, wrongChecksum]
    ])).then(({ baseUrl, close }) => {
      return runInstall({ baseUrl, installDir, binDir, home }).then((result) => {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /checksum/i);
        assert.throws(() => realpathSync(join(binDir, "upstage")));
        assert.throws(() => realpathSync(join(installDir, "upstage")));
      }).finally(() => close());
    });
  });
});

// ── 3. UPSTAGE_VERSION override changes the download URL (§7.19 #1) ──────

describeOrSkip("UPSTAGE_VERSION override changes the downloaded asset URL, not just the default 'latest' path", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    const { archiveBytes, checksumLine } = buildFixtureArchive(root);
    const TAG = "v9.9.9";
    return startFixtureServer(new Map([
      // Deliberately do NOT serve the "latest" path — if install.sh ignored
      // the override and fell back to it, this test would fail on a 404
      // rather than silently passing.
      [`/releases/download/${TAG}/${ASSET_NAME}`, archiveBytes],
      [`/releases/download/${TAG}/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, requestedPaths, close }) => {
      return runInstall({ baseUrl, installDir, binDir, home, extraEnv: { UPSTAGE_VERSION: TAG } }).then((result) => {
        assert.equal(result.status, 0, `expected success, got:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.ok(
          requestedPaths.includes(`/releases/download/${TAG}/${ASSET_NAME}`),
          `expected a request for the versioned path, got: ${JSON.stringify(requestedPaths)}`
        );
        assert.ok(!requestedPaths.some((p) => p.includes("/releases/latest/")));
      }).finally(() => close());
    });
  });
});

// ── 4. dev-link install detected and refused without --force (§7.19 #4) ──

describeOrSkip("pre-existing dev-link install is detected and refused without --force", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    mkdirSync(binDir, { recursive: true });
    const wrapperPath = join(binDir, "upstage");
    writeFileSync(
      wrapperPath,
      "#!/usr/bin/env bash\n# upstage-cli dev-link wrapper -- repo: /some/dev/checkout\nexec bun /some/dev/checkout/src/cli/index.mjs \"$@\"\n"
    );
    chmodSync(wrapperPath, 0o755);

    const { archiveBytes, checksumLine } = buildFixtureArchive(root);
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, close }) => {
      return runInstall({ baseUrl, installDir, binDir, home }).then((refused) => {
        assert.notEqual(refused.status, 0, `expected refusal without --force, got:\nstdout: ${refused.stdout}\nstderr: ${refused.stderr}`);
        assert.match(refused.stderr, /dev-link/i);
        // The wrapper must be untouched — this is the "refused", not "silently overwritten", assertion.
        assert.match(readFileSync(wrapperPath, "utf8"), /upstage-cli dev-link wrapper/);

        return runInstall({ baseUrl, installDir, binDir, home, args: ["--force"] });
      }).then((forced) => {
        assert.equal(forced.status, 0, `expected --force to succeed, got:\nstdout: ${forced.stdout}\nstderr: ${forced.stderr}`);
        assertLinkedToInstall(binDir, installDir);
      }).finally(() => close());
    });
  });
});

// ── 5. apparent-downgrade guard, the other half of §7.19 #4 ──────────────

describeOrSkip("an existing install newer than the target version is refused without --force or an explicit UPSTAGE_VERSION", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    // Seed an "already installed" binary reporting a version newer than the
    // 9.9.9-test fixture that's about to be offered.
    mkdirSync(installDir, { recursive: true });
    const oldBin = join(installDir, "upstage");
    writeFileSync(oldBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "upstage-cli 99.0.0"; exit 0; fi\n');
    chmodSync(oldBin, 0o755);

    const { archiveBytes, checksumLine } = buildFixtureArchive(root);
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, close }) => {
      return runInstall({ baseUrl, installDir, binDir, home }).then((refused) => {
        assert.notEqual(refused.status, 0, `expected refusal, got:\nstdout: ${refused.stdout}\nstderr: ${refused.stderr}`);
        assert.match(refused.stderr, /newer|downgrade/i);
        assert.match(readFileSync(oldBin, "utf8"), /99\.0\.0/);

        // An explicit UPSTAGE_VERSION opts out of the guard even without --force.
        return runInstall({ baseUrl, installDir, binDir, home, extraEnv: { UPSTAGE_VERSION: "latest" } });
      }).then((explicit) => {
        assert.equal(explicit.status, 0, `expected explicit UPSTAGE_VERSION to bypass the guard, got:\nstdout: ${explicit.stdout}\nstderr: ${explicit.stderr}`);
      }).finally(() => close());
    });
  });
});

// ── 6. atomicity: a binary that fails its --version smoke test never
// touches $INSTALL_DIR (§7.19 #3) ─────────────────────────────────────────

describeOrSkip("a binary that fails the --version smoke test aborts before touching INSTALL_DIR", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    mkdirSync(installDir, { recursive: true });
    const sentinel = join(installDir, "sentinel-from-previous-install");
    writeFileSync(sentinel, "still here\n");

    const { archiveBytes, checksumLine } = buildFixtureArchive(root, { versionBehavior: "fail" });
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, close }) => {
      return runInstall({ baseUrl, installDir, binDir, home }).then((result) => {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /smoke test/i);
        // The old install directory must be completely untouched.
        assert.equal(readFileSync(sentinel, "utf8"), "still here\n");
      }).finally(() => close());
    });
  });
});

// ── 7. PATH diagnosis uses a real `command -v` check (§7.19 #5) ──────────

describeOrSkip("PATH diagnosis: reports success via `command -v` when BIN_DIR is on PATH", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    const { archiveBytes, checksumLine } = buildFixtureArchive(root);
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, close }) => {
      return runInstall({
        baseUrl,
        installDir,
        binDir,
        home,
        extraEnv: { PATH: `${binDir}:${process.env.PATH}` }
      }).then((result) => {
        assert.equal(result.status, 0);
        assert.match(result.stdout, /PATH check: 'upstage' resolves to/);
        assert.doesNotMatch(result.stdout, /is not on your PATH/);
      }).finally(() => close());
    });
  });
});

describeOrSkip("PATH diagnosis: reports the missing-PATH note when BIN_DIR is genuinely not on PATH", () => {
  return withTempLayout(({ root, home, installDir, binDir }) => {
    const { archiveBytes, checksumLine } = buildFixtureArchive(root);
    return startFixtureServer(new Map([
      [`/releases/latest/download/${ASSET_NAME}`, archiveBytes],
      [`/releases/latest/download/${ASSET_NAME}.sha256`, checksumLine]
    ])).then(({ baseUrl, close }) => {
      // A minimal PATH that deliberately excludes binDir (but keeps enough
      // to resolve curl/tar/etc — reuse the real PATH minus binDir, which it
      // was never in to begin with here since binDir is a fresh tmp dir) —
      // also stripped of any dir that already has a real `upstage` on this
      // dev machine's PATH (e.g. an unrelated global npm package), so this
      // test genuinely exercises the "not found at all" case rather than
      // "found, but a different one" (that's what test 6, above, covers).
      const pathWithoutAnyUpstage = pathWithoutExecutable(process.env.PATH, "upstage");
      return runInstall({ baseUrl, installDir, binDir, home, extraEnv: { PATH: pathWithoutAnyUpstage } }).then((result) => {
        assert.equal(result.status, 0);
        assert.match(result.stdout, /is not on your PATH/);
      }).finally(() => close());
    });
  });
});
