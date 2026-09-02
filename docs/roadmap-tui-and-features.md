# Roadmap: Claude-Code-esque quality bar, Solar-driven engine

**Direction as of 2026-09-02:** upstage-cli targets a Claude-Code-quality UX
and capability bar, but Solar is the engine doing the work — not a delegate
Claude Code orchestrates. See memory `project-mcp-subagent-direction` (marked
superseded) for the prior "delegate via MCP" strategy this replaces.

**TUI vehicle:** the Ink/React TUI (`src/ui/`) is being retired in favor of a
vendored opencode TUI (Solid.js + native Zig renderer via `@opentui/core`).
See `docs/superpowers/specs/2026-07-31-vendor-opencode-tui-phase1-design.md`
and `docs/superpowers/plans/2026-07-31-vendor-opencode-tui-phase1.md` for that
migration's spec/plan — **Section B below (the old Ink-phased plan) is
superseded by that effort** and kept only as historical rationale for *why*
the vendoring decision was made. Section C (capability gaps) is TUI-agnostic
and still the live roadmap. **Constraint kept across the migration:** the
existing color palette (`THEME` in `src/ui/colors.mjs` — pink-purple
`#E899F2`, blue `#8596F2`/`#3D6AF2`) and the wordmark/ASCII logo (resize
allowed) — re-theme the vendored TUI to match rather than keeping opencode's
own palette.

> Sources: see "References" at the bottom. Section A's "current state" data is
> grounded in `src/ui/App.mjs`, `Composer.mjs`, `StatusBar.mjs`, `tui.mjs` —
> i.e. the Ink TUI being replaced, not the vendored one.

---

## A. Where the TUI stands today

| Area | Today | Claude Code bar |
|---|---|---|
| Composer | single-line `ink-text-input`; ✦ focus dot | multiline, slash + `@file` autocomplete, history recall, paste/image |
| Live status | `▶ mode · status · tokens · cost` bar | spinner + elapsed + tokens + **context-left %** + "esc to interrupt" |
| Diffs | `DiffPreview` (26 lines, minimal) | syntax-highlighted, `+/-` gutters, hunk headers |
| Todos | not rendered | live checklist that updates as work proceeds |
| Modes | status shows mode | **shift+tab** cycles default → auto-accept → plan |
| Tool calls | compact line | grouped, expandable, result preview, nested subagent trace |
| Thinking | `Thinking` component | dim, collapsible reasoning blocks |
| Interrupt/queue | esc handling | esc-interrupt + **queue messages while running** |

The bones are good (unified event stream, sidebar tabs, vim-modal nav, i18n,
token/cost). The gaps are concentrated in the **input experience** and **live
feedback** — exactly what makes Claude Code feel responsive.

---

## B. TUI plan (phased) — SUPERSEDED, kept for historical rationale only

**Do not implement this section.** It described building these gaps
incrementally in Ink. That's superseded by vendoring opencode's TUI wholesale
(see the note at the top of this doc), which already natively has most of
these — multiline composer, slash/`@file` autocomplete, input history,
spinner+context%, todo rendering, syntax-highlighted diffs, collapsible
thinking blocks. The real work is the vendoring migration's own Phase 2
("protocol adapter" — wire `src/agent/loop.mjs` under opencode's HTTP+SSE
API) and Phase 3 ("feature parity" — port sessions/hooks/MCP/i18n/checkpoints
onto it), not rebuilding these items here. One item from this list is *not*
guaranteed free and needs an explicit verification step in that migration:
**Korean/Hangul text input correctness** (cursor position during Hangul IME
composition, East-Asian-width-aware rendering) — the current Ink `Composer.mjs`
uses bare `ink-text-input` with no wide-character handling, so this was a real
bug there; opencode's `@opentui/solid` renderer is a different stack and
should be checked directly rather than assumed fixed.

<details>
<summary>Original phased Ink plan (historical — do not build)</summary>

### Phase 1 — Input experience (highest perceived value)
1. **Multiline composer** with submit on Enter, newline on shift+Enter/`\`+Enter;
   replace bare `ink-text-input` with a controlled buffer (keep ✦ + palette).
2. **Slash-command autocomplete** dropdown: typing `/` lists skills/commands
   (`src/ui/commands.mjs`, `SkillsLoader`) with fuzzy ranking (reuse
   `command-palette.mjs`/`rankCommands`).
3. **`@file` mention autocomplete**: typing `@` fuzzy-searches the repo map and
   inserts a path; the loop already supports file context injection.
4. **Input history**: ↑/↓ recalls previous prompts (persist in session).
5. **Big-paste & image handling**: collapse large pastes to a chip; accept image
   paths/clipboard for multimodal-capable models (gate by adapter capability).

### Phase 2 — Live feedback while the agent runs
6. **Rich activity spinner**: animated glyph + elapsed seconds + live token count
   + **context-left %** + "esc to interrupt" hint (extend `StatusBar`).
7. **Inline todo list** rendering (checkbox states) driven by the existing
   `todo` tool — the single biggest "it's working" signal.
8. **Queue messages while running** instead of blocking the composer; flush on
   turn end.
9. **shift+tab mode cycling** (default → acceptEdits → plan) with a clear banner,
   matching Claude Code muscle memory.

### Phase 3 — Output rendering polish
10. **Syntax-highlighted diffs** with `+/-` gutters and hunk headers in
    `DiffPreview` (palette-based add/remove backgrounds already in `COLOR.diff`).
11. **Collapsible thinking + tool blocks**; Ctrl+R toggles a **verbose transcript**
    (full tool I/O) vs compact view.
12. **Nested subagent trace** in the sidebar Tools tab (we have subagents; surface
    their steps live).

### Phase 4 — Logo/identity (small, keep brand)
13. Keep the wordmark; add a **responsive logo**: full 19-line ASCII on tall
    terminals, the compact `◉ solar` wordmark on short/narrow ones (measure rows).

**Performance guardrail for all phases:** Ink re-renders on every yielded token.
Batch `stream_token` into ~16–33ms frames (debounced setState) and memoize the
message list, or large outputs will thrash the terminal. This is a prerequisite,
not an afterthought.

---

</details>

## C. Modern-agent feature gaps (utilities & capability)

Prioritized by leverage for closing capability gaps under the native-Solar-
driven architecture (Claude-Code-quality bar, Solar-powered engine — see the
note at the top of this doc).

### Tier 1 — close the obvious gaps
- **`/rewind` over existing checkpoints.** You already write checkpoints
  (`CheckpointManager`); there's no UI to restore one. Add `/rewind` to list and
  roll back files+conversation. High value, low effort.
- **Plan mode that truly read-only-gates** + presents a plan for approval (you
  have a `plan` permission mode; wire the "present plan, wait for accept" loop).
- **`@file`/`@dir` references in prompts** (pairs with Phase 1.3).
- **Richer, Claude-compatible hooks**: add `UserPromptSubmit`, `SessionEnd`,
  `PreCompact`, `SubagentStop`, and the stdin/exit-code decision contract so
  community hook scripts run unmodified. (Carried over from the MCP work.)
- **Plugin loader** reading `.claude-plugin/` layout → inherit the Claude plugin
  ecosystem (commands/agents/skills/hooks/`.mcp.json` in one bundle).

### Tier 2 — capability expansions
- **Background / parallel subagents** with isolated context windows (today they're
  sequential, in-process). Pair with **git-worktree isolation** for safe parallel
  edits. **Caveat (2026-09-02):** Anthropic's own multi-agent engineering
  writeup explicitly flags real-time coordination over tightly-coupled state as
  a poor fit for multi-agent parallelism, and reports ~15x the token cost of
  single-agent — don't build unrestricted parallel fan-out. Scope parallelism
  to read-only/explorer-role subagents (independent investigations); keep
  write-capable subagents (editor/reviewer) sequential by default.
- **Multimodal input** (images/screenshots) for adapters that support it.
- **IDE bridge** (VS Code extension or the existing `--bridge-json` NDJSON
  protocol surfaced as an LSP/extension) — the single biggest reach gap vs
  Claude Code/Cursor.
- **Spec-driven mode**: a `/spec` that writes a feature spec to `UPSTAGE.md`-style
  persistent memory the agent references across turns (2026's "context
  engineering" trend).

### Tier 3 — performance & cost
- ~~**Parallel tool execution** for independent read/search calls in one step.~~
  **Done** — `executeToolCallsPhase` in `src/agent/loop.mjs` runs a turn's tool
  calls concurrently when every call in that turn is a "low risk" tool.
- ~~**Incremental repo indexing**~~ — **Done** (partially): `buildIntelligenceIndex`
  now reparses only changed files each run instead of the whole repo. Still
  missing: a file-watcher to trigger reindex without an explicit rebuild call
  (currently reindex only runs when something calls `buildIntelligenceIndex`
  again, e.g. `/tree` or the `repo_map`/`find_symbol` tools).
- **Prompt/context caching**: stop re-sending the full system+repo context every
  turn; cache the stable prefix and send deltas. **Blocked** — Upstage's Solar
  API docs don't document a prompt-caching primitive as of 2026-07; revisit if/
  when they add one rather than building a speculative client-side cache now.
- **Streaming-render batching** (see Phase 2 guardrail) — also a perf item, and
  TUI-side (`src/ui/stream-batcher.mjs` already exists — verify it's wired into
  `App.mjs`'s `stream_token` handling during the manual TUI session).
- **Cost/usage dashboard**: per-session and rolling token+cost, reusing the
  harness `CostTracker`. Still open — TUI-side.

### Note: Solar Pro 3 / Pro 4 and the native-Solar decision
Upstage has since released **Solar Pro 3** (SWE-Bench 14.5→28.6, Tau2 tool-use
36.0→72.3 vs. Pro2) and **Solar Pro 4** (Aug 2026: Terminal-Bench 2.1 score of
57, 512K context, adjustable reasoning effort — marketed as "the agentic model
that finishes the job"). The June eval that motivated the "delegate, not
autonomous agent" direction ran against Pro2 only. As of 2026-09-02 the
strategic decision has been made explicitly (native-Solar-driven, see memory
`project-mcp-subagent-direction`, now marked superseded) rather than gated on
a fresh live re-eval — `DEFAULT_MODEL` in `src/model/upstage-adapter.mjs`
should move to `solar-pro4` as part of that work, not stay pinned to `solar-pro2`.

---

## D. Suggested execution order

**TUI track:** follow the opencode-TUI-vendoring spec/plan's own phases
(Phase 1 shell spike → Phase 2 protocol adapter → Phase 3 feature parity →
Phase 4 cutover), not the superseded Section B ordering above.

**Capability track (TUI-agnostic, can proceed independently):**
1. Native-Solar modernization — default model to `solar-pro4`, per-model
   capability table, wire reasoning-effort/response-format.
2. **Tier-1 `/rewind` + plan-mode gating** (cheap, high-value capability;
   `/rewind` is already built per memory — confirm still wired, not stale).
3. System-prompt overhaul + verification hardening (see the 2026-09-02
   agentic-capabilities spec).
4. Then Tier-2/Tier-3 by appetite (hooks + plugin loader complete the
   "Claude-compatible" story; caching + parallelism are the perf story).

Each item is independently shippable and testable — keep the existing test
discipline (Node's built-in test runner, `.test.mjs` files).

---

## References
- [Best AI Coding Agents 2026 — Vellum](https://www.vellum.ai/blog/best-ai-coding-agents)
- [State of AI Coding Agents 2026 — long-running autonomous loops](https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a)
- [Claude Code TUI components / quality skill](https://mcpmarket.com/tools/skills/engram-tui-quality)
- [Building a Claude-Code-like TUI (Agent SDK)](https://www.mager.co/blog/2026-03-14-claude-agent-sdk-tui/)
- [Subagent tracing in TUIs (Ralph TUI / Claude Code)](https://ralph-tui.com/docs/plugins/agents/claude)
- [Claude Code hooks reference (lifecycle events)](https://code.claude.com/docs/en/hooks)
