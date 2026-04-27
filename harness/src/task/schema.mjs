import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { load as yamlLoad } from "js-yaml";

export const TASK_SCHEMA = {
  required: ["id", "repo", "prompt", "checks"],
  properties: {
    id: { type: "string", minLength: 1 },
    version: { type: "number" },
    description: { type: "string" },
    _import: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    prompt: { type: "string", minLength: 1 },
    context: {
      type: "object",
      properties: {
        strategy: { type: "string", enum: ["default", "full-repo", "retrieval", "symbol-graph", "failing-test", "recent-diffs"] },
        maxFiles: { type: "number" },
        includeTests: { type: "boolean" }
      }
    },
    sandbox: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["native", "docker"] },
        image: { type: "string" },
        network: { type: "string", enum: ["none", "allowlist", "host"] },
        networkAllowlist: { type: "array", items: { type: "string" } },
        timeout: { type: "number", minimum: 1 },
        memory: { type: "string" },
        allowedBinaries: { type: "array", items: { type: "string" } }
      }
    },
    agent: {
      type: "object",
      properties: {
        permissions: { type: "string" },
        maxTurns: { type: "number" },
        maxTokens: { type: "number" },
        tools: {
          type: "object",
          properties: {
            allow: { type: "array", items: { type: "string" } },
            deny: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    checks: {
      type: "object",
      properties: {
        fail_to_pass: { type: "array", items: { $ref: "#/$defs/check" } },
        pass_to_pass: { type: "array", items: { $ref: "#/$defs/check" } },
        custom: { type: "array", items: { $ref: "#/$defs/check" } }
      }
    },
    scoring: {
      type: "object",
      properties: {
        weights: { type: "object" },
        costBudgetUsd: { type: "number" }
      }
    },
    tags: { type: "array", items: { type: "string" } },
    difficulty: { type: "string", enum: ["easy", "medium", "hard", "expert"] },
    expectedPatchScope: { type: "array", items: { type: "string" } },
    expectedMaxLines: { type: "number" }
  },
  $defs: {
    check: {
      required: ["id", "command"],
      properties: {
        id: { type: "string" },
        command: { type: "string" },
        timeout: { type: "number" },
        weight: { type: "number" },
        required: { type: "boolean" }
      }
    }
  }
};

const DEFAULTS = {
  version: 1,
  branch: "main",
  context: { strategy: "default", maxFiles: 40, includeTests: true },
  sandbox: { type: "native", network: "none", timeout: 120, memory: "512m", allowedBinaries: [], networkAllowlist: [] },
  agent: { permissions: "acceptEdits", maxTurns: 6, maxTokens: 32768, tools: { allow: [], deny: [] } },
  checks: {},
  scoring: {
    weights: { checks: 0.60, patchMinimality: 0.15, toolCallCount: 0.10, costUsd: 0.10, speedMs: 0.05 },
    costBudgetUsd: 1.0
  },
  tags: [],
  expectedPatchScope: [],
  expectedMaxLines: 50
};

export function validate(spec) {
  const errors = [];
  for (const field of TASK_SCHEMA.required) {
    if (spec[field] === undefined || spec[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (typeof spec.id === "string" && spec.id.trim().length === 0) {
    errors.push("id must not be empty");
  }
  if (typeof spec.prompt === "string" && spec.prompt.trim().length === 0) {
    errors.push("prompt must not be empty");
  }
  if (spec.sandbox?.type && !["native", "docker"].includes(spec.sandbox.type)) {
    errors.push(`invalid sandbox.type: ${spec.sandbox.type}`);
  }
  if (spec.context?.strategy && !["default", "full-repo", "retrieval", "symbol-graph", "failing-test", "recent-diffs"].includes(spec.context.strategy)) {
    errors.push(`invalid context.strategy: ${spec.context.strategy}`);
  }
  return { valid: errors.length === 0, errors };
}

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (typeof base !== "object" || base === null) return override;
  if (typeof override !== "object" || override === null) return override;
  if (Array.isArray(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] !== null && typeof override[key] === "object" && !Array.isArray(override[key]) && typeof base[key] === "object" && base[key] !== null) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

export function resolveImport(rawSpec, taskPath, visited = new Set()) {
  if (!rawSpec._import) {
    return deepMerge(DEFAULTS, rawSpec);
  }
  const importPath = resolve(dirname(taskPath), rawSpec._import);
  if (visited.has(importPath)) {
    throw new Error(`circular _import detected: ${importPath}`);
  }
  visited.add(importPath);
  const parentRaw = yamlLoad(readFileSync(importPath, "utf8"));
  const parentResolved = resolveImport(parentRaw, importPath, visited);
  const { _import: _, ...rest } = rawSpec;
  return deepMerge(parentResolved, rest);
}
