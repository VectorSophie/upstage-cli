# Roadmap: Claude-Code-esque TUI + modern-agent feature gaps

Research-backed plan to evolve upstage-cli's terminal UX and close feature gaps
versus 2026 agents (Claude Code, Cursor, Cline, Codex). **Constraints kept:** the
existing color palette (`THEME` in `src/ui/colors.mjs` — pink-purple `#E899F2`,
blue `#8596F2`/`#3D6AF2`) and the wordmark/ASCII logo (resize allowed).

> Sources: see "References" at the bottom. Current state is grounded in
> `src/ui/App.mjs`, `Composer.mjs`, `StatusBar.mjs`, `tui.mjs`.

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

## B. TUI plan (phased)

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

## C. Modern-agent feature gaps (utilities & capability)

Prioritized by leverage for *your* Claude-Code-driven workflow.

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
  edits.
- **Multimodal input** (images/screenshots) for adapters that support it.
- **IDE bridge** (VS Code extension or the existing `--bridge-json` NDJSON
  protocol surfaced as an LSP/extension) — the single biggest reach gap vs
  Claude Code/Cursor.
- **Spec-driven mode**: a `/spec` that writes a feature spec to `UPSTAGE.md`-style
  persistent memory the agent references across turns (2026's "context
  engineering" trend).

### Tier 3 — performance & cost
- **Prompt/context caching**: stop re-sending the full system+repo context every
  turn; cache the stable prefix and send deltas. Biggest token/cost/latency win
  if the Solar API exposes any cache or you reuse context client-side.
- **Parallel tool execution** for independent read/search calls in one step.
- **Incremental repo indexing** (watch + dirty-file reindex) instead of full
  rebuilds; lazy-load the retrieval index.
- **Streaming-render batching** (see Phase 2 guardrail) — also a perf item.
- **Cost/usage dashboard**: per-session and rolling token+cost, reusing the
  harness `CostTracker`.

---

## D. Suggested execution order

1. **Phase 1.1–1.4 + the render-batching guardrail** (the input + perf core).
2. **Phase 2** (live feedback: spinner/context-%, todos, queue, shift+tab).
3. **Tier-1 `/rewind` + plan-mode gating** (cheap, high-value capability).
4. **Phase 3** diffs/transcript polish.
5. Then Tier-2/Tier-3 by appetite (hooks + plugin loader complete the
   "Claude-compatible" story; caching + parallelism are the perf story).

Each phase is independently shippable and testable (Ink components are unit-
testable with `ink-testing-library`; keep the existing test discipline —
246 tests today).

---

## References
- [Best AI Coding Agents 2026 — Vellum](https://www.vellum.ai/blog/best-ai-coding-agents)
- [State of AI Coding Agents 2026 — long-running autonomous loops](https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a)
- [Claude Code TUI components / quality skill](https://mcpmarket.com/tools/skills/engram-tui-quality)
- [Building a Claude-Code-like TUI (Agent SDK)](https://www.mager.co/blog/2026-03-14-claude-agent-sdk-tui/)
- [Subagent tracing in TUIs (Ralph TUI / Claude Code)](https://ralph-tui.com/docs/plugins/agents/claude)
- [Claude Code hooks reference (lifecycle events)](https://code.claude.com/docs/en/hooks)
