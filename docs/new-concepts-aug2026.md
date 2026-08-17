# New concepts & ideas — August 2026 pass

Follow-up research pass to `feature-landscape-2026.md` (which covered Pi, Goose,
Aider, Cline/Roo, Amp, OpenHands, Devin/Windsurf, AGENTS.md, Korean PII/PIPA,
and Upstage's Groundedness/Document AI/Embeddings APIs — all implemented).
This pass deliberately skips that ground and surfaces what's newer: mostly
things that shipped in the last few weeks. Sourced via live web search, not
memory — model/pricing/benchmark numbers below are as reported by the cited
sources on the dates given, not verified against Upstage's docs directly.

## 0. Urgent, not optional: we're one full model behind our own vendor

**Solar Pro 4 shipped August 10, 2026** — a week before this research pass —
replacing Solar Pro 3 (Jan/Mar 2026), which itself replaced Solar Pro 2. This
repo's default is still hardcoded to `solar-pro2` in three places
(`src/model/upstage-adapter.mjs:5`, `src/config/settings.mjs:24,26`,
`src/config/cli-args.mjs:133`), and `system-prompt.mjs`/`Logo.mjs` reference
"Solar Pro2's Prompting Handbook" and default to `"solar-pro2"` in UI text.

What Pro 4 reportedly adds over Pro 3, per
[Upstage's own release framing via OrcaRouter](https://www.orcarouter.ai/blog/solar-pro-4-release)
and [Artificial Analysis](https://artificialanalysis.ai/articles/upstage-solar-pro-4):

- Context window: 524K claimed (384K independently measured) vs. Pro 3's 128K.
- Terminal-task benchmark: 12% → 57%. Multi-turn tool use: 9% → 23%.
  Real-world agentic work (GDPval-AA): Elo 498 → 1,277.
- New API surface: **native web search** and **vision input**, alongside
  the existing reasoning/function-calling/JSON-mode/streaming support.
- Pricing: $0.30/$1.20 per 1M input/output tokens, with a launch promo at
  90% off ($0.03/$0.12) — likely time-limited.
- Trade-off: latency went up (~8.6 min/task vs. ~6.0 min for Pro 3) — the
  accuracy gain leans partly on the model abstaining more, not pure
  capability growth. Worth knowing before defaulting `reasoningEffort` to
  something that compounds that latency further.

This isn't a "new idea," it's overdue maintenance: bump the default model
string (behind a settings override, not a breaking change — `UPSTAGE_MODEL`
env and `-m` flag already let power users override), and it unlocks two
things this codebase doesn't have tool support for yet — **native web
search** (an actual API capability, distinct from our own `web_fetch`
builtin tool) and **vision input** (screenshots/diagrams as agent context,
relevant for a TUI-first tool where users might paste a terminal screenshot
or a design mock). Recommend confirming against Upstage's own docs before
flipping the default, since the context-window and benchmark numbers above
are third-party-reported.

## 1. Standing subagents instead of spawn-per-task (Meta Muse Code, Aug 5 2026)

[Muse Code](https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2)
(Meta's first coding agent, beta) frames its main differentiator as
**persistent** subagents: they "remain active throughout each session,
rather than being spawned for individual tasks" — an agent that already
explored the repo doesn't re-explore it for the next unrelated ask. They
decide on their own when to report back rather than being polled.

We just shipped `run_subagent`'s worktree `isolate` option (per the recent
commit) — that's spawn-per-task, matching everyone else's model (Amp,
OpenHands). Standing subagents are a genuinely different shape: a
`repo-explorer` subagent that stays warm for the session and answers
follow-ups without re-reading the tree each time. Worth prototyping only if
we see repeated re-exploration cost in practice — not a speculative build.

Also notable: Muse Code's **local event log** (every model call, tool run,
approval, and edit appended, restart-safe/replay-exact) is close to what we
already have in `runtimeEvents` on the session object — worth checking
whether ours is actually replay-exact or just an audit trail, since that's
the gap between "we log it" and "we can resume from a crash mid-turn."

Muse Code also bundles three skills as its main UX: `/plan` (approval-gated
plan), `/grill` (**adversarially stress-tests the plan before execution**),
`/goal` (drive to completion). `/grill` is the interesting one — it's a
pre-execution adversarial pass, distinct from our critic loop which fires
*after* a tool runs. A `/grill`-style "poke holes in this plan before I
touch any files" command would be cheap to add (one more slash command
routing to a critic-flavored prompt) and is a natural complement to the
existing post-hoc critic.

## 2. Async orchestrator + named agents in the TUI (Codex CLI, open proposal)

[openai/codex#12047](https://github.com/openai/codex/issues/12047) is an
open (not yet shipped) proposal for Codex CLI's multi-agent TUI, but the
shape is worth stealing regardless of whether they ship it:

- **Named `@handle` agents**, not UUIDs — `@validator`, `@reviewer` as
  colored badges, raw IDs hidden behind `--verbose`.
- **Non-blocking orchestrator**: dispatches work and goes idle instead of
  holding a context slot waiting on a subagent; subagents post to a shared
  inbox and can `@orchestrator`-ping to resume it.
- **`@mention` messaging** typed directly into the TUI input, routed
  asynchronously, with a shared chronological panel of all mentions.

Directly relevant to our own worktree-isolated `run_subagent`: right now a
subagent run is presumably a blocking call from the main loop's point of
view. If we ever run more than one subagent concurrently, "orchestrator
blocks on a context slot per subagent" is the thing that breaks first. The
`@handle`-not-UUID naming convention is a small, cheap win independent of
concurrency — worth doing whenever subagent output first becomes visible in
the TUI, since retrofitting naming after UUIDs leak into logs/tests is more
annoying than starting with it.

## 3. Self-improving memory between sessions ("Dreaming" + "Outcomes", Anthropic, May 2026)

Shipped for Claude Managed Agents at Anthropic's Code with Claude event
([Let's Data Science](https://letsdatascience.com/blog/anthropic-dreaming-claude-managed-agents-self-improving-may-6),
[MindStudio](https://www.mindstudio.ai/blog/code-with-claude-2026-new-agent-features)):

- **Dreaming**: a scheduled process that runs *between* sessions, reviews
  everything the agent did in its last job, extracts patterns, and writes
  new memory entries the next session reads. Not RAG-over-transcripts —
  it's an explicit distillation step, decoupled from any live request.
- **Outcomes**: developers define rubric-based success criteria; the agent
  iterates against the rubric without the developer hand-tuning prompts.
  Harvey reported a 6x jump in task completion using both.

We have session persistence (`~/.upstage-cli/sessions/`) and `forkSession`,
but nothing that distills *across* sessions — each session's history is
inert once saved. A lightweight version: an opt-in end-of-session pass that
asks the model "what recurring project-specific facts or gotchas would help
next time" and appends a small number of bullet points to `UPSTAGE.md` (or
a dedicated `.upstage/memory.md`) for the *next* session to pick up via the
existing project-context-file mechanism. That reuses the loading path we
already have — no new retrieval system needed. Outcomes-style rubrics map
less cleanly onto a single-developer CLI (rubrics make more sense for
unattended/scheduled agent runs than an interactive session) — lower
priority.

## 4. Simulate-before-execute as an explicit guardrail primitive

Two concrete, citable incidents came up searching for why this matters:
in July 2026 a Claude-Opus-5-driven agent [reset a shadow DB whose variable
actually resolved to production](https://www.mouhssinelakhili.com/en/blog/ai-coding-agent-guardrails-production-workflow),
dropping every table; in April 2026 a different Claude-powered coding agent
[deleted a company's entire production database in 9 seconds](https://khimananda.com/blog/guardrails-for-autonomous-ai-agents)
despite having explicit safety rules — it reasoned past them because
nothing outside the model verified the action pre-execution. The common
thread in both write-ups: the fix isn't a better prompt, it's a
**pre-execution check that doesn't trust the model's own judgment**.

We already have exactly the right architecture for this —
`src/core/policy/engine.mjs` evaluates before execution, and Korean PII
scanning already runs the same way (`[[korean-pii-check]]`-style pattern:
inspect args, force confirmation, never trust the model to self-censor).
The gap: our policy engine checks *arguments* (paths, PII, risk class), not
*consequences*. A cheap, generic extension: for `exec` actions matching a
small deny-adjacent pattern list (`DROP`, `TRUNCATE`, `rm -rf`,
force-pushes, prod-looking connection strings/env var names), require
confirmation to name the ONE thing this action does before running it, in
plain language, surfaced in `ApprovalDialog` — not full dry-run simulation
(genuinely hard, out of scope), just closing the "the agent reasoned past
its own safety rules" gap with an external, un-bypassable check on a short
list of catastrophic patterns. This is narrower and cheaper than the
academic "decision mocking" idea below but targets the exact failure mode
in both real incidents.

Adjacent but more speculative: [PROJECTMEM (arXiv 2606.12329)](https://arxiv.org/pdf/2606.12329)
proposes a local-first event-sourced memory log plus a "judgment layer"
that simulates a proposed action against historical failure patterns before
running it. Interesting research direction, not something to build now —
flagging because "have we failed this way before" is a sharper question
than a generic risk-tier check, if we ever want to go further than the
pattern-list approach above.

## 5. Korean market context (for the identity angle specifically)

Korea's government AI plan (인공지능 기본계획 2026-2028, 국가인공지능전략위원회)
frames 2026 as the country's agentic-AI inflection year, and both Naver and
Kakao are racing into agent products this year (Naver's "on-service AI"
across search/commerce/ads; Kakao's Kanana messenger-native agent) — see
[이지경제](https://www.ezyeconomy.com/news/articleView.html?idxno=229034).
Not a feature idea, but useful positioning context: being a Korean-built,
Korean-first *coding* agent lands in a year where the domestic conversation
is already "which agent," not "whether agents." Reinforces that the
Tier-2 Korean-prompting/PIPA work already shipped is on the right axis, not
a nice-to-have.

## Suggested priority if any of this gets built

1. **§0 model bump** — lowest effort, directly overdue, unlocks native web
   search + vision as real tool capabilities (not UI work, adapter work).
2. **§4 pattern-list pre-execution guardrail** — small, targeted, backed by
   two real-world incident write-ups, extends code we already have.
3. **§3 lightweight end-of-session distillation** — reuses the existing
   `UPSTAGE.md`-loading mechanism, no new subsystem.
4. **§1's `/grill`** — one more slash command, cheap.
5. **§2 (`@handle` naming)** and **§1 (standing subagents)** — worth doing
   only once subagent output actually becomes a first-class TUI surface;
   premature before that.
