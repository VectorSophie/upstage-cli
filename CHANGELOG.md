# Changelog

All notable changes to upstage-cli are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
