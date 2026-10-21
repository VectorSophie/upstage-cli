import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dump as yamlDump } from "js-yaml";

// The official dataset stores FAIL_TO_PASS / PASS_TO_PASS as JSON-encoded
// strings ('["tests/x.py::test_y"]'); some exports have real arrays.
function testList(value, field, id) {
  if (value === undefined || value === null || value === "") return [];
  const list = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
    throw new Error(`${id}: ${field} must be a list of test ids`);
  }
  return list;
}

function parseSwebenchInstance(line) {
  const inst = JSON.parse(line);
  const id = inst.instance_id;
  if (typeof id !== "string" || !id) throw new Error("missing instance_id");
  if (typeof inst.repo !== "string" || !inst.repo) throw new Error(`${id}: missing repo`);
  if (typeof inst.base_commit !== "string" || !inst.base_commit) throw new Error(`${id}: missing base_commit`);

  const failTests = testList(inst.FAIL_TO_PASS, "FAIL_TO_PASS", id);
  const passTests = testList(inst.PASS_TO_PASS, "PASS_TO_PASS", id);
  if (failTests.length === 0) throw new Error(`${id}: FAIL_TO_PASS is empty`);

  // Legacy per-check weights (informational; status does not use them)
  const weightOf = { ftp: Number((0.7 / failTests.length).toFixed(4)), ptp: passTests.length ? Number((0.3 / passTests.length).toFixed(4)) : 0 };
  const check = (prefix) => (t, i) => ({
    id: `${prefix}-${i}`,
    weight: weightOf[prefix],
    // Approximation: pytest node ids. Repos with their own runners (django's
    // runtests.py, sympy's bin/test, …) will not run correctly this way.
    command: `python -m pytest -q ${JSON.stringify(t)}`,
    timeout: 120
  });

  return {
    id,
    version: 1,
    description: (inst.problem_statement || "").slice(0, 200),
    // A remote identifier, NOT a local path. The runner refuses it until you
    // clone the repo locally and point `repo:` at the clone.
    repo: `github:${inst.repo}`,
    commit: inst.base_commit,
    testPatch: inst.test_patch || undefined,
    prompt: inst.problem_statement || "",
    context: { strategy: "default", maxFiles: 40, includeTests: true },
    sandbox: { type: "native", timeout: 600, allowedBinaries: ["python", "pytest", "pip"] },
    agent: { permissions: "acceptEdits", maxTurns: 8, maxTokens: 32768 },
    checks: {
      fail_to_pass: failTests.map(check("ftp")),
      pass_to_pass: passTests.map(check("ptp")),
      custom: []
    },
    scoring: {
      weights: { checks: 0.7, patchMinimality: 0.15, toolCallCount: 0.1, costUsd: 0.05, speedMs: 0 }
    },
    tags: ["swebench", "python"],
    difficulty: "medium",
    _meta: {
      source: "swebench",
      dataset: inst.dataset || null,
      repo: inst.repo,
      baseCommit: inst.base_commit,
      envSetupCommit: inst.environment_setup_commit || null,
      version: inst.version || null,
      // Explicit: these tasks do NOT reproduce official SWE-bench scores. The
      // per-repo environment (python version, install steps, versioned deps)
      // and per-repo test runner/log parser of the official harness are not
      // reproduced; checks are pytest approximations.
      officialEvalCompatible: false
    }
  };
}

export function loadSwebenchFile(filePath, { onError } = {}) {
  const absPath = resolve(filePath);
  const lines = readFileSync(absPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const tasks = [];
  lines.forEach((line, i) => {
    try {
      tasks.push(parseSwebenchInstance(line));
    } catch (err) {
      onError?.({ line: i + 1, message: err.message });
    }
  });
  return tasks;
}

export function writeSwebenchTasksToDir(tasks, outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const task of tasks) {
    const fileName = `${task.id.replace(/[^a-z0-9_-]/gi, "_")}.yaml`;
    const filePath = resolve(outDir, fileName);
    writeFileSync(filePath, yamlDump(task, { lineWidth: 120, skipInvalid: true }), "utf8");
    written.push(filePath);
  }
  return written;
}
