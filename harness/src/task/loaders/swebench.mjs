import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { dump as yamlDump } from "js-yaml";

function parseSwebenchInstance(line) {
  const inst = JSON.parse(line);
  const failTests = Array.isArray(inst.FAIL_TO_PASS) ? inst.FAIL_TO_PASS : [];
  const passTests = Array.isArray(inst.PASS_TO_PASS) ? inst.PASS_TO_PASS : [];
  const perFail = failTests.length > 0 ? Number((0.7 / failTests.length).toFixed(4)) : 0;
  const perPass = passTests.length > 0 ? Number((0.3 / passTests.length).toFixed(4)) : 0;

  return {
    id: inst.instance_id,
    version: 1,
    description: (inst.problem_statement || "").slice(0, 200),
    repo: inst.repo || "",
    prompt: inst.problem_statement || "",
    context: { strategy: "default", maxFiles: 40, includeTests: true },
    sandbox: { type: "native", timeout: 120, allowedBinaries: ["python", "pytest", "pip"] },
    agent: { permissions: "acceptEdits", maxTurns: 8, maxTokens: 32768 },
    checks: {
      fail_to_pass: failTests.map((t, i) => ({
        id: `ftp-${i}`,
        command: `python -m pytest "${t}" -x -q`,
        timeout: 60,
        weight: perFail
      })),
      pass_to_pass: passTests.map((t, i) => ({
        id: `ptp-${i}`,
        command: `python -m pytest "${t}" -x -q`,
        timeout: 60,
        weight: perPass
      })),
      custom: []
    },
    scoring: {
      weights: { checks: 0.7, patchMinimality: 0.15, toolCallCount: 0.1, costUsd: 0.05, speedMs: 0 }
    },
    tags: ["swebench", "python"],
    difficulty: "medium",
    _meta: {
      source: "swebench",
      baseCommit: inst.base_commit || null,
      envSetupCommit: inst.environment_setup_commit || null
    }
  };
}

export function loadSwebenchFile(filePath) {
  const absPath = resolve(filePath);
  const lines = readFileSync(absPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const tasks = [];
  for (const line of lines) {
    try {
      tasks.push(parseSwebenchInstance(line));
    } catch {
      // skip malformed lines
    }
  }
  return tasks;
}

export function writeSwebenchTasksToDir(tasks, outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const task of tasks) {
    const fileName = `${task.id.replace(/[^a-z0-9_-]/gi, "_")}.yaml`;
    const filePath = resolve(outDir, fileName);
    writeFileSync(filePath, yamlDump(task, { lineWidth: 120 }), "utf8");
    written.push(filePath);
  }
  return written;
}
