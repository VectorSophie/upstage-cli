# Native-Solar agentic capabilities — design

## Context

`docs/roadmap-tui-and-features.md` already covers the TUI-vehicle question
(vendoring opencode's TUI) and the TUI-agnostic capability tiers. This spec
covers five threads that roadmap doc doesn't: model modernization, system
prompt engineering, a looser permission harness, subagent improvements, and
completion-verification hardening. A sixth thread (Korean/Hangul input
correctness) turned out to be a TUI-vehicle concern, not a standalone fix —
it's now a verification checklist item in the roadmap doc's Section B instead
of a patch to the Ink `Composer.mjs`, since Ink is being retired.

**Strategic premise (2026-09-02, supersedes memory `project-mcp-subagent-
direction`):** upstage-cli targets a Claude-Code-quality UX/capability bar,
but Solar is the engine — not a delegate Claude Code orchestrates. The June
eval that motivated the old delegate strategy ran against Solar Pro2 only;
Upstage has since shipped Pro3 and Pro4 with large agentic-benchmark gains.
This decision was made explicitly rather than gated on a fresh live re-eval.

**Research basis:** comparative study of Goose (Block), Pi (earendil-works),
Aider, Google Antigravity, and opencode's design philosophies; Upstage's own
Solar Pro2/3/4 launch benchmarks; publicly documented/community-extracted
system prompts and subagent architectures for Claude Code and OpenAI Codex
CLI; Anthropic's published multi-agent engineering guidance. Full findings
live in this session's transcript, not reproduced here — this doc states the
decisions and why, not the literature review.

---

## A. Model modernization

**Problem:** `src/model/upstage-adapter.mjs`'s `DEFAULT_MODEL` and
`src/agent/loop.mjs:30`'s `SOLAR_PRO2_TOKEN_LIMIT` (65,536) both hardcode
Pro2-era assumptions. Pro4 offers 512K context, adjustable reasoning effort,
and dramatically better agentic benchmarks (Terminal-Bench 2.1: 2.2 → 57).

**Design:**
- New `src/model/model-capabilities.mjs`: `getModelCapabilities(modelId)` →
  `{ contextLimit, supportsReasoningEffort, supportsParallelToolCalls,
  supportsResponseFormat }` for `solar-pro2/pro3/pro4`, with a conservative
  Pro2-level fallback for unrecognized ids (never crash on
  `UPSTAGE_MODEL=whatever-comes-next`). One table, not scattered
  conditionals — mirrors Aider's per-model settings YAML pattern.
- `DEFAULT_MODEL` moves to `solar-pro4`.
- `UpstageAdapter.complete()` adds `reasoning_effort` (when supported and
  requested) and `parallel_tool_calls: true` (when supported) to the request
  payload; response parsing picks up a `message.reasoning` field when
  present.
- `settings.mjs`'s existing `alwaysThinkingEnabled`/`thinkingBudget` fields
  (currently dead — nothing reads them) get wired to the new
  `reasoning_effort` param.
- `loop.mjs`'s `resolveTokenLimit()` reads the capability table for the
  active model instead of a fixed constant (env var / settings override
  still wins).
- **Integration point that's easy to miss:** `context-builder.mjs:14`
  (`MAX_CONTEXT_CHARS = 24_000`, comment pinned to "Solar Pro2's 65k limit")
  is a *second*, independent hardcoded ceiling. It must also derive from the
  capability table, or it silently stays stale after this ships and nobody
  notices until someone asks why a 512K-context model is still only getting
  24K chars of repo context.

**Testing:** capability-table lookups for pro2/pro3/pro4 + unknown-id
fallback; `resolveTokenLimit()` returns the right default per model; no live
API calls required.

---

## B. System prompt overhaul

**Problem:** `src/core/system-prompt.mjs` is four sentences plus concatenated
UPSTAGE.md files — no environment context, no tool-use doctrine, no
destructive-action guardrails beyond the policy engine's hard blocks, no
verbosity calibration.

**Design principle (resolves the internal tension between "Pi says prompts
are mostly unnecessary overhead on capable models" and "Claude Code's rich
doctrine sections work well"):** doctrine depth is *conditional on model
tier*, read from thread A's capability table, not a single global choice.
`solar-pro4` (RL-trained for agentic tasks, the primary target) gets the
terser end of the range; `solar-pro2`/unrecognized models get the fuller
scaffolding as a fallback. Add a `promptTier: "minimal" | "full"` field to
`model-capabilities.mjs` driving this.

**Sections added to `buildSystemPrompt()`:**
1. **Environment block** — cwd, platform, git branch + `status --short`
   summary, date — injected fresh each call, not just at session start.
2. **Tool-use doctrine** — read-before-write, don't fabricate completions,
   verify before claiming done (ties directly into thread F).
3. **"Executing actions with care"** — a judgment-call layer sitting above
   the policy engine's hard blocks (Codex's two-axis pattern: what's
   technically possible vs. when to pause and ask, kept as two separate
   concerns rather than one risk rating).
4. **Verbosity calibration** — per surface (TUI vs. one-shot `ask` mode).

**Resolves the second internal tension (static doctrine text vs. dynamic
policy):** the "executing actions with care" section must reflect *live*
policy/trust state (thread C), not a fixed claim. If a project's trust file
has writes auto-approved, the prompt shouldn't tell the model to expect a
confirmation prompt that will never fire — that's two sources of truth
drifting apart. The environment block queries the current policy engine
state (via a small accessor, not duplicated logic) and states it plainly:
"writes in this project are auto-approved" / "writes require confirmation."

**Kept intentionally small** despite the added sections — Pi's finding that
heavy prompts are largely unneeded overhead on capable models is a real
counter-argument to over-building this. Sections, not paragraphs.

**Testing:** unit tests on `buildSystemPrompt()` output — environment block
present and correctly populated, doctrine section present, prompt tier
selection correct per model, policy-state line matches actual policy config.
No live API needed.

---

## C. Looser harness (permission model)

**Problem:** the policy engine's `requiresConfirmation` is a binary per
action-class (read/write/exec/network/git/publish). Goose's per-tool
allow/ask/deny and Pi's project-trust-file both offer finer, lower-friction
control without loosening actual safety.

**Design:**
- Policy engine gains optional per-tool overrides on top of the existing
  per-action-class rules (`allow`/`ask`/`deny`), configurable in settings —
  data, not code, matching opencode's philosophy of permission-as-config.
- Skills gain optional `tools:` / `model:` frontmatter so a skill can scope
  down what's available while it runs (goose recipes, Claude Code subagent
  frontmatter) — reuses the existing `SkillsLoader` frontmatter parser,
  which already handles array-valued fields.
- New project-level trust file (`~/.upstage/trust.json`, Pi's pattern):
  per-project "always allow" at a coarser grain than per-action prompts, so
  a trusted repo stops nagging on every write. This is intentionally *not*
  Pi's full stance (no MCP, no permission prompts at all by default) — that
  would be a bigger safety-posture change than "reduce friction," and isn't
  part of this design.

**Explicit operating principle (resolves the apparent C-vs-D tension):**
"loosen" here means reducing friction that's human-annoyance-shaped
(redundant confirmations on a trusted project), not friction that's
correctness-shaped (concurrent subagents racing on the same files). Thread D
stays conservative on subagent parallelism for a different reason entirely —
see below.

**Testing:** per-tool override resolution order (tool-specific beats
action-class default), trust-file read/write round-trip, skill frontmatter
tool-scoping applied to a scoped subagent registry (reuses the existing
`createScopedRegistry` pattern in `run-subagent.mjs`).

---

## D. Subagent improvements

**Problem:** `run_subagent` is always sequential, budget hardcoded (4 steps /
6 calls / 15s), `AgentRoleRegistry`'s planner/explorer/editor/reviewer roles
exist but don't change behavior beyond an optional prompt override, no
explicit concurrency/depth caps (recursion is currently prevented only
because `run_subagent` isn't in the default tool allowlist, not by an
explicit limit).

**Design:**
- Explicit `maxConcurrentSubagents` / `maxSubagentDepth` settings, starting
  near Codex CLI's conservative defaults (depth 1, ~6 concurrent) rather than
  Claude Code's (depth 3, 20 concurrent) — raise later once the conservative
  defaults prove too tight in practice.
- Per-role `model` override in agent definitions (Aider's architect/editor
  split, generalized) — e.g. a cheap/fast model for `reviewer`, a stronger
  one for `planner`. **Integration point:** `run-subagent.mjs` currently
  reuses `context.adapter` from the parent unchanged; a per-role model
  override means capabilities must be re-resolved per subagent call from
  thread A's table, not inherited from the parent's already-resolved values.
- `fork` / `fresh` context-mode flag on agent definitions, mirroring Claude
  Code's distinction (this session's own `Agent` tool already works this
  way — fork inherits full context, fresh starts clean). Currently
  `run_subagent` only does "fresh."
- **Parallelism stays conservative by design, not by oversight:**
  Anthropic's own multi-agent engineering writeup explicitly flags
  tightly-coupled, real-time-coordination work (which coding is) as a poor
  fit for multi-agent parallelism, at ~15x the token cost of single-agent.
  `loop.mjs`'s existing `canRunInParallel` logic already only parallelizes
  low-risk (read-only) tool calls in one turn — extend that same instinct to
  subagents: parallel dispatch is available for read-only/`explorer`-role
  subagents (independent investigations), write-capable subagents
  (`editor`/`reviewer`) stay sequential by default.
- Surface live subagent state in the TUI's existing Sidebar Tools tab
  (addresses Pi's "opaque orchestration" critique without needing
  Antigravity's full Agent Manager panel) — this is TUI-vehicle work,
  belongs in the opencode-vendoring migration's feature-parity phase, not
  built here.

**Testing:** concurrency/depth cap enforcement (a subagent spawning past the
depth limit gets blocked, not silently allowed), per-role model resolution,
fork-vs-fresh context assembly produces the expected message history in each
mode.

---

## F. Verification hardening

**Problem:** project memory documents a real incident — the model claimed it
wrote a test file it never created. The critic loop
(`runCriticPhase` in `loop.mjs`) already re-runs tests after write-tool use,
but that only catches failures *after* a real write happened; it doesn't
catch a turn where the model asserts an action with zero tool calls at all.

**Design:**
- After a turn completes with `toolCallList.length === 0`, check whether the
  response text asserts a completed action (pattern match) with no
  corresponding successful write-tool call anywhere in that trajectory. If
  matched, don't return `DONE` — inject a corrective turn instead ("you
  described an action but didn't call the tool — either do it or say you
  didn't").
- **Reuse, don't duplicate:** `upstage-adapter.mjs` already has an
  `ACTION_WORDS` regex used to force `tool_choice: "required"` on the first
  turn. F's detector should reuse that same word list (exported, not
  redefined) rather than inventing a second, independently-maintained
  pattern list that will drift from the first one over time.
- **Must be bilingual, not an afterthought:** the system prompt defaults to
  Korean-first output (`system-prompt.mjs`'s `langInstruction`). An
  English-only `ACTION_WORDS` list would only catch the English half of this
  exact failure mode — the more likely half, given the Korean-first default,
  would slip through silently. Korean completion-claim patterns (e.g.
  "완료했습니다", "수정했습니다", "작성했습니다") are a first-class
  requirement of this thread, not a stretch goal.

**Testing:** a turn with a completion claim and no tool call gets flagged in
both English and Korean; a turn with a genuine tool call + matching claim
passes through unmodified; a turn with hedged language ("I still need to
fix...") doesn't false-positive.

---

## Sequencing

A and F are small and largely independent — natural to do first. B depends
on A's capability table for tier-conditional doctrine depth. C and D can
proceed in parallel once B's policy-state accessor exists (D's "care"
doctrine references it). E (Korean input correctness) isn't scheduled here —
it's a checklist item inside the opencode-TUI-vendoring migration, tracked in
`docs/roadmap-tui-and-features.md`.

Suggested order: **A → F → B → C → D**, each independently shippable and
testable against the existing Node built-in test runner discipline.

## Out of scope

- Rebuilding TUI-vehicle features (multiline composer, autocomplete, live
  status, diff rendering) — covered by the opencode-TUI-vendoring spec/plan,
  not this doc.
- Adopting Pi's full minimal-harness stance (no MCP, no permission prompts by
  default) — C's trust file reduces friction without going that far; a
  bigger safety-posture change than requested here.
- A live re-eval of Solar Pro3/Pro4 against the original June eval's task
  set — the native-Solar decision was made explicitly rather than gated on
  this; worth doing at some point but not a blocker for any thread above.
