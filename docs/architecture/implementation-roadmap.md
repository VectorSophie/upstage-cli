# upstage-cli Implementation Roadmap (Node-first)

## Decisions locked

This roadmap reflects the current project decisions:

- Runtime strategy: Node first, Rust later.
- Intelligence strategy: tree-sitter first, LSP later.
- Retrieval strategy: Upstage embeddings first, local fallback required.
- UX strategy: Gemini-like UX as a later milestone, not a blocker for runtime foundations.

## Current baseline

The repository already has a working MVP loop and tool host seed:

- Agent loop and patch/verify behavior: `src/agent/loop.js`
- Context packing seed: `src/agent/context-builder.js`
- Tool registry and risk flagging: `src/tools/registry.js`
- Session persistence seed: `src/runtime/session.js`
- Upstage chat adapter: `src/model/upstage-adapter.js`

## Milestones

## M1: Runtime Spine and Safety Contracts

Goal: stabilize execution boundaries before adding more tools, agents, and UI complexity.

Exit criteria:

- Hook lifecycle exists and is invoked on every turn/tool call.
- Policy engine supports more than high/low risk binary checks.
- Tool scheduler has explicit states and deterministic event stream.
- Session traces include policy/hook/tool decisions.

### Tickets

- `M1-T01` Define runtime event schema and event bus in `src/core/events/`.
- `M1-T02` Add hook system (`BeforeAgent`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `AfterAgent`).
- `M1-T03` Introduce policy engine with action classes (`read`, `write`, `exec`, `network`, `git`, `publish`).
- `M1-T04` Refactor `ToolRegistry.execute()` to enforce policy + hook interception.
- `M1-T05` Add approval handlers for interactive and non-interactive mode.
- `M1-T06` Add golden transcript tests for deterministic loop events.

Dependencies: none.

## M2: Extensible Tools (MCP + Discovery)

Goal: evolve static tools into a dynamic, extensible tool platform.

Exit criteria:

- MCP servers can be configured and loaded at runtime.
- Discovered tools can be registered/unregistered without restart.
- Policy and hooks apply consistently to built-in and external tools.

### Tickets

- `M2-T01` Add MCP client manager in `src/tools/mcp/`.
- `M2-T02` Add MCP tool wrapper and name qualification strategy.
- `M2-T03` Add project tool discovery command support in `src/tools/discovery/`.
- `M2-T04` Add tool metadata model (source, risk class, permissions, timeout, output budget).
- `M2-T05` Add registry sorting/filtering by active profile and policy mode.
- `M2-T06` Add compatibility tests for built-in + MCP + discovered tool coexistence.

Dependencies: M1 complete.

## M3: Repository Intelligence v1 (Tree-sitter first)

Goal: replace lexical indexing with incremental, ignore-aware semantic indexing.

Exit criteria:

- Indexing uses tree-sitter parser pipelines for major languages in target repos.
- Index updates incrementally based on file change deltas.
- Symbol, reference, and module graph queries are stable on medium/large repos.

### Tickets

- `M3-T01` Add ignore-aware scanner with `.gitignore` and tool-specific ignore support.
- `M3-T02` Implement parser adapter layer in `src/indexer/parsers/` using tree-sitter.
- `M3-T03` Build persistent index store (`symbols`, `refs`, `files`, `imports`, `updated_at`).
- `M3-T04` Replace `src/indexer/intelligence.js` query internals with index-backed queries.
- `M3-T05` Keep existing tool API contracts (`find_symbol`, `find_references`, `list_modules`) stable.
- `M3-T06` Add index health and staleness diagnostics command.

Dependencies: M1 complete. M2 optional.

## M4: Retrieval v1 (Upstage + local fallback)

Goal: add production retrieval for context packing and repomap generation.

Exit criteria:

- Chunking + embedding + retrieval pipeline is live.
- Upstage embedding path is default.
- Local embedding fallback auto-activates on outage/rate-limit and records mode in metadata.
- Context builder uses semantic retrieval + structural repomap within budget.

### Tickets

- `M4-T01` Implement chunker with language-aware chunk boundaries and overlap.
- `M4-T02` Add Upstage embeddings adapter in `src/retriever/providers/upstage.js`.
- `M4-T03` Add local embeddings fallback provider in `src/retriever/providers/local.js`.
- `M4-T04` Add vector storage and top-k retrieval in `src/retriever/store/`.
- `M4-T05` Integrate retriever results into `src/agent/context-builder.js` with budget partitions.
- `M4-T06` Upgrade `repo_map` output to include key symbols and relevance ranking.

Dependencies: M3 complete.

## M5: Multi-agent Delegation v1

Goal: move from single-loop execution to scoped delegated agents.

Exit criteria:

- Parent agent can delegate scoped tasks to subagents.
- Subagent runs with isolated context and restricted tool allowlist.
- Parent receives structured summary/artifacts from subagent.

### Tickets

- `M5-T01` Add agent registry (`planner`, `explorer`, `editor`, `reviewer`) in `src/agent/registry/`.
- `M5-T02` Add `run_subagent` tool and result schema.
- `M5-T03` Implement child session management and compaction.
- `M5-T04` Add scheduling policy for parallel vs sequential subagent runs.
- `M5-T05` Add subagent observability in session traces and UI logs.
- `M5-T06` Add safety tests for delegated high-risk operations.

Dependencies: M1 complete. M3 and M4 strongly recommended.

## M6: Gemini-like UX (later milestone)

Goal: deliver Gemini-like polish after runtime foundations are stable.

Exit criteria:

- Interactive UX supports command palette, session picker, approval panels, and progress lanes.
- Non-interactive mode has structured stream output for automation.
- UX surfaces policy/hook/subagent events clearly.

### Tickets

- `M6-T01` Refactor `src/ui/tui.js` into componentized views and state slices.
- `M6-T02` Add slash command palette and fuzzy command search.
- `M6-T03` Add session explorer/resume UI backed by `src/runtime/session.js`.
- `M6-T04` Add approval dialogs for tool calls and policy blocks.
- `M6-T05` Add task/subagent activity panel with structured event rendering.
- `M6-T06` Add json streaming mode parity for headless and CI usage.

Dependencies: M1 and M5 complete.

## M7: LSP Augmentation (after tree-sitter baseline)

Goal: add language-server precision on top of the index/retrieval baseline.

Exit criteria:

- LSP diagnostics/query tools can run for configured languages.
- LSP results are merged with tree-sitter index results.
- Context builder can prioritize active diagnostics in code edit loops.

### Tickets

- `M7-T01` Add LSP client manager and per-language process lifecycle.
- `M7-T02` Add diagnostics collection tool and cache.
- `M7-T03` Add symbol definition/reference bridge with fallback to tree-sitter index.
- `M7-T04` Add file watcher bridge for `didOpen`/`didChange` updates.
- `M7-T05` Add confidence ranking merge between LSP and index query results.

Dependencies: M3 complete.

## Cross-milestone constraints

- No regression in current CLI behavior (`single prompt` and `interactive`).
- Every milestone must include:
  - contract tests for public tool interfaces,
  - integration tests for loop + tool + policy behavior,
  - migration notes for session format changes.
- Keep API compatibility for existing tools where possible; version when breaking changes are unavoidable.

## Suggested implementation order

1. M1 Runtime spine
2. M2 Extensible tools
3. M3 Tree-sitter index
4. M4 Retrieval with Upstage + local fallback
5. M5 Multi-agent delegation
6. M6 Gemini-like UX
7. M7 LSP augmentation

## Immediate next sprint (start now)

Target: complete M1 foundation slice in one sprint.

- Sprint ticket set: `M1-T01`, `M1-T02`, `M1-T03`, `M1-T04`.
- Demo criteria:
  - one full turn emits structured lifecycle events,
  - one tool call goes through hook + policy checks,
  - session trace shows all decision points,
  - existing interactive mode still works.
