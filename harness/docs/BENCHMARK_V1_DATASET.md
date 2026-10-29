# Benchmark v1 — Substantive task tranche & private held-out workflow

This PR (#12) adds a second tranche of **substantive, low-disclosure** tasks to the
v1 set and establishes the **private held-out** dataset workflow (an external
pack loaded from outside the public repo). It does **not** run any model.

The original 14 tasks (tranche `v1-initial`) are preserved unchanged as
calibration/development material with their audited meaning (see
`BENCHMARK_V1_SEMANTIC_AUDIT.md`). This tranche is `v1-dataset`.

## 1. What is new (public, in this repo)

**14 new task rows = 12 new independent families + 2 new language pairs.** All run
in Docker (`node:22-alpine`, **pinned by digest**), network `none`, Track A
budgets, scored tests protected by `trustedPaths` (restored from the pristine
fixture before scoring) or by a trusted trace evaluator.

| ID | Family | Cat | Diff | Disclosure | Actually measures |
|---|---|---|---|---|---|
| bv1-dx1-config-merge (+ko) | dx1 | B | medium | low | **cross-file diagnosis** — nested deep-merge defect found by tracing loadConfig→deepMerge; location NOT given |
| bv1-dx2-route-normalize | dx2 | B | medium | low | **cross-file diagnosis** — route-key normalization defect across router→routes→path |
| bv1-dx3-stats-mean | dx3 | B | medium | low | **cross-file diagnosis** — off-by-one divisor in a mean helper; the sum is correct, so the fault must be localized |
| bv1-ts1-target-select | ts1 | C | medium | medium | **target selection** — pick which of several settings modules is actually imported; editing the distractor fails |
| bv1-fr1-crash-recover (+ko) | fr1 | E | medium | medium | **failure recovery** — observe a thrown TypeError, diagnose the missing field, recover; all-anonymous shortcut fails |
| bv1-fr2-root-cause | fr2 | E | hard | low | **failure recovery + root cause** — resist symptom suppression: the naive fix (weaken the validator) fails; must fix the bad default |
| bv1-ms2-coordinated | ms2 | F | hard | low | **dependent multi-step** — two COORDINATED edits (topTwo depends on prepare's order); fixing one fails |
| bv1-tr1-json-field | tr1 | D | medium | medium | **tool-result interpretation** — select the api service's port from runtime JSON (not copy stdout) |
| bv1-tr2-json-max | tr2 | D | medium | medium | **tool-result interpretation** — select the id of the max-score item (argmax over structured output) |
| bv1-ms1-indirect | ms1 | D | hard | medium | **dependent tool-result interpretation** — indirect selection ports[primary] |
| bv1-cr1-stop-when-done | cr1 | A | easy | high | **completion reliability** — minimal fix; measures whether the agent stops (Post-Solution Overhead) |
| bv1-sr1-clamp | sr1 | A | medium | medium | simple localized repair (kept baseline anchor) |

Simple localized repair does **not** dominate: of the 12 new families only cr1/sr1
are baseline repair; the rest exercise diagnosis, selection, interpretation,
recovery, or coordinated multi-step work.

## 2. Evidence that these exercise diagnosis / recovery / planning (not guided repair)

Each claim is backed by an adversarial check that a *plausible wrong* solution
**fails** (so passing requires the intended reasoning). Verified in Docker QA and
locally:

- **dx1 (diagnosis):** a one-level "merge server only" hack **fails** the
  top-level-override case → a genuine recursive deep-merge is required, found by
  tracing across three files.
- **ms2 (dependent planning):** fixing only `prepare` (or only `topTwo`) **fails**;
  both must change in a coordinated way.
- **fr2 (recovery, root cause):** weakening the validator to stop the throw
  **fails** `fix_invalid_still_rejected`; the agent must find the real cause (the
  invalid default).
- **fr1 (recovery):** returning `"anonymous"` for every record **fails** — real
  names must be preserved; the agent must run the code, read the stack, and add
  targeted handling.
- **tr1/tr2/ms1 (interpretation):** copying whole stdout, writing any other
  field/port, or hardcoding a token **fails** (unit tests h22); the trusted
  evaluator recomputes the correct value from the run's own JSON.
- **ts1 (selection):** editing the distractor `legacy_settings.mjs` **fails**;
  only the actually-imported module counts.

## 3. Trusted evaluation added this PR

`tool-result-selection` (src/evaluation/evaluators.mjs) — like
`tool-result-continuation`, it proves the agent ran the EXACT trusted command and
used its output, but additionally requires INTERPRETING structured JSON: the
evaluator recomputes the correct value from the qualifying run's own stdout via a
**safe, declarative selector** (`find-field` / `max-by` / `indirect`; no eval, no
agent-supplied code). Generators are read-only Docker mounts from the trusted
registry; tokens are runtime CSPRNG values, so answers are non-guessable and
cannot be hardcoded or leaked. Adversarially unit-tested in `tests/h22`.

## 4. Public development vs private held-out

A task committed publicly **cannot** be a confidential held-out example. So:

- **Public development material (this repo):** the 14 `v1-dataset` rows above —
  reviewable, used to debug the Harness and for calibration. `split: dev`.
- **Private held-out candidates (NOT in this repo):** stored in an external pack
  at a local path outside the repository. Only the loader and a **content-free
  public summary** (hashes + aggregate metadata) are committed
  (`benchmarks/v1/holdout-pack.public.json`). No held-out prompts, fixtures,
  tests, or solutions are committed, logged, or placed in CI/PR text.

A candidate is **not** a frozen held-out task merely because its files are
private: the held-out set must still be independently human-reviewed,
contamination-checked, and frozen before any model evaluation.

### 4.1 External pack architecture (Phase 7)

`src/benchmark/pack.mjs` — `loadPack` / `verifyPack` / `packPublicSummary`, plus
`benchmark.mjs pack {verify|summary|qa} <path>`. Properties (all fail-closed,
unit-tested in `tests/h23`):

- **Explicit path only** — no auto-discovery, no traversal outside the pack root
  (every resolved path is realpath-checked to stay within it).
- **No code execution during parse** — `pack.json` via `JSON.parse`, tasks via the
  existing YAML loader; neither runs pack code. No network, no cloning.
- **No arbitrary host mounts** — read-only mounts are still resolved by NAME from
  the harness-owned trusted registry; a pack cannot mount host files.
- **Integrity + version pinning** — per-file SHA-256 and fixture hashes are
  verified, and the pack's `evaluatorVersion` must equal the harness's
  (`bench-v1-eval-2`), else it is refused.
- **Confidentiality** — private reference solutions are **never** copied into an
  agent workspace (the runner copies only the fixture); the loader returns a
  content-free summary for logging. **Hashes alone do NOT guarantee
  confidentiality** — that comes from not committing/exposing the content.
- **Reuse, not a new runner** — execution goes through the same `TaskRunner`,
  `trustedPaths` restore, trusted evaluators, and Docker isolation.

### 4.2 Held-out candidates (private)

A reference pack `bench-v1-holdout` (evaluatorVersion `bench-v1-eval-2`) lives
outside the repo and currently contains **3 fully-built** held-out tasks,
validated in Docker (`pack qa` 3/3) against their private solutions:

| ID | Cat | Diff | Construct (content private) |
|---|---|---|---|
| hx1-topo-order | B | hard | cross-file diagnosis; grader accepts ANY valid topological order (alternative-solution tolerant) |
| hx2-lru-cache | F | hard | two coordinated bugs (recency refresh + eviction victim) |
| hx3-parse-recover | E | medium | failure recovery; catch-all that drops valid lines fails |

**Designed, not yet built (specifications only — ~5 more to reach ~8–10):**

| Spec ID | Cat | Construct |
|---|---|---|
| hx4-dep-inject | B | cross-file: a wiring defect where the symptom surfaces two modules from the cause |
| hx5-retry-budget | F | dependent multi-step: compute a backoff schedule, then apply it so a bounded retry succeeds |
| hx6-tool-chain | D | chained tool-result: run tool A, use its value to choose tool B's argument, interpret B's output |
| hx7-silent-corruption | E | recovery from a *silent* wrong result (no throw) that must first be detected |
| hx8-overcompletion | A/C | completion: a correct state reached early with tempting but unnecessary follow-up work |

(These specs are public designs; their concrete fixtures/tests/solutions will be
authored directly into the private pack, never committed here.)

## 5. Language pairing (Phase 6)

4 language pairs now exist (2 original: a1, c1; 2 new: dx1, fr1), each sharing an
identical fixture, grader, budgets, and tools — only the prompt language differs
(validator-enforced). Pairs are **paired observations, not independent families**:
`manifest.counts.independentFamilies` (23) already excludes the ko twins. For the
eventual evaluation, the target is **≥8–10 independently-reviewed pairs across all
six categories**; language variants never inflate the primary sample size.

## 6. Independence & sampling (Phase 9)

`benchmark.mjs report` prints the authoritative accounting. Current public set:

- **28 rows → 23 independent families → 4 language pairs.**
- Non-independent families (ko/en twins + d1/d2 replicate): a1, c1, d-token, dx1,
  fr1.
- Tranches: `v1-initial` 14, `v1-dataset` 14. Difficulty: 10 easy / 15 medium / 3
  hard. Categories A5 B6 C4 D5 E5 F3.

**Proposed final sampling plan (~70–80 independent families):** ~12–14 families per
category, difficulty-balanced (≈30% easy, ≈45% medium, ≈25% hard), with ≥8–10
language pairs and a small number of deliberate within-family replicates for
reliability estimates — all counted as families, not rows. Power/precision is
computed on **independent families**, with category strata and within-family
clustering. The full dataset does **not** exist yet; this is the plan, not a claim.

## 7. Reproducibility (Phase 8)

All task images are pinned by digest
(`node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`);
the validator warns on any unpinned tag (now 0). The manifest records image +
digest, fixture hashes, acceptance check ids, budgets, sandbox policy, and the
evaluator version travels with the held-out pack.

## 8. Review state & freeze blockers

Every task is **auto-validated + assistant-semantic-reviewed**; **none is
independently human-reviewed** (`review.independentHumanReviewed = false`,
validator-enforced). An assistant audit is explicitly **not** independent human
review. Remaining blockers before any freeze or live calibration:

- Independent **human review** of every dev and held-out task.
- **Contamination review** of the held-out set (these shapes are more composed than
  the initial tranche, but provenance/novelty must be checked per task).
- **Freeze** a held-out split (author the remaining ~5 specs into the private pack;
  the public repo keeps only hashes).
- Finalize Track A/B budgets and the exact family-level sample size.
- Finalize the failure-accounting policy (carried from the semantic audit).

The protocol is **NOT** frozen and no model has been run.
