# Aider and Continue.dev Comparative Analysis

## Scope

This supplement ensures full coverage of all requested reference projects.

Primary references:

- https://github.com/Aider-AI/aider
- https://aider.chat/docs/repomap.html
- https://aider.chat/2024/09/26/architect.html
- https://github.com/continuedev/continue
- https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/README.md

## Aider

### Language choices

- Python-first architecture with broad model/provider adapters.

### Architecture

- Git-native terminal assistant with edit-format-driven patching.
- Emphasis on repo map generation and bounded context inclusion.

### Memory strategy

- "Repo map" as compressed structural memory of whole repository.
- Dynamic relevance-based selection of map slices.

### Agent loop

- Iterative coding loop with optional Architect/Editor split.
- Architect model reasons; Editor model formats executable edits.

### Tool system

- Strong integration with git, lint/test workflows, and shell-assisted validation.
- Supports multiple edit formats for deterministic patch application.

### Authentication

- Provider-key based environment variable strategy across many model vendors.

### Codebase navigation

- Key differentiator: repo-map graph ranking and token-aware selection.

### Terminal UI approach

- Terminal-centric conversational interface, optimized for coding workflows over decorative UI complexity.

## Continue.dev (including Continue CLI)

### Language choices

- TypeScript-heavy monorepo with extension surfaces (VS Code/JetBrains/CLI), plus smaller polyglot components.

### Architecture

- Source-controlled AI checks and customizable agent behaviors.
- Product now spans IDE and CLI/CI workflows.

### Memory strategy

- Session persistence in CLI mode and context-provider driven retrieval in broader platform.

### Agent loop

- Command and check-driven agent execution, especially in CI and PR workflows.

### Tool system

- CLI supports interactive and headless operation.
- Configuration-driven behavior and command set (`cn`, `cn ls`, `cn login`, `cn serve`).

### Authentication

- Explicit `cn login/logout` flow with profile-based usage.

### Codebase navigation

- Leverages context provider model in wider Continue platform and session-aware CLI interaction.

### Terminal UI approach

- Interactive TUI for local use and headless mode for automation/TTY-less environments.

## Direct Takeaways for upstage-cli

1. Adopt Aider-style repo-map compression for large repository grounding.
2. Adopt Aider Architect/Editor split as an optional advanced mode.
3. Adopt Continue-style first-class headless mode for CI automation.
4. Keep auth UX explicit (`login`, `logout`, `status`) for enterprise operators.
