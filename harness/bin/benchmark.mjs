#!/usr/bin/env node
// Benchmark v1 candidate-set tooling (no model inference).
//   build           — (re)generate benchmarks/v1/manifest.json from the tasks
//   validate        — CPU-only: manifest ↔ tasks consistency + quality gates
//   qa              — Docker: baseline-fails / solution-passes / no-op-fails
//   report          — CPU-only: independence/family/tranche report (statistical)
//   pack verify P   — verify an external held-out pack at path P (no content)
//   pack summary P  — print the PUBLIC (committable) summary of pack P
//   pack qa P       — Docker: QA the held-out pack P against its private solutions
import { writeFileSync } from "node:fs";
import { buildManifest, validateManifest, loadManifest, MANIFEST_PATH, TASKS_DIR } from "../src/benchmark/manifest.mjs";
import { loadTaskDir } from "../src/task/loader.mjs";
import { qaAll, qaPack } from "../src/benchmark/qa.mjs";
import { verifyPack, packPublicSummary } from "../src/benchmark/pack.mjs";

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
  if (cmd === "report") {
    const m = buildManifest({ withImageDigests: false });
    const fams = Object.entries(m.families);
    const variantFams = fams.filter(([, ids]) => ids.length > 1);
    console.log(`Benchmark v1 — independence report`);
    console.log(`  task rows ............... ${m.counts.total}`);
    console.log(`  independent families .... ${m.counts.independentFamilies}`);
    console.log(`  language pairs .......... ${m.counts.languagePairs}`);
    console.log(`  by tranche .............. ${JSON.stringify(m.counts.byTranche)}`);
    console.log(`  by category ............. ${JSON.stringify(m.counts.byCategory)}`);
    console.log(`  by difficulty ........... ${JSON.stringify(m.counts.byDifficulty)}`);
    console.log(`\n  NON-independent families (>1 row — NOT independent evidence):`);
    if (variantFams.length === 0) console.log("    (none)");
    for (const [fam, ids] of variantFams) console.log(`    ${fam}: ${ids.join(", ")}`);
    const holdoutRows = m.tasks.filter((t) => t.split === "holdout").length;
    console.log(`\n  split: dev=${m.tasks.filter((t) => t.split === "dev").length}  holdout(in-repo)=${holdoutRows}`);
    console.log(`  review: independentHumanReviewed=${m.tasks.filter((t) => t.review.independentHumanReviewed).length}/${m.counts.total} (must be 0 pre-freeze)`);
    console.log(`\n  Effective sample size for power/precision = INDEPENDENT FAMILIES (${m.counts.independentFamilies}), not rows (${m.counts.total}).`);
    return;
  }
  if (cmd === "pack") {
    const sub = process.argv[3];
    const path = process.argv[4];
    if (!sub || !path) { console.error("usage: benchmark.mjs pack {verify|summary|qa} <pack-path>"); process.exit(2); }
    if (sub === "verify") {
      const r = verifyPack(path);
      if (r.ok) { console.log(`pack OK: ${r.meta.name} v${r.meta.version} (${r.summary.length} tasks, evaluator ${r.meta.evaluatorVersion})`); for (const s of r.summary) console.log(`  ${s.id} [${s.category}/${s.difficulty}] fixture ${s.fixtureHash.slice(0, 20)}…`); }
      else { for (const e of r.errors) console.error(`ERROR ${e}`); process.exit(1); }
      return;
    }
    if (sub === "summary") { console.log(JSON.stringify(packPublicSummary(path), null, 2)); return; }
    if (sub === "qa") {
      const results = await qaPack(path);
      let failed = 0;
      for (const r of results) { const mark = r.ok ? "PASS" : (r.mode === "none" ? "SKIP" : "FAIL"); if (!r.ok && r.mode !== "none") failed += 1; console.log(`${mark}  ${r.id}  [${r.mode}]  ${r.verdict}`); }
      console.log(`\npack qa: ${results.filter((r) => r.ok).length}/${results.length} auto-validated`);
      if (failed) process.exit(1);
      return;
    }
    console.error("usage: benchmark.mjs pack {verify|summary|qa} <pack-path>");
    process.exit(2);
  }
  console.error("usage: benchmark.mjs {build|validate|qa|report|pack}");
  process.exit(2);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
