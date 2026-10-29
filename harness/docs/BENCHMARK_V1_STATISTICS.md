# Benchmark v1 — Metrics & statistical protocol (DRAFT)

Pre-registered analysis plan. Fix this **before** running the benchmark; do not
adjust metrics or budgets after seeing outcomes.

## 1. Metric definitions (kept independent)

### Primary — Task Success@1
A task **passes** when its trusted required checks (`fail_to_pass` + required
`custom`) all pass, as decided by `determineOutcome` (checks-driven). An
**infrastructure/adapter error** (`status=error`: server/protocol/deadline/docker)
is **excluded from the denominator of model success**, not counted as a model
failure. Reported with the infra-incident count alongside.

### Secondary
- **Clean Completion Rate** — fraction of attempts ending with a normal agent
  completion (`stopReason=done`) rather than `budget_exhausted` / `tool_error` /
  `output_truncated` / other abnormal termination. A task can be Success@1 **and**
  not a clean completion (EXAONE in the pilots) — the two are never conflated.
- **Tool-call activity** — total calls, and separately: successful, failed,
  repeated (same tool+args ≥2), invalid/blocked (policy or metacharacter), and —
  for category C — unnecessary calls on a task solvable without them. Derived from
  the recorded trace (`trace.toolCalls`, `resultData`).
- **Turns-to-Correct-Patch** — the earliest turn at which the required checks
  would pass, when reliably reconstructable from the trace (e.g. the turn whose
  write produced the accepted state). Null when not reconstructable.
- **Post-Solution Overhead** — tool calls and turns after the earliest correct
  solution. Directly targets the EXAONE over-verification behaviour (RQ3).
- **Resource efficiency** — wall time, prompt/completion/total tokens, effective
  output throughput, GPU configuration (TP1/TP2), and cost estimates where
  meaningful. Labelled hardware-configuration-dependent and `contended` when
  co-resident with other GPU work.

Reporting discipline: unknown reasoning-token counts are `null`, never `0`;
`reasoningChars` are characters, never reported as tokens; Solar is always marked
unofficial NVFP4.

## 2. Sampling

- **pass@1 is the primary analysis.** Each attempt starts from an independent,
  pristine workspace (fresh `cpSync` + git init), with the model freshly loaded
  per batch. Record seeds/sampling, scheduling order, model restarts, and GPU
  contention per attempt in provenance.
- **pass@3** is a pre-designed **optional secondary** experiment (unbiased pass@k
  estimator over independent attempts). **Not run in v1 initially.** If run, report
  pass@1 and pass@3 separately; never substitute one for the other.

## 3. Statistical analysis plan

- **Per-model Task Success@1 with confidence intervals** — Wilson score intervals
  for binomial proportions (robust at small n); report n, point estimate, 95% CI.
- **Paired comparisons on the same tasks** — models run on an identical task set,
  so compare with paired methods (McNemar's test on per-task pass/fail
  disagreements for two models; Cochran's Q across the four), not unpaired
  proportion tests.
- **Category-level results** — Success@1 and Clean Completion per category per
  model, with CIs; expect wide CIs at ~2 tasks/category in the candidate set
  (another reason the full set needs ~10–15 tasks/category).
- **Korean vs English (RQ5)** — paired per model on the ko/en task pairs; report
  the within-model difference with a CI, not an absolute ranking. Guard against
  confounding prompt translation quality with capability.
- **Effect sizes, not only p-values** — report differences in proportions with
  CIs (and Cohen's h for proportions) as the primary evidence; p-values secondary.
- **Multiple-comparison correction** — Holm–Bonferroni across the family of
  pairwise/category tests; state the family explicitly.
- **Sensitivity to infrastructure failures** — report Success@1 under (a) infra
  excluded (primary) and (b) infra counted as failure (lower bound); if they
  differ materially, the result is infra-limited and flagged.
- **Uncertainty from small samples** — with ~14 candidate tasks, **no claims of
  statistical significance**; this stage is calibration. Significance claims wait
  for the frozen set with a pre-registered sample size.

## 4. Sample-size / precision justification (for the frozen set)

Target a 95% Wilson CI half-width ≤ ~0.12 for a per-model Success@1 near 0.5,
which needs roughly **n ≈ 65–70 INDEPENDENT FAMILIES per model** (same task set
across models) — **not** 65–70 rows. Language variants (ko/en of one fixture) and
template replicates (d1/d2) are **not** independent: the audit shows the 14
candidate rows are only **11 families** and **2 language pairs**
(`manifest.counts.independentFamilies` / `.languagePairs`). So the ~60–100
full-set target (PROTOCOL §2) must be read as independent families, with
language pairs and replicates **added on top**, and power computed with category
strata and within-family clustering (cluster-robust or family-level resampling).
For paired model differences, McNemar power depends on the discordant-pair rate;
budget ≥ ~25–30 discordant pairs (at the family level) to detect a moderate
difference — revisit after a calibration run on the frozen set. RQ5 needs ≥8–10
human-verified language pairs across categories; 2 pairs cannot answer it.
Finalise exact numbers before freeze.

## 6. Failure accounting (model- vs infrastructure-caused)

Keep model-caused and infrastructure-caused failures distinct; do **not** treat
every `tool_error` as infrastructure. Full table in
`BENCHMARK_V1_SEMANTIC_AUDIT.md` §6. Buckets:

- **Model** (count against the model): capability failure (required check fails),
  invalid tool use (malformed args / blocked metacharacters / policy), model-caused
  tool errors, output truncation (also reported separately for RQ3), self-inflicted
  context-length overflow.
- **Infrastructure** (excluded from the model denominator, reported as an incident
  rate): transport/server/protocol errors, Docker/environment errors, invalid
  evaluator outcomes (status `error`), harness mis-budgeting.
- **Ambiguous** (report both ways, flag if concentrated in one model): wall-clock
  exhaustion; context-length errors whose cause is unclear.

Always report Success@1 under (a) infra-excluded (primary) and (b) infra-as-failure
(lower bound); if they differ materially the result is **infra-limited** and
flagged — this guards against flattering a model whose failures cluster in infra.

**Deterministic retry/exclusion rules (fixed before the held-out run):** retry an
attempt **only** on a classified **infra** failure, ≤ 2 retries; **never** retry a
model/capability failure; exclude an attempt only if every try hit infra; record
each try and its failure class in provenance.

## 5. Reporting template (per model)

```
Model (checkpoint, quant[, UNOFFICIAL]) | track A/B
  Task Success@1: k/n = p  [95% Wilson CI lo–hi]   (+ infra incidents: m)
  Clean Completion: c/n
  By category A–F: p_cat [CI]
  Korean vs English (paired): Δ [CI]
  Efficiency (contended): median wall s, median tokens, TP1/TP2
  Termination mix: done / budget_exhausted / tool_error / output_truncated
```
Track A and Track B tables are separate. The leaderboard is never a single
merged number.
