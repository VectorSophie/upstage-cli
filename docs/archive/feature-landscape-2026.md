# Feature landscape 2026: what strengthens our identity

> **Status note (2026-09-03):** written when `reasoning_effort` was "simply
> never sent" (per this doc's own framing) — that's since been wired in
> fully, capability-gated per model, by the 2026-09-02 Model Modernization
> plan. Also written when the default model was `solar-pro2`; default is now
> `solar-pro4`. Most of this doc's specific recommendations (Groundedness
> Check, Document AI, AGENTS.md interop, Korean PII guardrail) shipped —
> see `new-concepts-aug2026-pt2.md`'s opening line confirming Tier 1–3 items
> are "all implemented."

Research pass across the wider coding-agent field — Pi, Goose, Aider,
Cline/Roo Code, Amp, OpenHands, Devin/Windsurf, plus the guardrails and
Korean-compliance landscape — done to find features worth merging in, with
a specific lens: not "what do other agents have" but **what would make
upstage-cli identifiably *ours*, not a reskinned Claude Code**. The
strongest answers turned out to be things nobody else can copy, because
they run on capabilities only Upstage has (Solar Pro2's reasoning-effort
switch, Groundedness Check, Document AI) — those come first. Borrowed
patterns from other agents come after, each mapped to what it'd actually
touch in this repo.

Nothing here is implemented. This is the research/proposal doc, same
posture as `docs/tui-mouse-clickable-ux.md`.

## 0. Where "identity" is currently thin

Grepped before researching so recommendations build on real gaps, not
assumed ones:

- `src/model/upstage-adapter.mjs`'s request payload has no
  `reasoning_effort` field — Solar Pro2's own signature capability is
  simply never sent.
- No integration anywhere with Upstage's Document AI (OCR/Parse/Extract),
  Groundedness Check, or Embeddings APIs — only the chat completion
  endpoint is called. `grep -rn "groundedness\|document-ocr" src/` is empty.
- `src/core/system-prompt.mjs` only reads `UPSTAGE.md` — no `AGENTS.md`
  fallback, so upstage-cli ignores context files 30+ other agents already
  read in a repo that has one.
- `src/core/policy/engine.mjs` has no content-inspection guardrail at
  all — path/injection checks exist, but nothing scans what's about to be
  written or sent for PII, Korean or otherwise.
- The Korean-first instruction in `system-prompt.mjs` is one line:
  `"Korean-first: respond in Korean by default unless the user writes in
  English."` No guidance on terminology handling, honorific register, or
  anything else Solar Pro2's own prompting handbook recommends.
- Loop-level budgets exist (`DEFAULT_LOOP_BUDGET`: max steps, max tool
  calls, max wall-time; `tokenBudgeter` warns at 80% context) but there's
  no dollar-cost cap or approval gate — only a context-window guardrail,
  not a spend guardrail.

## 1. Tier 1 — Upstage-native differentiators

These aren't "borrowed from another agent" — they're built on APIs and
model capabilities specific to Upstage, so they can't be copied by
Claude Code, Aider, or anyone wrapping a different model. This is the
highest-leverage tier for "strengthens our identity" specifically.

### 1.1 Expose Solar Pro2's `reasoning_effort` switch

Solar Pro2 is a **hybrid reasoning model** with a `reasoning_effort:
"low"|"high"` API parameter — confirmed directly from Upstage's own
[Solar Pro2 Prompting Handbook](https://github.com/UpstageAI/cookbook/blob/main/solar-pro2-prompting-handbook/%5BEN%5D%20Solar%20Pro2%20Prompting%20Handbook.ipynb):
`"high"` makes the model "systematically break down problems step by step
and perform logical verification at each stage" (recommended for
multi-step planning, complex refactors, architecture decisions); `"low"`
is "~3x faster" and cuts output tokens ~70% (recommended for simple
edits, extraction, format conversion). The handbook's own guidance for
when to use which: quality-critical + multi-step reasoning → high;
speed/cost-sensitive + simple transformation → low.

This is currently unused. Concretely:
- Add `reasoning_effort` to the request payload in `upstage-adapter.mjs`,
  settings-cascade-configurable (`src/config/settings.mjs`) with a
  per-session override.
- Surface it as a cycle-able mode next to the existing permission-mode
  chip in `StatusBar.mjs` (same UX pattern as `mode-cycle.mjs`'s
  default/acceptEdits/plan cycle) — `auto` (heuristic: high for
  planning/architecture prompts, low for single-file edits, mirroring
  the handbook's own decision tree) / `low` / `high`, user-overridable.
- This is the single most "only-we-can-ship-this" item on this whole
  list — no other coding agent has this lever because no other agent's
  backing model exposes it this way.

### 1.2 Groundedness Check as a real hallucination guardrail

Upstage ships a dedicated [Groundedness Check API](https://console.upstage.ai/docs/capabilities/groundedness-checking):
submit a context/answer pair, get back whether the answer is actually
supported by the context. The Solar Pro2 handbook's own §6.4 names
hallucination as a top failure mode and recommends the model be made to
"admit what it doesn't know" — Groundedness Check is Upstage's own answer
to that, and we don't use it anywhere.

Concrete use: after `context-builder.mjs` assembles repo-snippet context
for a turn, and the model produces a claim about that code (e.g. "this
function does X", a summary, an explanation), spot-check groundedness
before presenting it — surfaced as a small trust indicator (a dim ✓/⚠
next to assistant explanations) rather than blocking output, since it's
a confidence signal, not a policy gate. Cheapest integration point: our
existing `critic` stage in `loop.mjs` (already does a self-check pass) —
groundedness check is a natural additional critic, backed by a real
model call instead of the model critiquing itself.

### 1.3 Document AI as a built-in ingestion tool

Upstage's [Document AI](https://console.upstage.ai/docs/capabilities/document-ocr)
(OCR + Layout Analysis + Parse) claims 95% accuracy and is specifically
called out as strong on Korean text and complex layouts — a real,
differentiated capability most coding-agent tool registries have no
equivalent for (Claude Code, Aider, etc. can't read a scanned PDF or a
photographed whiteboard at all). Concrete tool: `read_document` in
`src/tools/builtin/` — hand it a PDF/image (a design spec, a scanned
contract, a screenshot of an error dialog, a whiteboard photo of an
architecture sketch) and get back structured Markdown/HTML the agent can
reason over, exactly like `read_file` but for non-text inputs. This is a
capability gap in the entire competitive set, not just a nice-to-have.

### 1.4 Korean-optimized embeddings for repo search

Upstage's embeddings are explicitly positioned for "Korean-language vector
understanding" ([Embeddings API](https://console.upstage.ai/docs/capabilities/embed)).
`src/agent/context-builder.mjs`'s keyword/symbol search is presumably
English-token-oriented (tree-sitter based, not semantic) — for repos with
Korean identifiers, comments, or commit messages, a Solar-embedding-backed
semantic search pass would materially outperform keyword matching in a way
genuinely tied to being *the* Korean-market coding agent. Lower priority
than 1.1–1.3 (bigger lift, less immediately visible), but flagged since
it's the same "only we can do this well" shape.

## 2. Tier 2 — Guardrails (the explicit ask)

### 2.1 Korean PII detection & redaction

The clearest, most concrete gap found in this whole research pass.
Direct finding, translated: *"주민등록번호, 사업자등록번호, 건강보험번호처럼
한국에만 존재하는 식별자들"* (resident registration numbers, business
registration numbers, health insurance numbers — identifiers that only
exist in Korea) *"Guardrails PII의 경우 기본적으로 영어 기반의 룰셋으로
설계되어 있어 한국어 기반의 PII 탐지 정확도에 한계가 존재"* — i.e. mainstream
guardrail products (AWS Bedrock Guardrails, etc.) ship English-first PII
rulesets that miss Korean identifiers by default
([source](https://theori.io/ko/blog/korean-pii-detection-benchmark)).
A coding agent that reads/writes real project files (`.env` samples, seed
data, test fixtures, log dumps someone pasted into a prompt) is exactly
where this bites.

Concrete: a new guardrail layer in `src/permissions/` (sibling to
`injection-check.mjs`) with regex + validation for Korean-specific
identifiers — RRN format `######-#######` with the actual checksum
algorithm (not just shape-matching, which is what most rulesets do and
why they over/under-fire), business registration numbers, card/account
number patterns — running on both tool *input* (about to write this to a
file?) and tool *output* (about to show this in the terminal?), redacting
or requiring confirmation rather than silently blocking. This is a real,
buildable feature no generic-market competitor ships correctly, per the
research above — a genuine differentiator, not a checkbox.

### 2.2 Cost/budget hard cap with an approval gate

Current guardrails (`DEFAULT_LOOP_BUDGET`, `tokenBudgeter`) cap context
usage and loop iterations, not spend. Enterprise guardrail practice
consistently separates these: *"Every agent should have a per-task budget
... agent workflows being the first to cap as they're the most likely to
spike"* ([source](https://portal26.ai/ai-agent-cost-control-stop-agents-burning-budget/)).
Concrete: a `maxCostUsd` field alongside the existing budget fields in
`src/config/defaults.mjs`, checked in the same place `maxToolCalls`/
`maxWallTimeMs` already are in `loop.mjs`, surfaced as a settings-cascade
value (global/project/CLI-flag, same as everything else in
`settings.mjs`) rather than a new mechanism — small, mechanical addition
that closes a real gap using infrastructure we already have.

### 2.3 PIPA-aware cross-border-transfer awareness

Korea's PIPA (Personal Information Protection Act) Article 28-8 restricts
cross-border transfer of personal data, and the PIPC's 2025 generative-AI
guidelines set out a "legitimate interest" basis and safety-assurance
standards specifically for AI services handling Korean personal data
([source](https://connectontech.bakermckenzie.com/south-korea-sets-ai-standard-pipcs-guidelines-for-generative-ai-present-obligations-opportunity/)).
This is squarely policy/compliance territory, not something to hard-code
as a blocking rule (data-transfer legality depends on context this CLI
can't evaluate) — the actionable version is much smaller: when 2.1's PII
guardrail fires on Korean-identifier-shaped data heading toward a
network-classified tool call (matches our existing `network` action
class in `policy/engine.mjs`), surface it as a distinct, named warning
("Korean personal-data pattern detected in outbound request") rather than
folding it into a generic PII warning — gives users/orgs something
concrete to point at for their own PIPA risk assessment, without us
pretending to adjudicate legal compliance we can't actually judge.

## 3. Tier 3 — Proven patterns worth adopting from other agents

Not Upstage-specific, but validated by real adoption elsewhere and a
genuine gap in our own feature set.

### 3.1 `AGENTS.md` interop
[AGENTS.md](https://agentsindex.ai) is now a Linux-Foundation-stewarded
open standard, read by 30+ agents (OpenAI Codex, Claude Code, Cursor,
Aider, Gemini CLI, Devin, Zed...). We only read `UPSTAGE.md`. Cheapest
possible interop win: `loadUpstageMdFiles()` in `system-prompt.mjs` falls
back to `AGENTS.md` when no `UPSTAGE.md` exists at a given directory level
— upstage-cli then works well in *any* existing repo that already has
one, zero cost to repos that don't. Should stay a fallback, not a merge —
`UPSTAGE.md` remains the primary, project-specific mechanism.

### 3.2 Session forking/branching (Pi's tree-structured sessions)
Pi stores sessions as **append-only trees**, not linear histories — `/tree`
lets you branch off any earlier point, explore an alternative, and the old
and new continuations become sibling branches instead of one overwriting
the other ([source](https://stacktoheap.com/blog/2026/02/26/pi-tree-context-window-management/)).
Claude Code has a partial version (`/branch`, `--fork-session`) but — per
an [open Claude Code feature request](https://github.com/anthropics/claude-code/issues/32631) —
still lacks a return path: navigating the tree and managing branches as
first-class objects. We already have `src/runtime/session.mjs` with
persisted `history`/`toolResults`/`appliedPatches` — extending the
storage shape from a flat array to a tree (parent-pointer per turn) and
adding a `/branch` command + a tree-navigator overlay (reusing the
`SessionBrowser.mjs`/`select`-intrinsic pattern we already have working)
is a real, scoped feature, not a rewrite. Genuinely validated demand
(multiple agents converging on this independently) rather than a novelty.

### 3.3 Watch mode (Aider's file-comment trigger)
Aider monitors source files for special comments (`# ai!`, `// ai?`) and
triggers an edit when one is saved — "the code IS the interface"
([source](https://github.com/NousResearch/hermes-agent/issues/537)
discusses the pattern's appeal directly). We already have `@file`
mentions (`src/agent/file-mentions.mjs`) for pulling file content *into*
a prompt; watch mode is the inverse — the file itself becomes the prompt
entry point. Lower priority than 1.x/2.x (meaningfully changes the
interaction model, needs its own design pass on triggering/debouncing/
scope), but a real, validated pattern worth a future dedicated look.

### 3.4 Recipes (Goose's YAML multi-step workflows)
Goose's Recipes package "the goal, required extensions, structured
inputs, and even sub-recipes" into a shareable YAML file — reusable,
parameterized workflows, credited with scaling Goose to 60% internal
adoption at Block via shared recipes rather than every engineer
reinventing prompts ([source](https://the-agent-report.com/2026/05/block-goose-ai-agent-recipe-runner-scaled-60-percent/)).
We already have `/spec` (`src/core/spec.mjs`) persisting feature specs
into `UPSTAGE.md` — Recipes are a natural next step for that same
spec-driven-memory direction: named, parameterized, shareable workflow
definitions (e.g. a Korean-market team's standard "add a new API
endpoint with 사내 conventions" recipe) rather than one-off specs.
Scoped as a follow-up to `/spec`, not a separate system.

### 3.5 Checkpoints with easier undo (Cline's per-step undo)
Cline creates a checkpoint on every step with one-click undo and a diff
view ([source](https://docs.cline.bot/core-workflows/plan-and-act)). We
already have `/rewind` (`src/core/rewind.mjs`) — file-level checkpoint
revert. The gap is granularity and visibility: Cline's version is *every
tool call*, surfaced inline as it happens, not a separate command invoked
after the fact. Worth a UX pass (surface a checkpoint marker in the chat
pane per tool-writing-step, `/rewind`-equivalent action right there)
rather than new plumbing — `rewind.mjs`'s underlying mechanism already
supports this; it's a presentation gap, not a missing capability.

## 4. Considered, not recommended

- **Amp's Oracle/Librarian/Painter (named persona sub-tools)** — cute
  branding, but functionally just `run_subagent` with a system-prompt
  persona and no capability we lack. Not worth the surface area unless a
  specific persona (e.g. a Korean-regulatory-review persona) earns its
  keep on its own — revisit only if 2.3 above grows into something that
  wants a dedicated reviewer identity.
- **Windsurf/Cascade's cross-session "Memories"** — real and validated,
  but overlaps heavily with what 3.2 (session trees) would already give
  us once sessions are properly navigable/searchable; building both is
  redundant. Land 3.2 first, reassess.
- **Full OpenHands-style autonomous PR loop (issue → code → test → PR,
  zero human steps)** — a materially different trust posture than this
  CLI's permission-mode model (`default`/`acceptEdits`/`plan`/etc.), which
  is built around human-in-the-loop by design. Not a fit without a much
  larger conversation about what "autonomous" means for this project —
  flagging so it's a deliberate non-decision, not an oversight.
- **Warp's shareable "Drive" of workflows** — same shape as 3.4 (Recipes)
  once that exists; a sharing/discovery layer on top, not a distinct
  feature. Revisit after Recipes ships if there's real demand to share
  them across a team.

## 5. Stronger Korean prompting — concrete, not just "more Korean"

Pulled directly from Upstage's own prompting handbook (§3–§5), since it's
the authoritative source for how Solar Pro2 specifically responds to
structure — most of this is generically true of the handbook's advice,
applied to our actual system prompt:

- **Element order matters and is currently unused**: the handbook's
  recommended system-prompt structure is Context → Role → Instructions →
  Constraints/Format → Examples, with critical instructions repeated at
  **both** the start and end for long contexts (§5.2) — our
  `buildSystemPrompt()` is a flat instruction list with no such structure.
- **Emphasis vocabulary**: the handbook documents that Solar Pro2
  responds specifically to CRITICAL/MANDATORY/MUST/NEVER-style emphasis
  words and repetition for non-negotiable rules (§5) — worth auditing
  `system-prompt.mjs` for whether our actual hard constraints (path
  restrictions, the "use tools immediately" instruction) use this
  vocabulary or read as one-more-line-among-many.
- **Self-verification checklists** (§5.1) — the handbook recommends
  giving the model an explicit checklist to verify its own output
  against before finishing, which is exactly what our `critic` stage in
  `loop.mjs` should be doing structurally, not just informally.
- **Korean-specific system-prompt content genuinely missing today**:
  terminology handling (should technical terms like "commit"/"merge"
  stay in English or be translated — currently unspecified, so it's
  inconsistent turn to turn), and register consistency (해요체 vs
  합쳐체 vs 하십시오체 — a professional coding assistant should pick one
  and hold it, currently unspecified). Both are one or two added lines in
  `buildSystemPrompt()`'s `langInstruction`, not a redesign.

## References

- [Pi (earendil-works)](https://github.com/earendil-works/pi) — session trees, multi-provider normalization, Packages
- [Goose (Block)](https://agentsindex.ai/goose-block) — Recipes, MCP breadth, Linux Foundation governance
- [Aider](https://codegen.com/ai-tools/aider/) — repo map, architect/editor split, watch mode, lint/autotest loop
- [Cline Plan/Act & Checkpoints](https://docs.cline.bot/core-workflows/plan-and-act)
- [Amp (Sourcegraph) — subagents, Oracle](https://medium.com/@brendan.bohan/hunting-for-my-next-agent-my-top-five-favorite-features-of-sourcegraph-amp-32b571f53f6f)
- [OpenHands](https://theaiagentindex.com/agents/openhands) — autonomous loop, sandboxed Docker
- [Windsurf/Cascade memory + Agent Command Center](https://www.digitalapplied.com/blog/windsurf-2-deep-dive-cascade-agents-flows-2026)
- [AGENTS.md spec](https://www.morphllm.com/agents-md-guide)
- [Claude Code session-forking feature request #32631](https://github.com/anthropics/claude-code/issues/32631)
- [Solar Pro2 Prompting Handbook (Upstage, official)](https://github.com/UpstageAI/cookbook/tree/main/solar-pro2-prompting-handbook)
- [Upstage Groundedness Check API](https://console.upstage.ai/docs/capabilities/groundedness-checking)
- [Upstage Document AI / OCR](https://console.upstage.ai/docs/capabilities/document-ocr)
- [Upstage Embeddings](https://console.upstage.ai/docs/capabilities/embed)
- [Korean PII detection gap in mainstream guardrails (Theori, Korean)](https://theori.io/ko/blog/korean-pii-detection-benchmark)
- [PIPA / PIPC generative-AI guidelines](https://connectontech.bakermckenzie.com/south-korea-sets-ai-standard-pipcs-guidelines-for-generative-ai-present-obligations-opportunity/)
- [AI agent cost/budget guardrails](https://portal26.ai/ai-agent-cost-control-stop-agents-burning-budget/)
