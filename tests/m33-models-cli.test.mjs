// Tests for `upstage models list/info` — Task 7.16 of the 3.2.0 release
// plan (src/cli/commands/models.mjs), plus the `/model` TUI command
// (src/ui/commands.mjs) and `-e`/`--reasoning-effort` CLI flag +
// `/effort` TUI command (Task 7.17).

import test from "node:test";
import assert from "node:assert/strict";

import {
  listModelCapabilities,
  getModelInfo,
  formatModelListHuman,
  formatModelListJson,
  runModelsListCommand,
  runModelsInfoCommand
} from "../src/cli/commands/models.mjs";
import { getModelCapabilities } from "../src/model/model-capabilities.mjs";
import { dispatch } from "../src/cli/router.mjs";
import { COMMANDS as UI_COMMANDS, executeCommand } from "../src/ui/commands.mjs";
import { parseCliArgs } from "../src/config/cli-args.mjs";

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  return {
    out, err,
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  };
}

// ── listModelCapabilities()/getModelInfo() — the shared source of truth ──

test("listModelCapabilities includes solar-pro4/solar-pro3/solar-pro2 with the exact capability flags from model-capabilities.mjs", () => {
  const rows = listModelCapabilities();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  for (const id of ["solar-pro4", "solar-pro3", "solar-pro2"]) {
    assert.ok(byId[id], `expected a row for ${id}`);
    const caps = getModelCapabilities(id);
    assert.equal(byId[id].contextLimit, caps.contextLimit);
    assert.equal(byId[id].supportsReasoningEffort, caps.supportsReasoningEffort);
    assert.equal(byId[id].supportsParallelToolCalls, caps.supportsParallelToolCalls);
    assert.equal(byId[id].supportsResponseFormat, caps.supportsResponseFormat);
    assert.equal(byId[id].provider, "upstage");
  }
});

test("listModelCapabilities marks exactly one row isDefault (solar-pro4, absent UPSTAGE_MODEL override)", () => {
  const original = process.env.UPSTAGE_MODEL;
  delete process.env.UPSTAGE_MODEL;
  try {
    const rows = listModelCapabilities();
    const defaults = rows.filter((r) => r.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, "solar-pro4");
  } finally {
    if (original === undefined) delete process.env.UPSTAGE_MODEL;
    else process.env.UPSTAGE_MODEL = original;
  }
});

test("listModelCapabilities respects UPSTAGE_MODEL for isDefault", () => {
  const original = process.env.UPSTAGE_MODEL;
  process.env.UPSTAGE_MODEL = "solar-pro2";
  try {
    const rows = listModelCapabilities();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId["solar-pro2"].isDefault, true);
    assert.equal(byId["solar-pro4"].isDefault, false);
  } finally {
    if (original === undefined) delete process.env.UPSTAGE_MODEL;
    else process.env.UPSTAGE_MODEL = original;
  }
});

test("getModelInfo returns the same row listModelCapabilities does, case-insensitively", () => {
  const row = getModelInfo("Solar-Pro4");
  const listed = listModelCapabilities().find((r) => r.id === "solar-pro4");
  assert.deepEqual(row, listed);
});

test("getModelInfo throws a clear 'unknown model' error for an unrecognized id", () => {
  assert.throws(() => getModelInfo("gpt-99-turbo"), /Unknown model: "gpt-99-turbo"/);
});

test("getModelInfo throws for a real-but-fallback-only provider model id (solar-mini) — never silently presents Pro2's numbers as solar-mini's", () => {
  assert.throws(() => getModelInfo("solar-mini"), /Unknown model: "solar-mini"/);
});

// ── formatting ────────────────────────────────────────────────────────────

test("formatModelListHuman: header + one row per model, DEFAULT column marks solar-pro4", () => {
  const text = formatModelListHuman(listModelCapabilities());
  assert.match(text, /ID\s+PROVIDER\s+CONTEXT\s+REASONING\s+PARALLEL\s+RESP_FORMAT\s+DEFAULT/);
  assert.match(text, /solar-pro4/);
  assert.match(text, /solar-pro3/);
  assert.match(text, /solar-pro2/);
});

test("formatModelListJson round-trips to an array with all required fields", () => {
  const parsed = JSON.parse(formatModelListJson(listModelCapabilities()));
  assert.ok(Array.isArray(parsed));
  for (const row of parsed) {
    for (const field of [
      "id", "provider", "contextLimit", "supportsReasoningEffort",
      "supportsParallelToolCalls", "supportsResponseFormat", "isDefault"
    ]) {
      assert.ok(field in row, `expected field "${field}" on row ${JSON.stringify(row)}`);
    }
  }
});

// ── CLI entry points ─────────────────────────────────────────────────────

test("runModelsListCommand --json includes solar-pro4/solar-pro3/solar-pro2", async () => {
  const io = captureStdio();
  try {
    const code = await runModelsListCommand(["--json"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(io.out.join(""));
    const ids = parsed.map((r) => r.id);
    assert.ok(ids.includes("solar-pro4"));
    assert.ok(ids.includes("solar-pro3"));
    assert.ok(ids.includes("solar-pro2"));
  } finally {
    io.restore();
  }
});

test("runModelsListCommand --help prints usage and exits 0", async () => {
  const io = captureStdio();
  try {
    const code = await runModelsListCommand(["--help"]);
    assert.equal(code, 0);
    assert.match(io.out.join(""), /Usage: upstage models list/);
  } finally {
    io.restore();
  }
});

test("runModelsInfoCommand <model>: real exit codes — 0 for a known model, 2 for unknown/missing", async () => {
  const io = captureStdio();
  try {
    assert.equal(await runModelsInfoCommand(["solar-pro4"]), 0);
    assert.match(io.out.join(""), /id: solar-pro4/);
    io.out.length = 0;

    assert.equal(await runModelsInfoCommand(["not-a-model"]), 2);
    assert.match(io.err.join(""), /Unknown model: "not-a-model"/);

    assert.equal(await runModelsInfoCommand([]), 2);
  } finally {
    io.restore();
  }
});

test("runModelsInfoCommand --json outputs the same row getModelInfo returns", async () => {
  const io = captureStdio();
  try {
    const code = await runModelsInfoCommand(["solar-pro4", "--json"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(io.out.join(""));
    assert.deepEqual(parsed, getModelInfo("solar-pro4"));
  } finally {
    io.restore();
  }
});

// ── router wiring ─────────────────────────────────────────────────────────

test("dispatch(['models', 'list', '--json']) is wired through the router, not a stub", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["models", "list", "--json"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(io.out.join(""));
    assert.ok(parsed.some((r) => r.id === "solar-pro4"));
  } finally {
    io.restore();
  }
});

test("dispatch(['models', 'info', 'solar-pro4']) is wired through the router", async () => {
  const io = captureStdio();
  try {
    const code = await dispatch(["models", "info", "solar-pro4"]);
    assert.equal(code, 0);
    assert.match(io.out.join(""), /id: solar-pro4/);
  } finally {
    io.restore();
  }
});

// ── /model TUI command — "same function, no drift" (Task 7.16 acceptance) ─

test("TUI /model output matches `upstage models info <active-model>`'s output exactly", async () => {
  const io = captureStdio();
  let cliOutput;
  try {
    await runModelsInfoCommand(["solar-pro4"]);
    cliOutput = io.out.join("").trimEnd();
  } finally {
    io.restore();
  }

  const result = await executeCommand("/model", { model: "solar-pro4" });
  assert.equal(result.response, cliOutput);
});

test("/model on an unknown active model returns the clear unknown-model error, not a crash", async () => {
  const result = await executeCommand("/model", { model: "totally-bogus-model" });
  assert.match(result.response, /Unknown model: "totally-bogus-model"/);
});

test("/model is registered in COMMANDS with a description", () => {
  assert.ok(UI_COMMANDS["/model"]);
  assert.equal(typeof UI_COMMANDS["/model"].description, "string");
});

// ── /effort TUI command (Task 7.17) ────────────────────────────────────────

test("/effort <level> validates then calls setReasoningEffort() on the live adapter — no restart needed", async () => {
  let lastSet = null;
  const fakeAdapter = { setReasoningEffort(v) { lastSet = v; } };

  const result = await executeCommand("/effort medium", { model: "solar-pro4", _adapter: fakeAdapter });
  assert.match(result.response, /medium/);
  assert.equal(lastSet, "medium");
});

test("/effort rejects an invalid level client-side without touching the adapter", async () => {
  let called = false;
  const fakeAdapter = { setReasoningEffort() { called = true; } };

  const result = await executeCommand("/effort not-a-real-level", { model: "solar-pro4", _adapter: fakeAdapter });
  assert.match(result.response, /Invalid reasoning effort level/);
  assert.equal(called, false);
});

test("/effort rejects a level on a model that doesn't support reasoning-effort control, without touching the adapter", async () => {
  let called = false;
  const fakeAdapter = { setReasoningEffort() { called = true; } };

  const result = await executeCommand("/effort high", { model: "solar-pro2", _adapter: fakeAdapter });
  assert.match(result.response, /does not support explicit reasoning-effort control/);
  assert.equal(called, false);
});

test("/effort with no argument shows usage, does not touch the adapter", async () => {
  let called = false;
  const fakeAdapter = { setReasoningEffort() { called = true; } };
  const result = await executeCommand("/effort", { model: "solar-pro4", _adapter: fakeAdapter });
  assert.match(result.response, /\/effort/);
  assert.equal(called, false);
});

// ── -e/--reasoning-effort CLI flag ─────────────────────────────────────────

test("parseCliArgs recognizes -e/--reasoning-effort", () => {
  assert.equal(parseCliArgs(["-e", "high", "-p", "hi"]).reasoningEffort, "high");
  assert.equal(parseCliArgs(["--reasoning-effort", "medium", "-p", "hi"]).reasoningEffort, "medium");
  assert.equal(parseCliArgs(["-p", "hi"]).reasoningEffort, null);
});
