import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

test("settings schema provides solar-pro2 as default model", () => {
  assert.equal(SETTINGS_SCHEMA.model, "solar-pro2");
  assert.equal(SETTINGS_SCHEMA.language, "ko");
  assert.equal(SETTINGS_SCHEMA.maxContextTokens, 65536);
  assert.equal(SETTINGS_SCHEMA.permissions.defaultMode, "default");
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
  assert.equal(settings.model, "solar-pro2");
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
  assert.ok(result.full.includes("upstage-cli coding agent"));
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
