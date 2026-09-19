import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctorChecks, runDoctorCommand, runCheck, formatJson, formatHuman } from "../src/cli/commands/doctor.mjs";

// A fake, distinctive "secret" value — chosen to be extremely unlikely to
// appear anywhere in real doctor output by coincidence, so a substring match
// is a reliable adversarial check for leakage.
const FAKE_SECRET = "up_TOTALLY_FAKE_SECRET_TOKEN_zzz999xyz";

// NOTE on test design: these tests deliberately do NOT monkey-patch
// `process.stdout.write` around any `await`ing call. `node --test` runs in
// the same process as the code under test and does its own TAP reporting
// through `process.stdout.write` — intercepting that global across a real
// async boundary (fs/child_process calls, which `runDoctorCommand` performs)
// races with the test runner's own deferred output and corrupts the TAP
// stream for *other* tests in this file (verified empirically while writing
// this suite). So: content/formatting assertions go through the pure,
// synchronous `formatJson`/`formatHuman` functions fed by `runDoctorChecks()`
// (no I/O), and `runDoctorCommand` itself is only asserted on its *return
// value* (the exit code) — never on captured stdout — except for the
// `--help` path, which is fully synchronous (no `await` of real I/O) and
// safe to capture.

function captureStdio(run) {
  const out = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try {
    run();
  } finally {
    process.stdout.write = origOut;
  }
  return out.join("");
}

function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

function withEnv(vars, run) {
  const originals = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(run).finally(() => {
    for (const key of Object.keys(vars)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-doctor-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const EXPECTED_SECTIONS = ["Core", "Upstage", "Project", "Extensions", "Security", "Verification"];

// --- every documented section appears ---

test("runDoctorChecks produces all six documented sections, each with at least one check", () => {
  return withTempDir(async (dir) => {
    const report = await runDoctorChecks({ cwd: dir });
    const names = report.sections.map((s) => s.name);
    assert.deepEqual(names, EXPECTED_SECTIONS);
    for (const section of report.sections) {
      assert.ok(section.checks.length > 0, `${section.name} should have at least one check`);
      for (const check of section.checks) {
        assert.equal(typeof check.name, "string");
        assert.ok(["pass", "warn", "fail", "unknown"].includes(check.status), `unexpected status "${check.status}" for ${check.name}`);
        assert.equal(typeof check.detail, "string");
      }
    }
  });
});

test("formatJson(report) round-trips to the documented { sections: [{ name, checks }] } shape", () => {
  return withTempDir(async (dir) => {
    const report = await runDoctorChecks({ cwd: dir });
    const parsed = JSON.parse(formatJson(report));
    assert.deepEqual(parsed.sections.map((s) => s.name), EXPECTED_SECTIONS);
    for (const section of parsed.sections) {
      for (const check of section.checks) {
        assert.ok("name" in check && "status" in check && "detail" in check);
      }
    }
  });
});

test("formatHuman(report) mentions every section name", () => {
  return withTempDir(async (dir) => {
    const report = await runDoctorChecks({ cwd: dir });
    const text = formatHuman(report);
    for (const name of EXPECTED_SECTIONS) {
      assert.match(text, new RegExp(name));
    }
  });
});

// --- security: no secret value ever appears in output ---

test("a fake UPSTAGE_API_KEY value never appears in formatJson output", () => {
  return withTempDir((dir) => withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    const report = await runDoctorChecks({ cwd: dir });
    const json = formatJson(report);
    assert.doesNotMatch(json, new RegExp(FAKE_SECRET));

    // Sanity check the key was actually "seen" as configured — otherwise
    // this test would trivially pass by never touching the key at all.
    const upstageSection = report.sections.find((s) => s.name === "Upstage");
    const keyCheck = upstageSection.checks.find((c) => c.name === "API key configured");
    assert.equal(keyCheck.status, "pass");
    assert.doesNotMatch(keyCheck.detail, new RegExp(FAKE_SECRET));
  }));
});

test("a fake UPSTAGE_API_KEY value never appears in formatHuman output", () => {
  return withTempDir((dir) => withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    const report = await runDoctorChecks({ cwd: dir });
    assert.doesNotMatch(formatHuman(report), new RegExp(FAKE_SECRET));
  }));
});

test("a fake secret placed in an MCP server env value never appears in either output format", () => {
  // Exercises the Extensions/MCP path specifically — loadMcpServerConfigs
  // reads server `env` blocks that could carry secrets (e.g. an upstream
  // API key passed to the server process); doctor must never echo them.
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "fake-server": {
          command: "this-binary-does-not-exist-doctor-test",
          args: [],
          env: { SOME_SECRET: FAKE_SECRET }
        }
      }
    }));
    const report = await runDoctorChecks({ cwd: dir });
    assert.doesNotMatch(formatJson(report), new RegExp(FAKE_SECRET));
    assert.doesNotMatch(formatHuman(report), new RegExp(FAKE_SECRET));
  });
});

// A dedicated end-to-end capture of `runDoctorCommand`'s real stdout across
// its real `await`s was tried here and dropped: `node --test` runs in-process
// and does its own TAP reporting through `process.stdout.write`, so
// intercepting that global across a real async boundary races with the
// runner's own deferred output and corrupts the TAP stream for *other* tests
// in this file (verified empirically). `formatJson`/`formatHuman` above
// already assert the exact same serialized output is secret-free, and the
// "exits 0" tests below assert `runDoctorCommand`'s real behavior — between
// the two, the CLI path is fully covered without the interference.

// --- a failed MCP server doesn't crash the whole command ---

test("a failed/unreachable MCP server is reported without aborting the rest of the checks", () => {
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "broken-server": { command: "this-binary-does-not-exist-doctor-test", args: [] }
      }
    }));
    const report = await runDoctorChecks({ cwd: dir });

    // Report structure is intact — all six sections still populated.
    assert.deepEqual(report.sections.map((s) => s.name), EXPECTED_SECTIONS);

    const extensions = report.sections.find((s) => s.name === "Extensions");
    const mcpCheck = extensions.checks.find((c) => c.name === "MCP servers");
    assert.ok(mcpCheck, "MCP servers check should be present");
    assert.notEqual(mcpCheck.status, "fail", "a connection failure should be reported as warn, not treated as the check itself throwing");
    assert.match(mcpCheck.detail, /broken-server/);

    // Sections after Extensions (Security, Verification) still ran.
    const security = report.sections.find((s) => s.name === "Security");
    assert.ok(security.checks.length > 0);
    const verification = report.sections.find((s) => s.name === "Verification");
    assert.ok(verification.checks.length > 0);
  });
});

test("runDoctorCommand exits 0 (plain and --json) even with a broken MCP server present", () => {
  return withTempDir((dir) => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: { "broken-server": { command: "this-binary-does-not-exist-doctor-test", args: [] } }
    }));
    return withCwd(dir, async () => {
      const codePlain = await runDoctorCommand([]);
      assert.equal(codePlain, 0);

      const codeJson = await runDoctorCommand(["--json"]);
      assert.equal(codeJson, 0);
    });
  });
});

// --- the uniform check harness itself: a throwing check never crashes the run ---

test("runCheck normalizes a throwing check function to status 'fail' rather than propagating", async () => {
  const result = await runCheck("exploding check", () => {
    throw new Error("boom");
  });
  assert.equal(result.status, "fail");
  assert.match(result.detail, /boom/);
});

test("runCheck normalizes a rejecting async check function to status 'fail' rather than propagating", async () => {
  const result = await runCheck("exploding async check", async () => {
    throw new Error("async boom");
  });
  assert.equal(result.status, "fail");
  assert.match(result.detail, /async boom/);
});

test("runCheck passes through an explicit status/detail from a check function", async () => {
  const result = await runCheck("custom", () => ({ status: "warn", detail: "not ideal" }));
  assert.deepEqual(result, { name: "custom", status: "warn", detail: "not ideal" });
});

// --- both plain and --json exit 0 even with checks failing, no API key, no git, etc. ---

test("runDoctorCommand exits 0 for a bare directory with no git repo, no package.json, no API key", () => {
  return withTempDir((dir) => withEnv({ UPSTAGE_API_KEY: undefined }, () => withCwd(dir, async () => {
    const codePlain = await runDoctorCommand([]);
    assert.equal(codePlain, 0);

    const codeJson = await runDoctorCommand(["--json"]);
    assert.equal(codeJson, 0);

    // Sanity: this bare directory should genuinely produce some non-pass
    // statuses (no git, no API key, no package.json) — otherwise this test
    // wouldn't actually be exercising the "some checks fail" acceptance bar.
    const report = await runDoctorChecks({ cwd: dir });
    const allChecks = report.sections.flatMap((s) => s.checks);
    assert.ok(allChecks.some((c) => c.status !== "pass"), "expected at least one non-pass check in a bare, unconfigured directory");
  })));
});

// --- --help short-circuits without running any checks (fully synchronous — safe to capture) ---

test("runDoctorCommand -h/--help prints usage and exits 0 without running checks", async () => {
  let code;
  const text = captureStdio(() => {
    // runDoctorCommand is async but the --help path never awaits real I/O
    // before resolving, so this synchronous capture window is safe.
    runDoctorCommand(["--help"]).then((c) => { code = c; });
  });
  assert.match(text, /Usage: upstage doctor/);
  // The .then callback above runs on a microtask; give it a tick.
  await Promise.resolve();
  assert.equal(code, 0);
});

// --- 3.3.0 Thread C, Task C.2: Chrome/browser availability check ---

test("Verification section reports a browser (Chrome) check, pass or warn but never crashing the sweep", () => {
  return withTempDir(async (dir) => {
    const report = await runDoctorChecks({ cwd: dir });
    const verification = report.sections.find((s) => s.name === "Verification");
    const browserCheck = verification.checks.find((c) => c.name === "browser (Chrome)");
    assert.ok(browserCheck, "expected a browser (Chrome) check in the Verification section");
    assert.ok(["pass", "warn"].includes(browserCheck.status));
    if (browserCheck.status === "warn") {
      assert.match(browserCheck.detail, /browser install/);
    }
  });
});
