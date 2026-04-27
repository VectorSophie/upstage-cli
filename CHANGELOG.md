# Changelog

All notable changes to upstage-cli are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
