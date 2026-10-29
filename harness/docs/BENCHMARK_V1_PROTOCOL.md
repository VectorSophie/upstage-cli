# Korean LLM Agent Benchmark v1 — Protocol (DRAFT, candidate stage)

Status: **candidate / not frozen.** This PR defines the protocol and an audited
candidate task set for validating it. It does **not** run the benchmark. Models:
Kanana 2 30B-A3B Thinking (BF16), EXAONE 4.5 33B (FP8), A.X 4.0 72B (BF16), and
Solar Open 2 250B (**unofficial Nota NVFP4** — stated in every report).

## 1. Research questions

- **RQ1 — Task-solving capability.** How reliably does each model complete real,
  verifiable SWE/tool-use tasks? (Primary metric: Task Success@1 on trusted checks.)
- **RQ2 — Tool-use competence.** Can the model choose appropriate tools, use
  returned information, avoid irrelevant/unsupported calls, and run multi-step
  workflows? (Tool-use metrics, category C/D/F.)
- **RQ3 — Agentic completion reliability.** How often does a model solve a task
  yet fail to terminate cleanly (`budget_exhausted`/`tool_error`/`output_truncated`)?
  Observed in EXAONE and occasionally Solar in the pilots. (Clean Completion Rate.)
- **RQ4 — Execution efficiency.** Compute, wall time, and tool activity per correct
  result. (Resource metrics; hardware-configuration-dependent.)
- **RQ5 — Language dependence.** Does performance change with equivalent Korean vs
  English instructions? Language is an explicit paired variable; a model's origin
  or Korean specialization is **not** assumed to imply superiority on Korean tasks.

The design keeps **model capability, agent control, infrastructure reliability,
and evaluation validity** as separate axes.

## 2. Task taxonomy (six categories)

| Cat | Name | Exercises | Candidate tasks (this PR) |
|---|---|---|---|
| A | Simple repair | local single-function bug | bv1-a1, bv1-a2 (+ a1-ko) |
| B | Multi-file repair | cross-file diagnosis + coordinated change | bv1-b1, bv1-b2 |
| C | Tool selection / irrelevance | pick the right change; avoid unnecessary tools/over-editing | bv1-c1, bv1-c2 (+ c1-ko) |
| D | Tool-result dependence | obtain a value from a tool and use it (hardened T3-v3 model) | bv1-d1, bv1-d2 |
| E | Failure recovery | recover from an erroring command / missing file | bv1-e1, bv1-e2 |
| F | Multi-step planning + verification | several dependent fixes + verify | bv1-f1, bv1-f2 |

**Full design target:** ~60–100 tasks, balanced across categories and documented
difficulty, split into a development/calibration set and a **frozen held-out**
evaluation set. **This PR implements 14 candidate/development fixtures** (≥2 per
category, plus 2 Korean pairs) to validate the protocol — not a leaderboard.
Tasks were chosen for category coverage and clean verifiability, **not** by which
models passed them. The pilot fixtures T1–T4 / T3-v1/v2/v3 are retained as
historical pilot evidence and are **not** reused as independent benchmark tasks.

## 3. Fair evaluation envelope — two tracks (reported separately)

The four models differ in architecture, reasoning, context, quantization, and
serving. Fairness is not "identical knobs"; we define two tracks and never merge
them into one unqualified leaderboard.

### Track A — common-resource (primary)
Identical task set and agent-side limits wherever technically possible, bounded
by the **most constrained** model. **Effective context ceiling = 8192 tokens**
(Solar's validated limit). Effective context budgets prompt + tool definitions +
running history + generation output; truncation policy = fail-closed
`output_truncated` (never silently drop history). Candidate defaults (Track A):
`maxTurns 10`, `maxToolCalls` = 2×maxTurns, wall-clock = `sandbox.timeout` (120 s
candidate; per-category at freeze), `maxTokens` (output) 8192 clamped to each
model's validated ceiling, sampling = low-temperature deterministic-ish per model
capability table, retry policy = adapter deadline (P1-C) with no silent retry past
the wall clock, tools = category-defined allow-list, sandbox = Docker/none,
completion = checks-driven (status) + stopReason (termination).

### Track B — model-native (secondary)
Documented, pinned **vendor-recommended** sampling/reasoning per model, within
validated hardware limits (e.g. Solar `--max-num-seqs 256`, 8192 ctx; EXAONE
`enable_thinking`; Kanana `deepseek_r1` reasoning). Every deviation from Track A
recorded. Reported as a separate table; never averaged with Track A.

For **both** tracks these are fixed **before** any scoring and **never** changed
after inspecting outcomes: `maxTurns`, `maxToolCalls`, wall-clock, max output
tokens, context-truncation policy, reasoning config, sampling, retry policy, tool
availability, sandbox settings, completion criteria.

Reporting rules (carried from the pilots): unknown reasoning-token counts are
`null`, never `0`; `reasoningChars` are characters, never reported as tokens;
Solar's unofficial NVFP4 quantization is explicit in every report; throughput and
latency are labelled hardware-configuration-dependent, not universal model
properties; metrics under GPU co-residency are tagged `contended`.

## 4. Metrics

See `BENCHMARK_V1_STATISTICS.md` for full definitions and the statistical plan.
Primary: **Task Success@1** (trusted required checks pass; infrastructure failures
excluded, not counted as model failures). Secondary: Clean Completion Rate;
successful/failed/redundant/blocked tool calls; Turns-to-Correct-Patch;
Post-Solution Overhead; resource efficiency.

## 5. Execution (eventual, not run here)

All agent execution uses the Docker sandbox (no privileged mounts, no host FS
access; read-only mounts only via the trusted registry). One model served at a
time behind the established multi-sample GPU availability gate (`kserve*.sh`);
TP2 only when both GPUs have sufficient free VRAM; never disrupt Sinsan / RAGAS /
GLM / MiMo / scopeweaver; no driver changes; no new checkpoints. Each attempt
starts from an independent pristine workspace. pass@1 is primary; pass@3 is a
pre-designed optional secondary (not run yet).

## 6. Resource estimate (eventual four-model experiment)

From this session's pilot execution records (contended; indicative):

| Model | TP | Load+compile (to /health) | Per-task agent time (observed T3 pilots) |
|---|---|---|---|
| Kanana 2 | 1 | ~80–100 s | ~15–30 s |
| EXAONE 4.5 | 1 | ~190–210 s | ~60–165 s (verbose reasoning, often full turn budget) |
| A.X 4.0 | 2 | ~230–240 s | ~13–56 s |
| Solar Open 2 (NVFP4) | 2 | ~160–210 s (8192 ctx) | ~10–107 s |

Per-attempt wall time ≈ agent time + Docker per-check overhead (~1–2 s/check).
For a frozen set of **N≈80 tasks**, pass@1, four models, one model loaded at a
time (load amortised across all its tasks):

- Attempts: 4 × 80 = **320** (pass@1); pass@3 would be 3× = 960 (optional, later).
- Rough wall-clock per model = load + N × (per-task + overhead). Worst case
  (EXAONE ~150 s/task): ~80×150 s ≈ **3.3 h**; best (Kanana ~25 s): ~0.6 h.
  Four models pass@1 ≈ **6–10 GPU-hours** wall (serial, one at a time), plus
  ~15 min total model-load overhead and retry slack (budget +25% for
  infrastructure/retries). pass@3 ≈ 3× that.
- GPU occupancy: Kanana/EXAONE single-GPU; A.X/Solar dual-GPU (TP2). Disk: model
  caches already resident (no new downloads); run artifacts ≈ a few hundred MB of
  JSON per full sweep.
- These are **estimates with wide uncertainty** (contended timings, model
  variance, EXAONE's turn-budget behaviour). Refine with a timing dry-run on the
  frozen set before committing a schedule. **No servers are launched in this PR.**

## 7. Freeze checklist (before live benchmarking)

- [ ] Expand to the full stratified set (~60–100), balanced, difficulty-labelled.
- [ ] Author and **freeze a held-out** split; keep reference solutions out of any
      agent-visible path (as the candidate set already does).
- [ ] Pin every task's Docker image **by digest** (candidates use the
      `node:22-alpine` tag; the validator warns until pinned).
- [ ] Freeze Track A and Track B envelopes (all budgets) and record them.
- [ ] Independent **human** review of each task (current review state = `auto`).
- [ ] Finalise the statistical plan (sample size / precision; see STATISTICS).
- [ ] Decide capability-failure vs infrastructure-failure accounting policy.
