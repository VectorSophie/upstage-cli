import test from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS_SCHEMA,
  deepMerge,
  deepClone,
  applyEnvOverrides,
  loadSettings
} from "../src/config/settings.mjs";
import { loadUpstageMdFiles, buildSystemPrompt } from "../src/core/system-prompt.mjs";
import { parseCliArgs, getUsageText } from "../src/config/cli-args.mjs";
import { readEnv, getEnv, ENV_SCHEMA } from "../src/config/env.mjs";
import { resolveTokenLimit } from "../src/agent/loop.mjs";
import { ContextManager } from "../src/core/context-manager.mjs";

test("settings schema provides solar-pro4 as default model", () => {
  assert.equal(SETTINGS_SCHEMA.model, "solar-pro4");
  assert.equal(SETTINGS_SCHEMA.language, "ko");
  assert.equal(SETTINGS_SCHEMA.maxContextTokens, null);
  assert.equal(SETTINGS_SCHEMA.permissions.defaultMode, "default");
});

test("SETTINGS_SCHEMA.maxContextTokens is unset by default so model-aware token limits aren't shadowed", () => {
  assert.ok(!SETTINGS_SCHEMA.maxContextTokens, "maxContextTokens must be falsy so loop.mjs's settings?.maxContextTokens || tokenLimit fallback actually fires");
});

test("a fresh-install settings object lets ContextManager use solar-pro4's full 512K context instead of the stale 65536 default", () => {
  // Mirrors loop.mjs:855-862 exactly, using a real default settings clone
  // (not a hand-crafted object that conveniently omits maxContextTokens).
  const settings = deepClone(SETTINGS_SCHEMA);
  const tokenLimit = resolveTokenLimit("solar-pro4");
  assert.equal(tokenLimit, 512_000);
  const contextManager = new ContextManager(
    settings?.maxContextTokens || tokenLimit,
    settings?.compactThreshold || 0.8
  );
  assert.equal(contextManager.maxTokens, 512_000);
});

test("deepMerge merges nested objects recursively", () => {
  const base = { a: { b: 1, c: 2 }, d: 3 };
  const override = { a: { b: 99, e: 5 }, f: 6 };
  const merged = deepMerge(base, override);
  assert.equal(merged.a.b, 99);
  assert.equal(merged.a.c, 2);
  assert.equal(merged.a.e, 5);
  assert.equal(merged.d, 3);
  assert.equal(merged.f, 6);
});

test("deepMerge replaces arrays instead of merging", () => {
  const base = { list: [1, 2, 3] };
  const override = { list: [4, 5] };
  const merged = deepMerge(base, override);
  assert.deepEqual(merged.list, [4, 5]);
});

test("deepClone produces an independent copy", () => {
  const original = { nested: { value: 42 } };
  const clone = deepClone(original);
  clone.nested.value = 99;
  assert.equal(original.nested.value, 42);
});

test("applyEnvOverrides applies UPSTAGE_MODEL", () => {
  const original = process.env.UPSTAGE_MODEL;
  process.env.UPSTAGE_MODEL = "solar-mini";
  const settings = deepClone(SETTINGS_SCHEMA);
  applyEnvOverrides(settings);
  assert.equal(settings.model, "solar-mini");
  if (original === undefined) {
    delete process.env.UPSTAGE_MODEL;
  } else {
    process.env.UPSTAGE_MODEL = original;
  }
});

test("applyEnvOverrides applies UPSTAGE_LANGUAGE", () => {
  const original = process.env.UPSTAGE_LANGUAGE;
  process.env.UPSTAGE_LANGUAGE = "en";
  const settings = deepClone(SETTINGS_SCHEMA);
  applyEnvOverrides(settings);
  assert.equal(settings.language, "en");
  if (original === undefined) {
    delete process.env.UPSTAGE_LANGUAGE;
  } else {
    process.env.UPSTAGE_LANGUAGE = original;
  }
});

test("applyEnvOverrides applies UPSTAGE_MAX_CONTEXT_TOKENS as number", () => {
  const original = process.env.UPSTAGE_MAX_CONTEXT_TOKENS;
  process.env.UPSTAGE_MAX_CONTEXT_TOKENS = "131072";
  const settings = deepClone(SETTINGS_SCHEMA);
  applyEnvOverrides(settings);
  assert.equal(settings.maxContextTokens, 131072);
  if (original === undefined) {
    delete process.env.UPSTAGE_MAX_CONTEXT_TOKENS;
  } else {
    process.env.UPSTAGE_MAX_CONTEXT_TOKENS = original;
  }
});

test("loadSettings merges project settings over defaults", async () => {
  const settings = await loadSettings({ cwd: process.cwd() });
  assert.equal(settings.model, "solar-pro4");
  assert.equal(settings.language, "ko");
  assert.equal(typeof settings.permissions.defaultMode, "string");
});

test("loadUpstageMdFiles returns array from project cwd", () => {
  const files = loadUpstageMdFiles(process.cwd());
  assert.ok(Array.isArray(files));
  const projectMd = files.find((f) => f.source === process.cwd() || f.path);
  if (projectMd) {
    assert.ok(projectMd.content.length > 0);
  }
});

test("buildSystemPrompt includes UPSTAGE.md content", () => {
  const result = buildSystemPrompt({ cwd: process.cwd() });
  assert.ok(result.full.includes("upstage-cli"));
  assert.ok(result.staticPrefix.length > 0);
});

test("buildSystemPrompt with override skips UPSTAGE.md", () => {
  const result = buildSystemPrompt({ cwd: process.cwd(), override: "Custom prompt" });
  assert.equal(result.full, "Custom prompt");
  assert.equal(result.staticPrefix, "Custom prompt");
  assert.equal(result.dynamicSuffix, "");
});

test("buildSystemPrompt includes tool summary in dynamic suffix", () => {
  const tools = [
    { function: { name: "read_file", description: "Read a file from disk" } },
    { function: { name: "search_code", description: "Search code patterns" } },
  ];
  const result = buildSystemPrompt({ cwd: process.cwd(), tools });
  assert.ok(result.dynamicSuffix.includes("read_file"));
  assert.ok(result.dynamicSuffix.includes("search_code"));
});

test("parseCliArgs parses --lang flag", () => {
  const args = parseCliArgs(["--lang", "en", "-p", "hello"]);
  assert.equal(args.language, "en");
  assert.equal(args.prompt, "hello");
});

test("parseCliArgs parses --permission-mode", () => {
  const args = parseCliArgs(["--permission-mode", "bypass"]);
  assert.equal(args.permissionMode, "bypass");
});

test("parseCliArgs parses --add-dir", () => {
  const args = parseCliArgs(["--add-dir", "/extra", "--add-dir", "/more"]);
  assert.deepEqual(args.addDirs, ["/extra", "/more"]);
});

test("parseCliArgs parses --cwd", () => {
  const args = parseCliArgs(["--cwd", "/some/project", "-p", "hello"]);
  assert.equal(args.cwd, "/some/project");
  assert.equal(args.prompt, "hello");
});

test("parseCliArgs leaves cwd null when not passed", () => {
  const args = parseCliArgs(["-p", "hello"]);
  assert.equal(args.cwd, null);
});

test("parseCliArgs parses --max-turns and --max-time", () => {
  const args = parseCliArgs(["--max-turns", "5", "--max-time", "60"]);
  assert.equal(args.maxTurns, 5);
  assert.equal(args.maxTimeSec, 60);
});

test("settings schema exposes a null-by-default loopBudget override", () => {
  assert.deepEqual(SETTINGS_SCHEMA.loopBudget, {
    maxSteps: null,
    maxToolCalls: null,
    maxWallTimeMs: null,
    maxCostUsd: null,
  });
});

test("applyEnvOverrides applies UPSTAGE_MAX_WALL_TIME_MS", () => {
  const original = process.env.UPSTAGE_MAX_WALL_TIME_MS;
  process.env.UPSTAGE_MAX_WALL_TIME_MS = "600000";
  const settings = deepClone(SETTINGS_SCHEMA);
  applyEnvOverrides(settings);
  assert.equal(settings.loopBudget.maxWallTimeMs, 600000);
  if (original === undefined) {
    delete process.env.UPSTAGE_MAX_WALL_TIME_MS;
  } else {
    process.env.UPSTAGE_MAX_WALL_TIME_MS = original;
  }
});

test("getUsageText returns non-empty string", () => {
  const text = getUsageText();
  assert.ok(text.length > 0);
  assert.ok(text.includes("upstage"));
});

test("readEnv returns defaults for unset vars", () => {
  const env = readEnv();
  assert.equal(env.UPSTAGE_BASE_URL, "https://api.upstage.ai/v1");
  assert.equal(env.UPSTAGE_LANGUAGE, "ko");
});

test("getEnv returns typed values", () => {
  const original = process.env.UPSTAGE_DEBUG;
  process.env.UPSTAGE_DEBUG = "1";
  assert.equal(getEnv("UPSTAGE_DEBUG"), true);
  if (original === undefined) {
    delete process.env.UPSTAGE_DEBUG;
  } else {
    process.env.UPSTAGE_DEBUG = original;
  }
});

test("ENV_SCHEMA has UPSTAGE_API_KEY", () => {
  assert.ok(ENV_SCHEMA.UPSTAGE_API_KEY);
  assert.equal(ENV_SCHEMA.UPSTAGE_API_KEY.type, "string");
});
