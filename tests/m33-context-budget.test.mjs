import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContextBudget, computeLiveContextBreakdown } from "../src/agent/context-budget.mjs";
import { runContextCommand, formatContextBudgetHuman, formatContextBudgetJson } from "../src/cli/commands/context.mjs";
import { dispatch } from "../src/cli/router.mjs";
import { executeCommand } from "../src/ui/commands.mjs";
import { createRegistry } from "../src/tools/create-registry.mjs";
import { ContextManager } from "../src/core/context-manager.mjs";
import { estimateTokens } from "../src/core/context-manager.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upstage-context-budget-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function withCwd(dir, run) {
  const original = process.cwd;
  process.cwd = () => dir;
  return Promise.resolve().then(run).finally(() => { process.cwd = original; });
}

function captureStdio(run) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    run();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out: out.join(""), err: err.join("") };
}

const SHORT_UPSTAGE_MD = "Short project note.\n";
const LONG_UPSTAGE_MD = "A much longer line of project instructions repeated many times over. ".repeat(50);

function seedFixtureRepo(dir, upstageMd) {
  writeFileSync(join(dir, "UPSTAGE.md"), upstageMd);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "src", "util.mjs"), "export function double(x) {\n  return x * 2;\n}\n");
}

// ─── computeContextBudget (repo-level) ─────────────────────────────────────

test("computeContextBudget reports non-zero counts for every category against a fixture repo with a known UPSTAGE.md", () =>
  withTempDir(async (dir) => {
    seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
    const budget = await computeContextBudget({ cwd: dir, model: "solar-pro3" });

    assert.ok(budget.systemPromptTokens > 0, "systemPromptTokens should be non-zero");
    assert.ok(budget.toolsTokens > 0, "toolsTokens should be non-zero (36 builtin tools always registered)");
    assert.equal(budget.mcpTokens, 0, "no .mcp.json configured — mcpTokens should be exactly 0");
    assert.ok(budget.projectInstructionsTokens > 0, "projectInstructionsTokens should be non-zero (UPSTAGE.md present)");
    assert.ok(budget.repoMapTokens > 0, "repoMapTokens should be non-zero (src/*.mjs present)");
    assert.equal(budget.contextLimit, 65536, "solar-pro3's contextLimit from model-capabilities.mjs");
  })
);

test("computeContextBudget's projectInstructionsTokens is proportionate to UPSTAGE.md content length", () =>
  withTempDir(async (dir) => {
    seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
    const short = await computeContextBudget({ cwd: dir, model: "solar-pro3" });

    seedFixtureRepo(dir, LONG_UPSTAGE_MD);
    const long = await computeContextBudget({ cwd: dir, model: "solar-pro3" });

    assert.ok(
      long.projectInstructionsTokens > short.projectInstructionsTokens * 10,
      `expected long UPSTAGE.md (${long.projectInstructionsTokens} tokens) to be well over 10x short (${short.projectInstructionsTokens} tokens)`
    );
    // Every other category should be unaffected by UPSTAGE.md content length.
    assert.equal(long.toolsTokens, short.toolsTokens);
    assert.equal(long.repoMapTokens, short.repoMapTokens);
  })
);

test("computeContextBudget resolves contextLimit from the requested model, defaulting via settings when omitted", () =>
  withTempDir(async (dir) => {
    seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
    const pro4 = await computeContextBudget({ cwd: dir, model: "solar-pro4" });
    assert.equal(pro4.contextLimit, 512_000);

    const pro2 = await computeContextBudget({ cwd: dir, model: "solar-pro2" });
    assert.equal(pro2.contextLimit, 65_536);
  })
);

test("computeContextBudget's projectInstructionsTokens matches estimateTokens() on the same merged UPSTAGE.md content — the single shared heuristic, not a second implementation", () =>
  withTempDir(async (dir) => {
    seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
    const budget = await computeContextBudget({ cwd: dir, model: "solar-pro3" });
    assert.equal(budget.projectInstructionsTokens, estimateTokens(SHORT_UPSTAGE_MD));
  })
);

// ─── computeLiveContextBreakdown (live-session) ────────────────────────────

test("computeLiveContextBreakdown's categories sum to contextLimit within a small tolerance", () =>
  withTempDir(async (dir) => {
    seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
    const registry = createRegistry({});
    const contextManager = new ContextManager(65_536, 0.8);
    const messages = [
      { role: "user", content: "Hello, please help me write a function." },
      { role: "assistant", content: "Sure thing — here is the function you asked for." }
    ];
    const state = {
      messages,
      model: "solar-pro2",
      _contextManager: contextManager,
      _registry: registry,
      _session: { workspace: { cwd: dir } },
      _skillsLoader: null
    };

    const b = await computeLiveContextBreakdown(messages, state);

    assert.ok(b.conversationTokens > 0, "conversationTokens should reflect the seeded messages");
    assert.equal(b.conversationTokens, contextManager.getTokenCount(messages), "must match /compact's/`/cost`'s own ContextManager.getTokenCount()");
    assert.ok(b.toolsTokens > 0);
    assert.ok(b.projectInstructionsTokens > 0);

    const sum = b.systemPromptTokens + b.toolsTokens + b.mcpTokens + b.projectInstructionsTokens +
      b.skillsTokens + b.repoMapTokens + b.conversationTokens + b.freeSpaceTokens;
    assert.ok(Math.abs(sum - b.contextLimit) <= 2, `sum of all categories (${sum}) should be within tolerance of contextLimit (${b.contextLimit})`);
    assert.equal(b.contextLimit, 65_536, "should use the live ContextManager's own maxTokens, not a freshly resolved one");
  })
);

test("computeLiveContextBreakdown degrades gracefully with no _registry/_contextManager (never throws)", async () => {
  const state = { messages: [], model: "solar-pro2", _session: { workspace: { cwd: process.cwd() } } };
  const b = await computeLiveContextBreakdown([], state);
  assert.equal(b.toolsTokens, 0);
  assert.equal(b.conversationTokens, 0);
  assert.ok(b.contextLimit > 0);
  assert.equal(b.freeSpaceTokens, b.contextLimit);
});

// ─── `upstage context` CLI ─────────────────────────────────────────────────

test("runContextCommand exits 0 (plain and --json) against a fixture repo", () =>
  withTempDir((dir) => {
    seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
    return withCwd(dir, async () => {
      assert.equal(await runContextCommand([]), 0);
      assert.equal(await runContextCommand(["--json"]), 0);
    });
  })
);

test("runContextCommand -h/--help prints usage and exits 0", async () => {
  let code;
  const { out } = captureStdio(() => {
    runContextCommand(["--help"]).then((c) => { code = c; });
  });
  assert.match(out, /Usage: upstage context/);
  await Promise.resolve();
  assert.equal(code, 0);
});

test("formatContextBudgetJson round-trips the budget object", () => {
  const budget = {
    systemPromptTokens: 10, toolsTokens: 20, mcpTokens: 0,
    projectInstructionsTokens: 5, skillsTokens: 0, repoMapTokens: 15,
    contextLimit: 1000
  };
  const parsed = JSON.parse(formatContextBudgetJson(budget));
  assert.deepEqual(parsed, budget);
});

test("formatContextBudgetHuman mentions every category and the context limit", () => {
  const budget = {
    systemPromptTokens: 10, toolsTokens: 20, mcpTokens: 0,
    projectInstructionsTokens: 5, skillsTokens: 0, repoMapTokens: 15,
    contextLimit: 1000
  };
  const text = formatContextBudgetHuman(budget);
  for (const label of ["System prompt", "Builtin tools", "MCP tools", "Project instructions", "Skills", "Repo map", "Context limit"]) {
    assert.match(text, new RegExp(label));
  }
});

// ─── router wiring: dispatch() reaches the real handler, not the stub ─────

test("router: dispatch reaches the real `context` handler, not the generic stub", () =>
  withTempDir((dir) =>
    withCwd(dir, async () => {
      seedFixtureRepo(dir, SHORT_UPSTAGE_MD);
      const io = captureStdio(() => {});
      const code = await dispatch(["context", "--json"]);
      assert.equal(code, 0);
    })
  )
);

// ─── TUI `/context` and `/memory` alias ────────────────────────────────────

test("/context returns a live breakdown mentioning every Claude-Code-parity category", () =>
  withTempDir(async (dir) => {
    const registry = createRegistry({});
    const contextManager = new ContextManager(65_536, 0.8);
    const state = {
      messages: [{ role: "user", content: "hi" }],
      model: "solar-pro2",
      _contextManager: contextManager,
      _registry: registry,
      _session: { workspace: { cwd: dir } },
      _skillsLoader: null
    };
    const result = await executeCommand("/context", state);
    for (const label of ["시스템 프롬프트", "내장 도구", "MCP 도구", "프로젝트 지침", "스킬", "저장소 맵", "대화 기록", "여유 공간"]) {
      assert.ok(result.response.includes(label), `expected /context response to include "${label}"`);
    }
  })
);

test("/memory is a backward-compatible alias for /context (identical output)", () =>
  withTempDir(async (dir) => {
    const registry = createRegistry({});
    const contextManager = new ContextManager(65_536, 0.8);
    const state = {
      messages: [{ role: "user", content: "hi" }],
      model: "solar-pro2",
      _contextManager: contextManager,
      _registry: registry,
      _session: { workspace: { cwd: dir } },
      _skillsLoader: null
    };
    const memoryResult = await executeCommand("/memory", state);
    const contextResult = await executeCommand("/context", state);
    assert.equal(memoryResult.response, contextResult.response);
  })
);
