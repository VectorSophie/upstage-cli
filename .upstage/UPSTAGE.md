# Project Context — upstage-cli

This project is the Korean Gemini CLI, a Korean-first terminal coding agent powered by Upstage Solar Pro2.

## Architecture
- Zero build step: pure ESM (.mjs), React.createElement (no JSX), run directly with `node`
- Agent loop: async generator (`async function* runAgentLoop()`) yielding typed events
- 5-layer settings: defaults → user → project → local → env
- Ink v6 TUI with sidebar, diff preview, approval dialog, command palette
- Korean-first i18n with English fallback

## Key Conventions
- All source files use `.mjs` extension
- No Babel, no transpilation
- Use `React.createElement()` instead of JSX
- Korean (ko) is the default language; English (en) is the fallback
- Tool contract: `{ name, description, risk, actionClass, inputSchema, execute }`
- OpenAI-compatible tool_calls format (Upstage API), not Anthropic tool_use blocks

## Common Commands
- `npm test` — Run all tests
- `node src/cli/index.mjs` — Start the CLI
- `node src/cli/index.mjs ask "your prompt"` — One-shot mode

## Testing
- Uses Node.js built-in test runner (`node:test`)
- Test files: `tests/m*.test.mjs`
- Agent loop tests use `collectAgentLoop()` helper
