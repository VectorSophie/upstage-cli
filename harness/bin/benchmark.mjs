#!/usr/bin/env node
// Benchmark v1 candidate-set tooling (no model inference).
//   build     — (re)generate benchmarks/v1/manifest.json from the task files
//   validate  — CPU-only: manifest ↔ tasks consistency + quality gates
//   qa        — Docker: baseline-fails / solution-passes / no-op-fails per task
import { writeFileSync } from "node:fs";
import { buildManifest, validateManifest, loadManifest, MANIFEST_PATH, TASKS_DIR } from "../src/benchmark/manifest.mjs";
import { loadTaskDir } from "../src/task/loader.mjs";
import { qaAll } from "../src/benchmark/qa.mjs";

const cmd = process.argv[2];

async function main() {
  if (cmd === "build") {
    const m = buildManifest({ withImageDigests: process.env.BV1_NO_DIGEST !== "1" });
    writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
    console.log(`wrote ${MANIFEST_PATH}\n  ${m.counts.total} tasks: ${JSON.stringify(m.counts.byCategory)}`);
    return;
  }
  if (cmd === "validate") {
    const res = validateManifest(loadManifest());
    for (const w of res.warnings) console.log(`WARN  ${w}`);
    for (const e of res.errors) console.log(`ERROR ${e}`);
    console.log(res.ok ? `\nvalidate: OK (${Object.keys(res.perTask).length} tasks, ${res.warnings.length} warnings)` : `\nvalidate: FAILED (${res.errors.length} errors)`);
    if (!res.ok) process.exit(1);
    return;
  }
  if (cmd === "qa") {
    const tasks = loadTaskDir(TASKS_DIR).sort((a, b) => a.id.localeCompare(b.id));
    const results = await qaAll(tasks);
    let failed = 0;
    for (const r of results) {
      const mark = r.ok ? "PASS" : (r.mode === "none" ? "SKIP" : "FAIL");
      if (!r.ok && r.mode !== "none") failed += 1;
      console.log(`${mark}  ${r.id}  [${r.mode}]  ${r.verdict}`);
    }
    console.log(`\nqa: ${results.filter((r) => r.ok).length}/${results.length} auto-validated`);
    if (failed) process.exit(1);
    return;
  }
  console.error("usage: benchmark.mjs {build|validate|qa}");
  process.exit(2);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
