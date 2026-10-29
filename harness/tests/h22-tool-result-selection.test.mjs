// CPU unit tests for the tool-result-selection evaluator. Synthetic traces (no
// Docker, no model): proves the evaluator requires the EXACT execution, parses
// the run's own JSON, and rejects wrong-field / whole-stdout / hardcoded /
// stderr-only / no-execution attempts.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toolResultSelection, applySelector } from "../src/evaluation/evaluators.mjs";

const TOK = (c) => "BV1H-" + c.repeat(32); // c must be a single hex char
const API = TOK("a"), DB = TOK("b"), CACHE = TOK("c");

function stdoutJson() {
  return JSON.stringify({ services: [{ name: "api", port: API }, { name: "db", port: DB }, { name: "cache", port: CACHE }] }) + "\n";
}
function trace(stdout, { command = "node /opt/bench/tr1.mjs", ok = true, code = 0, timedOut = false, truncated = false } = {}) {
  return [{ tool: "run_shell", args: { command }, resultData: { ok, code, stdout, stderr: "", timedOut, truncated } }];
}
const CFG = {
  command: "node /opt/bench/tr1.mjs",
  outputFile: "out.txt",
  tokenPattern: "BV1H-[0-9a-f]{32}",
  selector: { kind: "find-field", listPath: ["services"], matchKey: "name", matchValue: "api", valueKey: "port" }
};
const check = { id: "sel", evaluator: "tool-result-selection", config: CFG };

let wd;
beforeEach(() => { wd = mkdtempSync(join(tmpdir(), "h22-")); });
afterEach(() => { rmSync(wd, { recursive: true, force: true }); });
const run = (written, tr) => { if (written !== null) writeFileSync(join(wd, "out.txt"), written); return toolResultSelection(check, { workdir: wd, trace: tr }); };

describe("tool-result-selection — selector unit", () => {
  it("find-field / max-by / indirect resolve correctly", () => {
    const j = JSON.parse(stdoutJson());
    assert.equal(applySelector(j, CFG.selector), API);
    assert.equal(applySelector({ items: [{ id: "a", score: 1 }, { id: "b", score: 9 }] }, { kind: "max-by", listPath: ["items"], valueKey: "score", returnKey: "id" }), "b");
    assert.equal(applySelector({ primary: "db", ports: { api: "x", db: "y" } }, { kind: "indirect", keyPath: ["primary"], mapPath: ["ports"] }), "y");
  });
});

describe("tool-result-selection — acceptance", () => {
  it("passes when the correctly-selected field is written", () => {
    assert.equal(run(API, trace(stdoutJson())).passed, true);
  });
  it("REJECTS the wrong field (db port)", () => {
    assert.equal(run(DB, trace(stdoutJson())).passed, false);
  });
  it("REJECTS copying the whole stdout", () => {
    assert.equal(run(stdoutJson().trim(), trace(stdoutJson())).passed, false);
  });
  it("REJECTS a hardcoded/guessed token not in the output", () => {
    assert.equal(run(TOK("e"), trace(stdoutJson())).passed, false);
  });
  it("REJECTS when the exact command never ran", () => {
    assert.equal(run(API, trace(stdoutJson(), { command: "node /opt/bench/tr1.mjs --verbose" })).passed, false);
    assert.equal(run(API, []).passed, false);
  });
  it("REJECTS a failed / non-zero / timed-out / truncated execution", () => {
    assert.equal(run(API, trace(stdoutJson(), { ok: false, code: 1 })).passed, false);
    assert.equal(run(API, trace(stdoutJson(), { timedOut: true })).passed, false);
    assert.equal(run(API, trace(stdoutJson(), { truncated: true })).passed, false);
  });
  it("REJECTS a token delivered only on stderr (no structured stdout)", () => {
    const tr = [{ tool: "run_shell", args: { command: CFG.command }, resultData: { ok: true, code: 0, stdout: "", stderr: stdoutJson(), timedOut: false, truncated: false } }];
    assert.equal(run(API, tr).passed, false);
  });
  it("REJECTS when out.txt is missing", () => {
    assert.equal(run(null, trace(stdoutJson())).passed, false);
  });
  it("accepts the api port from whichever qualifying run the agent used (multiple runs)", () => {
    const run1 = stdoutJson();
    const otherApi = TOK("d");
    const run2 = JSON.stringify({ services: [{ name: "api", port: otherApi }, { name: "db", port: DB }] }) + "\n";
    const tr = [...trace(run1), ...trace(run2)];
    assert.equal(run(otherApi, tr).passed, true);
    assert.equal(run(API, tr).passed, true);
    // but never a non-api port
    writeFileSync(join(wd, "out.txt"), DB);
    assert.equal(toolResultSelection(check, { workdir: wd, trace: tr }).passed, false);
  });
});
