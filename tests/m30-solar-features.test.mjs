import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextReasoningEffort, reasoningEffortLabel } from "../src/ui/reasoning-cycle.mjs";
import { scanKoreanPII, redactKoreanPII } from "../src/permissions/korean-pii-check.mjs";
import { PolicyEngine } from "../src/core/policy/engine.mjs";
import { findAiMarkers, buildWatchPrompt, createWatcher } from "../src/core/watch-mode.mjs";
import { saveRecipe, loadRecipe, renderRecipe, parseRecipeRunArgs, listRecipes } from "../src/core/recipes.mjs";
import { createSession, forkSession } from "../src/runtime/session.mjs";
import { loadUpstageMdFiles } from "../src/core/system-prompt.mjs";
import { UpstageAdapter } from "../src/model/upstage-adapter.mjs";
import { writeFile } from "node:fs/promises";

// ─── 1.1 reasoning_effort ──────────────────────────────────────────────

test("reasoning effort cycles auto -> low -> high -> auto", () => {
  assert.equal(nextReasoningEffort("auto"), "low");
  assert.equal(nextReasoningEffort("low"), "high");
  assert.equal(nextReasoningEffort("high"), "auto");
});

test("UpstageAdapter omits reasoning_effort unless explicitly low/high", () => {
  const a1 = new UpstageAdapter({ apiKey: "x" });
  assert.equal(a1.reasoningEffort, null);
  const a2 = new UpstageAdapter({ apiKey: "x", reasoningEffort: "high" });
  assert.equal(a2.reasoningEffort, "high");
  const a3 = new UpstageAdapter({ apiKey: "x", reasoningEffort: "bogus" });
  assert.equal(a3.reasoningEffort, null);
  a3.setReasoningEffort("low");
  assert.equal(a3.reasoningEffort, "low");
  assert.equal(reasoningEffortLabel("low"), "reason:low");
});

// ─── 2.1 / 2.3 Korean PII + PIPA ────────────────────────────────────────

test("scanKoreanPII verifies RRN checksum, not just shape", () => {
  // Constructed with the real checksum formula (weights [2,3,4,5,6,7,8,9,2,3,4,5]).
  const validRrn = "901231-1234563";
  const invalidRrn = "901231-1234564"; // corrupted check digit
  const found = scanKoreanPII(`user rrn: ${validRrn}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].type, "rrn");
  assert.equal(found[0].verified, true);

  const notVerified = scanKoreanPII(`user rrn: ${invalidRrn}`);
  assert.equal(notVerified[0].verified, false);
});

test("scanKoreanPII verifies business registration number checksum", () => {
  const valid = "123-45-67891"; // constructed with the real checksum formula
  const found = scanKoreanPII(`biz: ${valid}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].type, "bizReg");
  assert.equal(found[0].verified, true);
});

test("redactKoreanPII masks detected matches", () => {
  const redacted = redactKoreanPII("call me at 010-1234-5678 please");
  assert.doesNotMatch(redacted, /010-1234-5678/);
  assert.match(redacted, /\*/);
});

test("PolicyEngine forces confirmation on write calls containing verified PII, with a PIPA flag for network", () => {
  const engine = new PolicyEngine({});
  const validRrn = "901231-1234563";

  const writeDecision = engine.evaluate(
    { name: "write_file", risk: "medium", actionClass: "write" },
    { path: "seed.ts", content: `const rrn = "${validRrn}";` }
  );
  assert.equal(writeDecision.requiresConfirmation, true);
  assert.ok(writeDecision.details.pii);
  assert.equal(writeDecision.details.pii.pipaWarning, false); // write, not network

  const networkDecision = engine.evaluate(
    { name: "web_fetch", risk: "low", actionClass: "network" },
    { url: `https://example.com?rrn=${validRrn}` }
  );
  assert.equal(networkDecision.requiresConfirmation, true);
  assert.equal(networkDecision.details.pii.pipaWarning, true);

  const cleanDecision = engine.evaluate(
    { name: "write_file", risk: "medium", actionClass: "write" },
    { path: "hello.ts", content: "console.log('hi')" }
  );
  assert.equal(cleanDecision.details.pii, null);
});

// ─── 2.2 cost budget ────────────────────────────────────────────────────

test("DEFAULT_LOOP_BUDGET has a maxCostUsd cap", async () => {
  const { DEFAULT_LOOP_BUDGET } = await import("../src/config/defaults.mjs");
  assert.equal(typeof DEFAULT_LOOP_BUDGET.maxCostUsd, "number");
  assert.ok(DEFAULT_LOOP_BUDGET.maxCostUsd > 0);
});

// ─── 3.1 AGENTS.md interop ──────────────────────────────────────────────

test("loadUpstageMdFiles falls back to AGENTS.md when UPSTAGE.md is absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentsmd-"));
  try {
    await writeFile(join(cwd, "AGENTS.md"), "# Agents\nUse pnpm, not npm.");
    const files = loadUpstageMdFiles(cwd);
    assert.ok(files.some((f) => f.content.includes("pnpm")));
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("loadUpstageMdFiles prefers UPSTAGE.md over AGENTS.md at the same directory level", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentsmd-"));
  try {
    await writeFile(join(cwd, "UPSTAGE.md"), "upstage wins");
    await writeFile(join(cwd, "AGENTS.md"), "agents md loses");
    const files = loadUpstageMdFiles(cwd);
    const combined = files.map((f) => f.content).join("\n");
    assert.match(combined, /upstage wins/);
    assert.doesNotMatch(combined, /agents md loses/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ─── 3.2 session forking ────────────────────────────────────────────────

test("forkSession copies history and links parentSessionId", () => {
  const parent = createSession("/repo");
  parent.history.push({ role: "user", content: "hello" });
  parent.toolResults.push({ tool: "read_file", result: {} });

  const child = forkSession(parent);
  assert.notEqual(child.id, parent.id);
  assert.equal(child.parentSessionId, parent.id);
  assert.deepEqual(child.history, parent.history);
  assert.deepEqual(child.toolResults, parent.toolResults);

  // must be a copy, not the same array reference
  child.history.push({ role: "user", content: "second" });
  assert.equal(parent.history.length, 1);
});

// ─── 3.3 watch mode ─────────────────────────────────────────────────────

test("findAiMarkers finds // ai! and # ai? comment triggers", () => {
  const content = [
    "function foo() {}",
    "// ai! fix the off-by-one here",
    "# ai? should this be async",
    "const x = 1;"
  ].join("\n");
  const markers = findAiMarkers(content);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].urgent, true);
  assert.equal(markers[0].note, "fix the off-by-one here");
  assert.equal(markers[1].urgent, false);
});

test("createWatcher detects a marker appended to an already-existing file and fires onTrigger", async () => {
  // Regression test for the real bug found while building this: fs.watch's
  // recursive option enumerates the *entire* subtree before it can start
  // watching (blocks on a real repo with node_modules under it), and even
  // the non-recursive per-directory version only reliably fires on
  // *modification* of an existing file, not creation of a new one — this
  // exercises exactly that real, verified path (append to an existing
  // file), not the unreliable create-a-new-file case.
  const cwd = await mkdtemp(join(tmpdir(), "watch-"));
  try {
    const target = join(cwd, "existing.mjs");
    await writeFile(target, "console.log('pre-existing');\n", "utf8");

    const triggered = await new Promise((resolve, reject) => {
      const watcher = createWatcher({
        cwd,
        debounceMs: 50,
        onTrigger: (evt) => { watcher.close(); resolve(evt); }
      });
      setTimeout(async () => {
        await writeFile(target, "console.log('pre-existing');\n// ai! fix this\n", "utf8");
      }, 300);
      setTimeout(() => { watcher.close(); reject(new Error("onTrigger never fired")); }, 5000);
    });

    assert.equal(triggered.relativePath, "existing.mjs");
    assert.equal(triggered.markers.length, 1);
    assert.equal(triggered.markers[0].note, "fix this");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("buildWatchPrompt includes the file path and marker lines", () => {
  const prompt = buildWatchPrompt({
    relativePath: "src/foo.mjs",
    markers: [{ lineNumber: 5, line: "// ai! do it", note: "do it" }]
  });
  assert.match(prompt, /src\/foo\.mjs/);
  assert.match(prompt, /Line 5/);
});

// ─── 3.4 recipes ────────────────────────────────────────────────────────

test("recipes: save, list, load, and render with param substitution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "recipes-"));
  try {
    await saveRecipe(cwd, "add-endpoint", {
      description: "Add a REST endpoint",
      template: "Add a {{method}} endpoint at {{path}} that returns JSON."
    });

    const listed = await listRecipes(cwd);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "add-endpoint");

    const loaded = await loadRecipe(cwd, "add-endpoint");
    const rendered = renderRecipe(loaded, { method: "GET", path: "/users" });
    assert.equal(rendered, "Add a GET endpoint at /users that returns JSON.");

    // unfilled placeholders are left visible, not silently dropped
    const partial = renderRecipe(loaded, { method: "POST" });
    assert.match(partial, /\{\{path\}\}/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("parseRecipeRunArgs splits name and key=value params", () => {
  const { name, params } = parseRecipeRunArgs(["add-endpoint", "method=GET", "path=/users"]);
  assert.equal(name, "add-endpoint");
  assert.deepEqual(params, { method: "GET", path: "/users" });
});

test("saveRecipe rejects unsafe names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "recipes-"));
  try {
    await assert.rejects(() => saveRecipe(cwd, "../../etc/passwd", { template: "x" }));
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

