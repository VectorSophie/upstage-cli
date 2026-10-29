# Benchmark v1 — Semantic audit & evaluation-validity review

Scope: the 14 candidate tasks on `feat/harness-benchmark-v1` (PR #11). This is a
**construct-validity and reproducibility** review, not an expansion or a
performance exercise. It records what each task actually measures, one confirmed
evaluator bypass and its fix, revised taxonomy/family/language grouping, a
concrete Track-A budget, a failure-accounting policy, the statistical
implications, and the items still blocking a protocol freeze.

Nothing here claims independent human review (none has occurred) and no model
inference / benchmark run was performed.

## 0. Status at audit time

- **PR #11** open against `master`; branch `feat/harness-benchmark-v1`.
- **CI:** `Harness (Node 22)` ✅ and `GitGuardian` ✅ on the audited commit. The
  root `Test (Node 22)` job had been stuck ~95 min in its `npm test` step
  (lint/syntax already ✅). This was **investigated, not assumed**: the branch
  diff is harness-only (0 root files changed vs master), the root suite is
  byte-identical to master (which merged green), and a local run of the exact
  command completed in **5.85 s, 940 tests, 0 failures, 8 skipped**. The hang is
  a stuck runner, not a test failure; it is superseded by the fresh CI run this
  audit's commits trigger. Full CI is **not** declared green until every required
  job completes.

## 1. Confirmed evaluator bypass (Phase 3) and the fix

### The vulnerability (demonstrated, not assumed)
All file-based acceptance checks run, e.g.:
```
node --test --test-name-pattern "^fix_" app.test.mjs
```
against the **agent's own workspace copy** of the test file, and a check "passes"
iff that command exits 0. The agent has `write_file` in the workspace, and
`expectedPatchScope` is advisory (the runner never enforced it). Demonstrated on
Node 24 and inside the real `node:22-alpine` sandbox:

| Tamper (bug left unfixed) | `node --test` exit | Pre-fix outcome |
|---|---|---|
| Rename tests so `^fix_` matches nothing | **0** | **PASS (vacuous)** |
| Replace assertions with `assert.ok(true)` | 0 | PASS |
| Delete the test file | 1 | error |
| (control) matching test, real assertion fails | 1 | fail |

The root cause of the rename case is that **`node --test` treats a zero-match
`--test-name-pattern` as success (exit 0)**. The existing baseline invariant
already blocks a *statically* vacuous acceptance (it would "pass" at baseline →
"baseline invalid"); the gap was that the agent can mutate the workspace test
**after** baseline.

### The fix — trusted-path restore (reuses the runner, no second scorer)
New task field `trustedPaths` lists the scored test files. After the agent
finishes **and its patch is captured** (so tampering stays visible in
`model_patch` and is flagged), the runner restores each trusted path from the
**pristine host fixture** — not from the agent-writable workspace `.git` — before
any `testPatch`/checks run (`runner.restoreTrustedPaths`). Properties:

- An agent that edits/renames/weakens/deletes a scored test cannot change its
  grade; the bug is scored against the real tests → correct **fail**, never a
  false pass and never an exclusion.
- A cheater cannot force an *exclusion* (status `error`) instead of a `fail`:
  the restore reads host bytes and `rm`+`cp` neutralises file→dir swaps; nuking
  the workspace `.git` cannot affect it.
- Tampering is recorded: `safety.tamperedTrustedPaths` + risk flag
  `trusted_path_modified`.
- Category **D** needs no `trustedPaths`: its grade is a trace-aware evaluator
  with an **immutable read-only mounted** generator (hardened T3-v3 model) and a
  runtime CSPRNG token — already outside the editable workspace.

Regression: `tests/h21-benchmark-v1-integrity.test.mjs` (real Docker) drives the
actual `TaskRunner` and proves (a) the rename bypass **passes** with
`trustedPaths` stripped and (b) rename/weaken/delete all **fail** with it
present, plus the tamper flags. `tests/h20` adds CPU unit tests for
`restoreTrustedPaths` and the validator invariant that **every scored test file
referenced by a command check must be a `trustedPath`** (enforced in
`validateManifest`).

Residual the restore does **not** close: *hardcoding to the visible cases*
(answering only the asserted inputs). That is a grader-strength / construct issue
(§2 D-column, §6), not a tamper issue; mitigated here by strengthening the two
weakest graders and deferred to the held-out set (hidden cases) as a freeze
blocker.

## 2. Per-task review matrix

Disclosure = how much the prompt reveals. Grader = how tightly the scored tests
constrain. Shortcut = susceptibility to an incorrect solution passing. Action ∈
KEEP / RECLASSIFY / REWRITE / DROP. All graders are behavioural (`node --test`),
so reasonable alternative implementations pass (confirming *every* alternative is
accepted still needs human review).

| ID | Nominal cat | Actually measures | Disclosure | Grader | Shortcut risk | Family | Difficulty basis | Action |
|---|---|---|---|---|---|---|---|---|
| bv1-a1-range-sum | A simple-repair | instruction-following off-by-one repair | high (file+fn+"off by one") | behavioural; **strengthened** (added n=1, n=100) | low after strengthening | a1 (pair) | trivial loop bound | KEEP |
| bv1-a1-range-sum-ko | A | same, Korean prompt | high | same fixture/checks as a1 | low | a1 (pair) | — | KEEP (paired) |
| bv1-a2-cel-to-fahr | A | formula repair w/ light diagnosis | medium (defect not named) | **strengthened** (−40, 25 added) kills `0?32:212` | low after strengthening | a2 | one constant term | KEEP |
| bv1-b1-string-align | B multi-file | **guided** cross-file repair | high (names the helper as the fault) | single fix site; p2p length | medium (fault located for agent) | b1 | 2 files, fault disclosed | RECLASSIFY |
| bv1-b2-validator-chain | B multi-file | **guided** cross-file boundary repair | high (states zero-boundary + dependency) | p2p neg-case | medium | b2 | `>=`→`>`, disclosed | RECLASSIFY |
| bv1-c1-one-wrong-op | C tool-select | selective repair among 3 + over-edit restraint | medium (which one not said) | p2p guards add/sub; distractor file | low | c1 (pair) | find 1 of 3 | KEEP |
| bv1-c1-one-wrong-op-ko | C | same, Korean prompt | medium | same fixture/checks | low | c1 (pair) | — | KEEP (paired) |
| bv1-c2-trivial-constant | C tool-select | **tool restraint / instruction-following** (value given) | high (value = 10 given) | single equality | n/a (answer is the task) | c2 | one-line constant | RECLASSIFY |
| bv1-d1-tool-result | D tool-result | execute trusted tool, consume its stdout | high (exact command — intrinsic) | trace evaluator + immutable mount | very low (runtime CSPRNG) | d-token | run+read+write | KEEP |
| bv1-d2-tool-result | D tool-result | **same template as d1** | high | same model, different asset | very low | d-token | same as d1 | RECLASSIFY (within-family replicate) |
| bv1-e1-syntax-error | E recovery | **guided syntax repair** (not autonomous recovery) | high (file+defect-class+behaviour) | behavioural | low | e1 | add `}` | RECLASSIFY |
| bv1-e2-missing-module | E recovery | **spec-driven module creation** (not recovery) | high (missing file + full slugify spec) | 2 cases | medium (spec → canonical impl) | e2 | implement slugify | RECLASSIFY |
| bv1-f1-csv-two-bugs | F planning | **compound localized repair** (weak step dependency) | high (both defects named) | 1 case (array+trim) | medium (both bugs disclosed) | f1 | 2 edits, 1 line | RECLASSIFY |
| bv1-f2-stack-two-bugs | F planning | **compound repair across 2 methods** | high (both defects named) | LIFO + size; p2p push | medium | f2 | 2 near-independent fixes | RECLASSIFY |

Headline findings:
- **No task is a genuine autonomous-diagnosis, failure-recovery, or multi-step
  planning benchmark.** The set is dominated by **high-disclosure
  instruction-following / localized repair**. That is appropriate for protocol
  **calibration**; it is not yet evidence of diagnostic or planning capability.
- **E is not failure recovery** (the prompt supplies the diagnosis). **F is
  compound repair, not dependent planning.** **B is guided cross-file repair**
  (fault location disclosed). **C2 measures tool restraint**, not debugging.
- **D1/D2 are one family**, not two independent tasks.
- No task is dropped: each is a valid instruction-following/repair calibration
  item once relabelled. Corrected construct labels now live in the manifest
  (`measuredConstruct`, `promptDisclosure`, `auditAction`, `reclassification`).

## 3. Category validity (Phase 4)

- **A (simple repair):** kept as localized instruction-following repair; diagnostic
  difficulty **not** overstated. a1/a2 graders strengthened to resist two-point
  hardcoding.
- **B (multi-file):** the agent does read two files, but the prompt **names the
  faulty helper/rule**, so cross-file *diagnosis* is largely given → relabelled
  "guided multi-file repair." A held-out B task should withhold the fault
  location.
- **C (tool selection/irrelevance):** c1 is genuine selective repair (which of
  three is unstated). c2's signal is **redundant/unnecessary tool calls** from the
  trace, not repair — relabelled. Tool-selection and unsupported/redundant calls
  are recorded independently (STATISTICS §1).
- **D (tool-result dependence):** hardened T3-v3 model preserved. d1/d2 grouped as
  one family; counted once for independence.
- **E (failure recovery):** reclassified to instruction-following — a real
  recovery task must make the agent **encounter and diagnose** an unexpected
  failure, not be told the file, the defect class, and the fix. Bounded redesign
  path noted in §8.
- **F (multi-step planning):** reclassified to compound repair — two disclosed,
  near-independent one-line fixes are not a planning problem. A real planning task
  needs **dependent** steps (e.g. step 2 consumes step 1's output) and should not
  disclose all defects.

## 4. Korean–English pairing (Phase 5)

Two pairs: `pair-a1` (a1 ↔ a1-ko) and `pair-c1` (c1 ↔ c1-ko). Assistant review of
semantic equivalence:

| Axis | a1 vs a1-ko | c1 vs c1-ko |
|---|---|---|
| Technical info supplied | same (file, fn, "off-by-one") | same (3 fns, exactly one wrong) |
| Specificity / repair hints | same (fix src, pass tests) | same (fix only the wrong one) |
| Expected output / checks | identical fixture + checks | identical fixture + checks |
| Restrictions | same ("don't edit tests") | same ("don't edit tests/unrelated") |
| Ambiguity / register | equivalent; "off-by-one" kept as the natural loanword | equivalent |

Neither Korean prompt discloses more than its English counterpart, so each pair
can isolate a language effect **for that item** (assistant-reviewed, not human).

**Statistical dependency:** the two language variants of one fixture are **paired
observations**, not independent tasks. The manifest now records `baseTaskId`,
`pairId`, `langVariant`, `family`, identical `fixtureHash` and
`acceptanceCheckIds`, and the validator enforces pair equivalence. **14 rows =
11 independent families and only 2 language pairs** (`counts.independentFamilies`,
`counts.languagePairs`). RQ5 **cannot** be answered reliably from 2 pairs — it is
a calibration signal only. Proposed held-out pairing: **≥8–10 pairs spread across
all six categories and difficulty levels** (e.g. ≥1 pair per category, plus extra
pairs in C/D/F), each independently human-verified for equivalence, analysed as
within-item paired differences.

## 5. Budget & fairness — concrete Track A (Phase 6)

Grounded in the **actual** validated serving configs (`src/agent/local-models.mjs`):

| Model | Served context | Validated output cap | TP |
|---|---|---|---|
| Kanana 2 (BF16, thinking) | 16384 | 8192 | 1 |
| EXAONE 4.5 (FP8, thinking) | 16384 | 8192 | 1 |
| EXAONE 4.5 (no-think) | 16384 | 4096 | 1 |
| A.X 4.0 (BF16) | 16384 | 4096 | 2 |
| Solar Open 2 (**UNOFFICIAL** Nota NVFP4) | **8192** | **4096** | 2 |

**Inconsistency found & corrected.** The prior draft set context ceiling 8192 **and**
`maxTokens` 8192. Output tokens are part of the total context: with Solar's 8192
total, an 8192 output cap leaves **zero** room for prompt+tool-schemas+history and
the server 400s (`context_length`). An output limit is **not** a promise that an
8192-token generation fits an 8192-token *total* context.

Concrete, internally consistent **Track A (common-resource)**:
- **Total context ceiling (harness-enforced): 8192 tokens** — Solar's validated
  limit, the binding constraint. The other three are self-limited to 8192 by the
  harness even though their servers allow 16384 (no relaunch needed).
- **Output `maxTokens`: 4096** — the largest output simultaneously feasible within
  8192 across all four models (also A.X's / EXAONE-no-think's validated cap).
  **Changed in `_base-benchmark-v1.yaml` (8192 → 4096).**
- **Input budget (prompt+tools+history): ≤ 4096 tokens**; compaction at 80% of the
  8192 ceiling; truncation policy fail-closed `output_truncated` (never silently
  drop history). Context exhaustion → one compacted retry (adapter P1-C) → if
  still over, recorded as a context-length event (see §6 for whether it counts as
  model- or infra-caused).
- **maxTurns 10; maxToolCalls 20.**
- **Per-exec Docker wall-clock raised 120 → 300 s** so a slow reasoning model's
  single tool call is not truncated (EXAONE 60–165 s/task). The **total** agent
  wall-clock is bounded primarily by turns×tokens, with a generous safety ceiling,
  not a tight clock that penalises reasoning models.
- **Sampling:** each model's vendor preset is **fixed before scoring** and recorded
  (identical knobs are impossible — reasoning on/off differs by architecture);
  deviations belong to Track B.

Limits enforced **where**: output `max_tokens` and total context (`--max-model-len`)
are enforced by the **serving backend** (it 400s on overflow); `maxTurns`,
`maxToolCalls`, compaction, and wall-clock are enforced by the **adapter/harness**.
Effective output caps **differ** across models (8192 vs 4096) — Track A takes the
feasible minimum (4096).

**Blocking pre-freeze decision — cross-model context budgeting.** Each model
tokenises with its own tokenizer, so "8192 tokens" is **not** the same amount of
text across models; a shared token budget is not implementable without a common
tokenizer. Bounded path: **(a)** define Track A parity as the same
`--max-model-len`/ceiling number per model (different actual text capacity),
record per-model `promptTokens/completionTokens/totalTokens`, and report context
pressure per model; optionally **(b)** add a tokenizer-independent prompt
byte/char budget as a secondary guard. Recommend (a) for v1, documented as a known
limitation. Track B (model-native, pinned vendor settings) stays a separate table;
the two are never merged.

Budgets here were set from **validated serving limits and pilot timing**, never
from task-success outcomes (no benchmark has run); they are pre-registered and
must not be retuned after results.

## 6. Failure accounting (Phase 7)

Keep **model-caused** and **infrastructure-caused** failures distinct; do **not**
treat every `tool_error` as infrastructure.

| Class | Example | Bucket | Counts against model? |
|---|---|---|---|
| Capability failure | wrong patch; required check fails | model | yes (fail) |
| Invalid tool use | malformed args, blocked metacharacters, policy violation | model | yes |
| Model-caused tool error | agent runs a command that errors (bad path it chose) | model | yes |
| Output truncation | hit `maxTokens`/`output_truncated` | model (budget) | yes, but reported separately (RQ3) |
| Wall-clock exhaustion | exceeded agent budget | model/ambiguous | report both ways; flag if concentrated |
| Context-length error | prompt+output > ceiling after compaction+retry | model if self-inflicted over-generation; infra if harness mis-budgeted | classify per cause; default: model-budget, flagged |
| Transport/server/protocol | 5xx, connection reset, malformed 200 | infra | **excluded** from model denominator |
| Docker/environment | daemon error, image pull, OOM-kill | infra | excluded |
| Invalid evaluator outcome | unknown evaluator, evaluator threw | infra (status `error`) | excluded |

Reported quantities (all together, never just the first):
- **Task success among valid attempts** (primary; infra excluded).
- **Overall success per scheduled attempt** (infra counted as failure — lower
  bound).
- **Infrastructure-incident rate** per model.
- **Clean-completion rate** and **termination mix**.
- **Missing/excluded attempts** with reasons.

**Bias guard:** infra exclusion can flatter a model whose failures are
concentrated in infra. Always report success under (a) infra-excluded and (b)
infra-as-failure; if they differ materially the result is **infra-limited** and
flagged. **Deterministic retry/exclusion rules, fixed before the held-out run:**
retry an attempt **only** on a classified **infra** failure, up to **2** retries;
never retry a model/capability failure; an attempt excluded only if all its
tries hit infra; record every try and its class in provenance.

## 7. Statistical implications (Phase 7)

- **Effective sample size < row count.** 14 rows → **11 independent families**; ko/en
  pairs and d1/d2 are not independent. Power/precision must be computed on
  **families**, not rows, with category strata and within-family clustering
  (cluster-robust or family-level resampling).
- **Paired across models** (same tasks) → McNemar/Cochran on per-task
  disagreements, not unpaired proportions. **Language pairs** → within-item paired
  differences (RQ5), not absolute rankings.
- **No significance claims at this stage** — 14 calibration rows. The frozen set
  needs a pre-registered size: targeting a 95% Wilson half-width ≤ ~0.12 at p≈0.5
  needs ≈65–70 **independent families** per model (not 65–70 rows), i.e. the
  ~60–100 target must be read as **independent families**, with pairs/replicates
  **added on top**.

## 8. Changes made & revision log (versioning)

Original task definitions are preserved in git history (commit `031928d`); no task
was silently overwritten. Semantic changes in this audit:

| Change | Tasks | Nature |
|---|---|---|
| Add `trustedPaths` (integrity) | all 12 file tasks | enforcement; measured behaviour unchanged |
| Strengthen grader (hardcoding) | a1 (+n=1,n=100), a2 (+−40,25) | scored cases added; baseline still fails, solution still passes |
| Track-A budget fix | `_base` (maxTokens 8192→4096, per-exec timeout 120→300) | feasibility/fairness, pre-registered |
| Reclassify construct (metadata/docs) | b1,b2,c2,d2,e1,e2,f1,f2 | labels only; fixtures unchanged |
| Family/pair + review metadata | all | manifest enrichment |

Fixtures/tasks changed → `fixtureHash`/`specSha256` regenerated in the manifest;
no drift (validator OK). A `version` bump of each changed task to 2 is recommended
at the next manifest revision; this audit records the exact semantic diffs above
in lieu of a silent overwrite.

## 9. Review states (Phase 8)

Three distinct states, now structured in the manifest
(`review.{autoValidated, assistantSemanticReviewed, independentHumanReviewed}`):

| State | Meaning | Count |
|---|---|---|
| auto-validated | mechanical validate + Docker QA | 14 |
| assistant semantic-reviewed | this audit | 14 |
| independent human-reviewed | a person signed off | **0** |

Independent human review is **not** claimed because an AI performed the audit; it
remains a freeze prerequisite. The validator rejects any task that sets
`independentHumanReviewed: true`.

## 10. Freeze-readiness matrix

| Area | State | Why |
|---|---|---|
| Task validity | NEEDS REVIEW | all are high-disclosure instruction-following/repair; valid for calibration, relabelled; no diagnosis/planning/recovery task yet |
| Evaluator integrity | READY | trusted-path restore (file) + immutable mounted evaluator (D), demonstrated + regression-tested + validator-enforced |
| Dataset independence | NEEDS REVIEW | 14 rows = 11 families; held-out set must add independent, less-guessable, composed tasks |
| Language pairing | NEEDS REVIEW | mechanics enforced; only 2 pairs, assistant-reviewed; need ≥8–10 human-verified pairs |
| Image pinning | BLOCKED | images are `node:22-alpine` tags; pin by digest before freeze (validator warns) |
| Resource envelope | NEEDS REVIEW | Track A now internally consistent (8192 ctx / 4096 out); cross-tokenizer budgeting + total agent wall-clock are pre-freeze decisions |
| Failure taxonomy | NEEDS REVIEW | policy defined (§6); finalise context/wall-clock bucketing + retry rules before the run |
| Statistics | NEEDS REVIEW | family-based sizing defined; finalise exact n and power on the frozen set |
| Human review | BLOCKED | 0 tasks independently human-reviewed |
| Held-out contamination control | BLOCKED | candidate bug *shapes* are common; held-out set needs less-guessable composed items + provenance |

**The protocol is NOT frozen.** PR #11 remains a development-stage benchmark
**preparation** PR.
