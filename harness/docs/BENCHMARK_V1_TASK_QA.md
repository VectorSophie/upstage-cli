# Benchmark v1 — Task QA & dataset quality

How candidate tasks are checked, what was verified mechanically vs by a human,
and the known limitations. Tooling: `npm run benchmark:validate` (CPU-only) and
`npm run benchmark:qa` (Docker), plus `tests/h20-benchmark-v1.test.mjs`.

## 1. Per-task QA checklist

For every candidate task:

1. **Baseline failure** — on the pristine fixture, every required acceptance
   check fails. (QA runner, in Docker.)
2. **Known-correct solution passes** — a reference solution makes acceptance pass
   and `pass_to_pass` pass. File-based tasks overlay `benchmarks/v1/solutions/<id>/`;
   category-D tasks execute the trusted mounted generator and write its stdout
   token. (QA runner.)
3. **No-op fails** — the baseline IS the no-op state; it must not pass. (QA runner.)
4. **Plausible incorrect solution** — covered mechanically for D (a token not
   emitted by the real run fails; see h18/h17 adversarial tests) and partially for
   file tasks (baseline is one wrong state); **full "every wrong answer rejected"
   requires human review** (see §4).
5. **Answer-leakage scan** — no agent-visible fixture file contains a literal
   matching an acceptance token; no acceptance **command** embeds the expected
   answer (h20); D generators live outside the copied workspace.
6. **Evaluator not agent-modifiable** — acceptance evaluators are named,
   harness-owned code (never fixture code); D generators are read-only mounts from
   the trusted registry; reference solutions live outside the fixture repo.
   **Scored test files (file tasks) are `trustedPaths`:** the runner restores them
   from the pristine host fixture after the agent runs and before scoring, so an
   agent cannot edit, rename, weaken, or delete a scored test to grade itself. The
   validator enforces that every test file named by a command check is a
   `trustedPath`. This closed a **confirmed** bypass — see §4 and
   `BENCHMARK_V1_SEMANTIC_AUDIT.md` §1.
7. **No shortcut** — `expectedPatchScope` + `pass_to_pass` on untouched code (e.g.
   C1 checks add/sub stay correct) discourage over-editing; command identity +
   stdout-only + read-only mount (D) prevent the T3 bypasses.
8. **Alternative correct solutions** — acceptance is behavioural (`node --test`),
   so reasonable alternative implementations pass; **confirming no reasonable
   solution is wrongly rejected requires human review**.
9. **Pinned, offline dependencies** — all fixtures are self-contained Node ESM run
   under `node:22-alpine` with `network: none`; no package installs, no network.
10. **Review provenance** — recorded per task (`review` field): `auto` =
    mechanically + QA validated; `human` = independently reviewed by a person.

## 2. Automated QA results (this PR)

`npm run benchmark:validate` → **OK**, 0 errors, 14 warnings (all the same
pre-freeze reminder: images are `node:22-alpine` tags, to be pinned by digest
before freeze).

`npm run benchmark:qa` (real Docker) → **14/14 auto-validated**: baseline fails,
solution passes, no-op fails, sanity holds — for all of A(3)/B(2)/C(3)/D(2)/E(2)/F(2).

`tests/h20` (CPU-only) → structural invariants, manifest↔task consistency,
leak/isolation invariants, and validator negatives (duplicate id, ghost entry,
missing entry) all pass.

## 3. Review state

Structured in the manifest as
`review.{autoValidated, assistantSemanticReviewed, independentHumanReviewed}`:

| State | Meaning | Count |
|---|---|---|
| auto-validated | passed mechanical validation + Docker QA above | **14 (all)** |
| assistant semantic-reviewed | the Phase-2 semantic audit (this assistant) | **14 (all)** |
| independent human-reviewed | independently reviewed by a person | **0** |

**No task has received independent human review** — it is not claimed merely
because an AI performed the semantic audit. The validator rejects any task that
sets `independentHumanReviewed: true`. Human review is a freeze prerequisite
(PROTOCOL §7, SEMANTIC_AUDIT §10).

## 4. What automated QA CANNOT establish

- That the acceptance check rejects **every** incorrect solution. In particular,
  **hardcoding to the visible asserted cases** can still pass (the semantic audit
  strengthened the two weakest graders — a1, a2 — and defers full resistance, via
  hidden held-out cases, to freeze; see SEMANTIC_AUDIT §1).
- That it accepts **every** reasonable alternative correct solution.
- Semantic evaluator flaws beyond the mechanical gates (e.g. a test that passes
  for the wrong reason). The T3 saga is the cautionary example — a leak that
  passed CI until reviewed.
These require human review and, where useful, adversarial model runs.

### Adversarial integrity regression (added by the semantic audit)
`tests/h21-benchmark-v1-integrity.test.mjs` (real Docker) drives the actual
`TaskRunner` on bv1-a1 and proves: with `trustedPaths` **stripped**, an agent that
renames the tests out of the `^fix_` pattern **passes vacuously** (node `--test`
exits 0 on a zero-match pattern); with `trustedPaths` present, the same rename —
plus weakening assertions and deleting the file — all **fail**, and the tampering
is flagged (`safety.tamperedTrustedPaths`). `tests/h20` adds CPU unit tests for
`restoreTrustedPaths` and the validator's trusted-path invariant.

## 5. Development vs held-out split

All 14 are `split: dev` (development/calibration fixtures for validating the
protocol). **No held-out tasks exist yet**; the `split` field and tooling support
`holdout`, to be populated when the frozen evaluation set is authored. Reference
solutions and D generators are never placed in an agent-visible path, so the dev
set already follows the no-leak discipline the held-out set will require.

## 6. Contamination

These candidate bugs are small, generic coding patterns (off-by-one, wrong
operator, delimiter/trim, LIFO semantics, slugify) that plausibly appear in public
training data; they are suitable for **protocol calibration** but weak as
contamination-resistant evaluation items. The held-out set should prefer less
guessable, more composed tasks and record provenance/licensing per task. The
candidate fixtures are original to this repo (authored here), but their *shapes*
are common. Do **not** treat T3-v1/v2 pilot results as evidence of T3-v3 (hardened)
capability; do not treat the pilot fixtures as held-out items.

## 7. Reproduce

```bash
cd harness
npm run benchmark:build      # regenerate benchmarks/v1/manifest.json from tasks
npm run benchmark:validate   # CPU-only consistency + quality gates (incl. integrity invariants)
npm run benchmark:qa         # Docker: baseline-fails / solution-passes per task
node --test tests/h20-benchmark-v1.test.mjs          # CPU: structure, metadata, restore unit, validator negatives
node --test tests/h21-benchmark-v1-integrity.test.mjs # Docker: adversarial tamper → fail (needs Docker)
```
