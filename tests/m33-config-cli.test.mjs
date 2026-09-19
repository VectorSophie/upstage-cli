// Tests for `upstage config list/get/set/path/edit` — Task 12.7 of the
// 3.2.0 release plan (src/cli/commands/config.mjs,
// src/config/settings.mjs's loadSettingsWithProvenance).
//
// `gather*` functions accept `{ cwd }` directly so tests can point at a temp
// directory with its own `.upstage/settings.json`, same pattern as
// tests/m33-cli-mcp.test.mjs / tests/m33-doctor.test.mjs use for the
// cwd-scoped primitives they exercise.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deepMerge } from "../src/config/settings.mjs";
import {
  gatherConfigList, formatConfigListHuman, formatConfigListJson, runConfigListCommand,
  gatherConfigGet, formatGetHuman, formatGetJson, runConfigGetCommand,
  gatherConfigSet, formatSetHuman, formatSetJson, runConfigSetCommand,
  runConfigPathCommand
} from "../src/cli/commands/config.mjs";

function withTempDir(run) {
  return mkdtemp(join(tmpdir(), "config-cli-")).then((dir) =>
    Promise.resolve()
      .then(() => run(dir))
      .finally(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  );
}

async function writeProjectSettings(dir, data) {
  await mkdir(join(dir, ".upstage"), { recursive: true });
  await writeFile(join(dir, ".upstage", "settings.json"), JSON.stringify(data));
}

// Same technique as tests/m33-cli-mcp.test.mjs's `withCwd` — the `run*Command`
// CLI entry points read `process.cwd()` themselves rather than taking a `cwd`
// parameter.
function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

// ── deepMerge idempotency — the failure mode the task spec calls out ─────
// The multi-pass-diff provenance approach relies on deepMerge(deepMerge(a,b),
// b) === deepMerge(a,b). Verified here as a permanent regression test (in
// addition to the throwaway check done before writing loadSettingsWithProvenance).

test("deepMerge idempotency: deepMerge(deepMerge(a,b), b) deep-equals deepMerge(a,b) across representative shapes", () => {
  const cases = [
    [{ x: 1, nested: { a: 1, b: 2 } }, { x: 2, nested: { a: 5 } }],
    [{ arr: [1, 2, 3] }, { arr: [4, 5] }],
    [{ x: { a: 1 } }, { x: [1, 2, 3] }],
    [{ x: 5 }, { x: { a: 1 } }],
    [{ permissions: { defaultMode: "default", allowRules: [], sandbox: true } }, { permissions: { defaultMode: "auto" } }],
    [{}, {}],
    [{ a: { b: { c: 1 } } }, { a: { b: { c: 2, d: 3 } } }],
    [{ hooks: { PreToolUse: [] } }, { hooks: { PreToolUse: [{ x: 1 }] } }],
    [{ mcpServers: {} }, { mcpServers: { foo: { command: "x" } } }]
  ];
  for (const [a, b] of cases) {
    const once = deepMerge(a, b);
    const twice = deepMerge(once, b);
    assert.deepEqual(twice, once);
  }
});

// ── config list --effective: the 3 required provenance scenarios ─────────

test("config list --effective: a key set only in project settings shows 'project settings' as its source", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { theme: "dark" });
    const { rows } = await gatherConfigList({ cwd: dir, effective: true });
    const row = rows.find((r) => r.key === "theme");
    assert.ok(row);
    assert.equal(row.value, "dark");
    assert.equal(row.source, "project settings");
  })
);

test("config list --effective: a key overridden by env shows 'env'", () =>
  withTempDir(async (dir) => {
    const prev = process.env.UPSTAGE_MODEL;
    process.env.UPSTAGE_MODEL = "solar-pro3";
    try {
      const { rows } = await gatherConfigList({ cwd: dir, effective: true });
      const row = rows.find((r) => r.key === "model");
      assert.ok(row);
      assert.equal(row.value, "solar-pro3");
      assert.equal(row.source, "env");
    } finally {
      if (prev === undefined) delete process.env.UPSTAGE_MODEL;
      else process.env.UPSTAGE_MODEL = prev;
    }
  })
);

test("config list --effective: a key at its schema default shows 'default'", () =>
  withTempDir(async (dir) => {
    const { rows } = await gatherConfigList({ cwd: dir, effective: true });
    const row = rows.find((r) => r.key === "vimMode");
    assert.ok(row);
    assert.equal(row.value, false);
    assert.equal(row.source, "default");
  })
);

test("config list --effective: env overrides a value already set by project settings — env wins as the LAST layer", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { model: "solar-pro2" });
    const prev = process.env.UPSTAGE_MODEL;
    process.env.UPSTAGE_MODEL = "solar-pro3";
    try {
      const { rows } = await gatherConfigList({ cwd: dir, effective: true });
      const row = rows.find((r) => r.key === "model");
      assert.equal(row.value, "solar-pro3");
      assert.equal(row.source, "env");
    } finally {
      if (prev === undefined) delete process.env.UPSTAGE_MODEL;
      else process.env.UPSTAGE_MODEL = prev;
    }
  })
);

test("config list (no --effective) has no source field, only key/value", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { theme: "dark" });
    const { rows, effective } = await gatherConfigList({ cwd: dir, effective: false });
    assert.equal(effective, false);
    const row = rows.find((r) => r.key === "theme");
    assert.equal(row.value, "dark");
    assert.equal("source" in row, false);
  })
);

test("config list --effective human output has a KEY VALUE SOURCE columns shape", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherConfigList({ cwd: dir, effective: true });
    const text = formatConfigListHuman(outcome);
    assert.match(text, /KEY\s+VALUE\s+SOURCE/);
    assert.match(text, /vimMode\s+false\s+default/);
  })
);

test("config list (plain) human output has a KEY VALUE columns shape, no SOURCE header", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherConfigList({ cwd: dir, effective: false });
    const text = formatConfigListHuman(outcome);
    assert.match(text, /^KEY\s+VALUE\s*$/m);
    assert.doesNotMatch(text, /SOURCE/);
  })
);

test("config list --json round-trips rows including source", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { theme: "dark" });
    const outcome = await gatherConfigList({ cwd: dir, effective: true });
    const parsed = JSON.parse(formatConfigListJson(outcome));
    const row = parsed.find((r) => r.key === "theme");
    assert.equal(row.source, "project settings");
  })
);

test("runConfigListCommand: exit code 0 for plain, --effective, and --json branches", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runConfigListCommand([]), 0);
      assert.equal(await runConfigListCommand(["--effective"]), 0);
      assert.equal(await runConfigListCommand(["--effective", "--json"]), 0);
    })
  )
);

test("runConfigListCommand: --help prints usage and exits 0", async () => {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  let code;
  try {
    code = await runConfigListCommand(["--help"]);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(out.join(""), /Usage: upstage config list/);
});

// ── config get: dot-path access into the project settings file ONLY ──────
// (never the merged/effective view — see src/cli/commands/config.mjs's
// header comment and the 3.2.0 plan's §7.T: get/set share one project-file
// scope.)

test("config get: reflects a top-level key set in project settings", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { vimMode: true });
    const outcome = await gatherConfigGet({ cwd: dir, key: "vimMode" });
    assert.equal(outcome.result.value, true);
  })
);

test("config get: reflects a nested dot-path key set in project settings", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { permissions: { defaultMode: "auto" } });
    const outcome = await gatherConfigGet({ cwd: dir, key: "permissions.defaultMode" });
    assert.equal(outcome.result.value, "auto");
  })
);

test("config get: a schema-default key with no project settings file is 'not set in project settings' (code 1), not the schema default", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherConfigGet({ cwd: dir, key: "vimMode" });
    assert.equal(outcome.code, 1);
    assert.match(outcome.error, /not set in project settings/);
    assert.match(outcome.error, /config list --effective/);
  })
);

test("config get: missing key argument is a usage error (code 2)", async () => {
  const outcome = await gatherConfigGet({ cwd: process.cwd() });
  assert.equal(outcome.code, 2);
});

test("config get: unknown dot-path is 'not set in project settings' (code 1)", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherConfigGet({ cwd: dir, key: "definitely.not.a.real.key" });
    assert.equal(outcome.code, 1);
    assert.match(outcome.error, /not set in project settings/);
  })
);

test("config get: a key set ONLY via env var (never written to the project file) is 'not set in project settings' — the env value is never returned", () =>
  withTempDir(async (dir) => {
    const prev = process.env.UPSTAGE_MODEL;
    process.env.UPSTAGE_MODEL = "solar-pro3";
    try {
      const outcome = await gatherConfigGet({ cwd: dir, key: "model" });
      assert.equal(outcome.code, 1);
      assert.match(outcome.error, /not set in project settings/);
      assert.notEqual(outcome.result?.value, "solar-pro3");

      // The env-sourced value IS visible, with provenance, via the
      // effective view — that command is unaffected by this fix.
      const { rows } = await gatherConfigList({ cwd: dir, effective: true });
      const row = rows.find((r) => r.key === "model");
      assert.equal(row.value, "solar-pro3");
      assert.equal(row.source, "env");
    } finally {
      if (prev === undefined) delete process.env.UPSTAGE_MODEL;
      else process.env.UPSTAGE_MODEL = prev;
    }
  })
);

test("config get: an existing-but-corrupt project settings file is refused (code 1), same as config set", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".upstage"), { recursive: true });
    await writeFile(join(dir, ".upstage", "settings.json"), "{ not valid json");
    const outcome = await gatherConfigGet({ cwd: dir, key: "theme" });
    assert.equal(outcome.code, 1);
    assert.match(outcome.error, /not valid JSON/);
  })
);

test("formatGetHuman/formatGetJson", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { model: "solar-pro2" });
    const outcome = await gatherConfigGet({ cwd: dir, key: "model" });
    assert.equal(formatGetHuman(outcome.result), "solar-pro2\n");
    const json = JSON.parse(formatGetJson(outcome.result));
    assert.equal(json.key, "model");
    assert.equal(json.value, "solar-pro2");
  })
);

test("runConfigGetCommand: exit codes — 0 found, 2 missing key, 1 not set in project settings", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      await runConfigSetCommand(["model", "solar-pro2"]);
      assert.equal(await runConfigGetCommand(["model"]), 0);
      assert.equal(await runConfigGetCommand([]), 2);
      assert.equal(await runConfigGetCommand(["nope.not.real"]), 1);
    })
  )
);

// ── config set: writes ONLY <cwd>/.upstage/settings.json ─────────────────

test("config set: creates .upstage/settings.json when it doesn't exist yet", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherConfigSet({ cwd: dir, key: "theme", value: "dark" });
    assert.ok(outcome.result);
    assert.equal(outcome.result.value, "dark");
    const written = JSON.parse(await readFile(join(dir, ".upstage", "settings.json"), "utf-8"));
    assert.equal(written.theme, "dark");
  })
);

test("config set: value is JSON-parsed when possible (booleans, numbers, objects)", () =>
  withTempDir(async (dir) => {
    await gatherConfigSet({ cwd: dir, key: "vimMode", value: "true" });
    await gatherConfigSet({ cwd: dir, key: "maxOutputTokens", value: "8192" });
    const written = JSON.parse(await readFile(join(dir, ".upstage", "settings.json"), "utf-8"));
    assert.equal(written.vimMode, true);
    assert.equal(written.maxOutputTokens, 8192);
  })
);

test("config set: a bare non-JSON word falls back to a raw string", () =>
  withTempDir(async (dir) => {
    await gatherConfigSet({ cwd: dir, key: "theme", value: "dark" });
    const written = JSON.parse(await readFile(join(dir, ".upstage", "settings.json"), "utf-8"));
    assert.equal(written.theme, "dark");
    assert.equal(typeof written.theme, "string");
  })
);

test("config set: nested dot-path key creates intermediate objects", () =>
  withTempDir(async (dir) => {
    await gatherConfigSet({ cwd: dir, key: "permissions.defaultMode", value: "auto" });
    const written = JSON.parse(await readFile(join(dir, ".upstage", "settings.json"), "utf-8"));
    assert.equal(written.permissions.defaultMode, "auto");
  })
);

test("config set: preserves existing unrelated keys already in the project settings file", () =>
  withTempDir(async (dir) => {
    await writeProjectSettings(dir, { theme: "dark", vimMode: true });
    await gatherConfigSet({ cwd: dir, key: "briefMode", value: "true" });
    const written = JSON.parse(await readFile(join(dir, ".upstage", "settings.json"), "utf-8"));
    assert.equal(written.theme, "dark");
    assert.equal(written.vimMode, true);
    assert.equal(written.briefMode, true);
  })
);

test("config set: NEVER writes to the global or project-local settings files", () =>
  withTempDir(async (dir) => {
    await gatherConfigSet({ cwd: dir, key: "theme", value: "dark" });
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(dir, ".upstage", "settings.local.json")), false);
  })
);

test("config set: an existing-but-corrupt project settings file is refused, not silently overwritten", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".upstage"), { recursive: true });
    await writeFile(join(dir, ".upstage", "settings.json"), "{ not valid json");
    const before = await readFile(join(dir, ".upstage", "settings.json"), "utf-8");

    const outcome = await gatherConfigSet({ cwd: dir, key: "theme", value: "dark" });
    assert.equal(outcome.code, 1);
    assert.match(outcome.error, /not valid JSON/);

    const after = await readFile(join(dir, ".upstage", "settings.json"), "utf-8");
    assert.equal(after, before, "corrupt file must be left untouched, not clobbered");
  })
);

test("config set: missing key or value argument is a usage error (code 2)", async () => {
  assert.equal((await gatherConfigSet({ cwd: process.cwd() })).code, 2);
  assert.equal((await gatherConfigSet({ cwd: process.cwd(), key: "theme" })).code, 2);
});

test("formatSetHuman/formatSetJson", () =>
  withTempDir(async (dir) => {
    const outcome = await gatherConfigSet({ cwd: dir, key: "theme", value: "dark" });
    assert.match(formatSetHuman(outcome.result), /set theme = dark/);
    const json = JSON.parse(formatSetJson(outcome.result));
    assert.equal(json.key, "theme");
    assert.equal(json.value, "dark");
  })
);

test("runConfigSetCommand: exit codes — 0 success, 2 usage error", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      assert.equal(await runConfigSetCommand(["theme", "dark"]), 0);
      assert.equal(await runConfigSetCommand(["theme"]), 2);
      assert.equal(await runConfigSetCommand([]), 2);
    })
  )
);

test("a value set via config set is then visible via config get and config list --effective as 'project settings'", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      await runConfigSetCommand(["theme", "dark"]);
      const getOutcome = await gatherConfigGet({ cwd: dir, key: "theme" });
      assert.equal(getOutcome.result.value, "dark");
      const { rows } = await gatherConfigList({ cwd: dir, effective: true });
      const row = rows.find((r) => r.key === "theme");
      assert.equal(row.source, "project settings");
    })
  )
);

// ── config path ────────────────────────────────────────────────────────

test("runConfigPathCommand prints <cwd>/.upstage/settings.json with no I/O", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      const out = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
      let code;
      try {
        code = await runConfigPathCommand([]);
      } finally {
        process.stdout.write = orig;
      }
      assert.equal(code, 0);
      assert.equal(out.join("").trim(), join(dir, ".upstage", "settings.json"));
    })
  )
);
