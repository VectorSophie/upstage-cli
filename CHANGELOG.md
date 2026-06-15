# Changelog

All notable changes to upstage-cli are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]
### Added
- **IDE bridge (`upstage-bridge`)** — bidirectional NDJSON-over-stdio protocol so
  an editor extension can drive the agent (initialize/prompt/cancel/ping; streams
  every agent event tagged by prompt id, ends with a result). Testable protocol
  core (`src/bridge/bridge-server.mjs`) + real entrypoint. See `docs/ide-bridge.md`.
- **`run_subagent({ isolate: true })`** — run a delegated subagent on an isolated
  git worktree/branch; writes stay confined to the worktree, its diff is returned,
  and it's always cleaned up. Enables safe parallel subagent edits.
- **TUI render tests** — added `ink-testing-library` (dev) and actual frame-output
  tests for `<Composer>`, `<StatusBar>`, and the extracted `<AutocompleteStrip>`.
- **Claude-compatible hooks** — command hooks now use the Claude contract (event
  JSON on stdin, exit 2 blocks, stdout JSON decision). New lifecycle events wired
  in: `UserPromptSubmit` (block/inject context), `PreCompact` (veto compaction),
  `SessionEnd`, `SubagentStop`. (`src/hooks/engine.mjs`)
- **`/rewind`** — list and restore the on-disk file checkpoints (revert a file to
  its pre-edit content, or delete it if it was new). (`src/core/rewind.mjs`)
- **`.claude-plugin` PluginLoader** — discover Claude-compatible plugins under
  `.claude/plugins`/`.upstage/plugins` and merge their commands/agents/skills/
  hooks/`.mcp.json` at startup. (`src/plugins/loader.mjs`)
- **`@file` mentions** — `@path` tokens in a prompt inject file contents (confined
  to cwd, 64KB cap). (`src/agent/file-mentions.mjs`)
- **TUI**: composer slash-command autocomplete strip, **Tab** to accept,
  **shift+tab** permission-mode cycling (default → accept edits → plan), and a
  responsive logo (full ASCII on large terminals, compact wordmark when cramped).
  Backed by tested pure-logic modules (autocomplete, input-history, mode-cycle,
  stream-batcher, responsive-logo).
- **Git-worktree isolation** (`src/core/worktree.mjs`) — run work on an isolated
  checkout/branch and collect its diff; foundation for safe parallel subagents.
- **`/spec`** — persist feature specs into `UPSTAGE.md`'s `## Specs` section
  (auto-merged into the system prompt) for spec-driven memory. (`src/core/spec.mjs`)
- **MCP Streamable-HTTP transport (`src/tools/mcp/http-client.mjs`)** — connect to
  remote MCP servers, not just local stdio. Implements the current Streamable HTTP
  transport (MCP spec 2025-03-26+): single-endpoint JSON-RPC over POST, responses
  as JSON *or* SSE, `Mcp-Session-Id` propagation, `MCP-Protocol-Version` header,
  and session teardown via HTTP DELETE. `.mcp.json` `url` entries now connect
  (`{ "<name>": { "url": "https://host/mcp", "headers": {...} } }`) instead of
  being skipped. Verified live against `@modelcontextprotocol/server-everything`
  in `streamableHttp` mode. Tests: `tests/m19-mcp-http.test.mjs`.
- **Real MCP client (`src/tools/mcp/stdio-client.mjs`)** — a genuine JSON-RPC 2.0
  client over the MCP stdio transport (initialize handshake +
  `notifications/initialized`, `tools/list`, `tools/call`, id correlation,
  per-request timeouts, isolated failure). Replaces the previous in-memory stub:
  upstage-cli can now **consume the real MCP ecosystem**. Verified live against
  `@modelcontextprotocol/server-everything` (13 tools, `echo` round-trip).
- **Claude-compatible `.mcp.json` config** (`src/tools/mcp/config.mjs`) — reads
  `{ "mcpServers": { name: { command, args, env } } }` from project `.mcp.json`
  and `settings.mcpServers`, connects each stdio server at CLI startup, and
  registers their tools (`<server>__<tool>`). Remote `url`/`http`/`sse` entries
  are recognized and skipped with a warning (stdio-only for now). A failing
  server is logged and skipped, never fatal. Legacy `UPSTAGE_MCP_SERVERS_MODULE`
  still works. Tests: `tests/m18-mcp-client.test.mjs` (offline mock fixture).
- **MCP server (`src/mcp/upstage-server.mjs`, `upstage-mcp` bin)** — exposes the
  Solar agent as a delegatable subagent over standard MCP stdio (initialize /
  tools/list / tools/call). Two tools: `upstage_delegate` (read/write/test/
  self-correct, confined to `cwd`) and `upstage_ask` (read-only). Wireable into
  Claude Code via `.mcp.json`; see `docs/claude-code-integration.md`.
- `scripts/mcp-smoke.mjs` manual smoke client; `tests/m17-mcp-server.test.mjs`
  protocol-contract tests (no API key required).

### Fixed
- **Windows: sandboxed `spawn` of `.cmd` shims** (`npm`, `npx`, …) failed with
  `ENOENT` because `shell: false` can't resolve them — broke the critic loop and
  `run_tests`. Now enables the shell only on `win32` (args are already validated
  against shell metacharacters).
- **`TOOL_LOG` runtime event was unregistered** in the event schema, so any tool
  emitting a log line (e.g. `run_tests` stderr) threw `Unsupported runtime event
  type` and crashed the run. Added it to the allowed set.

## [2.4.0] - 2026-04-27
### Added
- 7 new built-in tools: `glob`, `grep`, `delete_file`, `rename_file`, `multi_edit`, `web_fetch`, `web_search`
- `read_file` now accepts `offset` and `limit` params for reading slices of large files
- `web_search` uses Tavily API (`TAVILY_API_KEY`); returns content snippets and AI-synthesized answer
- `grep` uses ripgrep when available, falls back to JS regex scan
- `glob` supports full `**` patterns with configurable root and maxResults
- Total built-in tools: 24 → 30

## [2.3.0] - 2026-04-27
### Added (harness Phase D)
- `ReplayEngine`: replay recorded agent runs without calling the live model; detects tool divergences
- MCP stdio server with 8 harness tools (filesystem/read/write/list, shell/run, git/diff/status, test/run, static_analysis/run)
- 6 context injection strategies: default, full-repo, failing-test, recent-diffs, retrieval, symbol-graph
- Human review: 5-dimension (1–5) scoring saved back to run artifact
- HTML dashboard: dark-theme multi-run table with SVG sparkline trend charts
- `harness replay` and `harness review` CLI commands
- Tests: 135 passing (h1–h5, h7–h9)

## [2.2.0] - 2026-04-27
### Added (harness Phase C)
- `DockerSandbox`: 3-tier layered image cache, bind-mount workspace, `--network none`
- `NativeSandbox`: thin wrapper over existing `src/sandbox/exec.mjs`
- `selectSandbox()`: auto-detects Docker availability, falls back to native gracefully
- `SafetyGuardrails`: 5 detection categories (secret exfiltration, destructive commands, dependency confusion, prompt injection, privilege escalation)
- `SKIP_DOCKER=1` env gate for CI environments without Docker

## [2.1.0] - 2026-04-27
### Added (harness Phase B)
- `AgentRegistry`: discover and instantiate adapters by id
- External subprocess adapters: `ClaudeCodeAgent`, `AiderAgent`, `OpenCodeAgent`
- `comparisonTable()`: 10-column Markdown side-by-side diff of two agent runs
- `harness compare` command with `--parallel` flag

## [2.0.0] - 2026-04-27
### Added (harness Phase A)
- Evaluation harness (`harness/`) — zero modifications to `src/`
- Task spec format (YAML with `_import` composition, SWE-bench FAIL_TO_PASS + PASS_TO_PASS split)
- `TaskRunner`: 12-step orchestration (validate → copy fixture → git init → baseline → agent → checks → score → diff → taxonomy → persist)
- 5-component weighted scoring formula (checks 60%, patchMinimality 15%, toolCallCount 10%, costUsd 10%, speedMs 5%)
- 5-dimension failure taxonomy (12 root-cause symptoms, deterministic detection)
- `MockAgent`: applies fixture patches from `README.fixture.md`, usable with no API key
- `UpstageAgent`: wraps existing `runAgentLoop` / `collectAgentLoop`
- `PatchTracker`, `AuditLog`, `CostTracker` tracking subsystem
- Reports: Markdown, JSON, SWE-bench JSONL predictions
- Fixtures: `missing-import`, `flaky-test`, `security-bug`
- `harness run`, `harness report` CLI commands
- `pass@k` unbiased estimator

## [1.9.0] - 2026-04-27
### Added
- ContextManager + CheckpointManager with auto-compaction at 80% token usage
- Slash command registry and markdown renderer
- TUI redesign: compact ✦✧ logo, vim-modal navigation, sidebar tabs

## [1.4.1] - 2026-04-27
### Added
- CI harness: GitHub Actions (ci.yml, release.yml), ESLint flat config, c8 coverage, smoke test
- `npm run lint`, `npm run smoke`, `npm run ci` scripts

## [1.4.0] - 2026-04-27
### Added
- 6 permission modes: default, bypassPermissions, acceptEdits, auto, dontAsk, plan
- Shell injection detection in permission checker
- Write-path validation (restricts edits to `process.cwd()`)
- `SECURITY_OVERRIDE=true` env bypass for development

## [1.3.0] - 2026-04-26
### Added
- 5-layer settings cascade: global → project → local → env → CLI flags
- `UPSTAGE.md` project context loader (analogous to CLAUDE.md)
- `loadSettings()` with `deepMerge` for nested config

## [1.2.0] - 2026-04-25
### Changed
- Rewrote agent loop as `async function*` (typed event generator)
- All consumers (TUI, CLI) now receive a unified event stream
- New event types: `stream_token`, `tool_start`, `tool_result`, `thinking`, `patch_preview`, `token_usage`, `system_warning`, `compaction`

## [1.1.0] - 2026-04-24
### Changed
- Removed Babel build step — all source is `.mjs` ESM, zero build
- `node src/cli/index.mjs` runs directly

## [1.0.0] - 2026-04-23
### Added
- Multi-pane Ink/React TUI (chat + sidebar + status bar)
- Solar Pro2 adapter with streaming SSE
- Tool registry with 17 built-in tools (read, write, exec, intel, github)
- Session persistence (`~/.upstage-cli/sessions/`)
- Korean-first i18n (KO/EN)
- Policy engine with risk-based action classes
- Hook system (BeforeAgent, BeforeTool, AfterTool, etc.)
- MCP client integration
- Subagent support via `run_subagent` tool
