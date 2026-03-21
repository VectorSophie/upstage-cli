# upstage-cli Product Requirements Document

## Problem Statement

Developers increasingly rely on AI coding agents, but existing terminal tools force trade-offs across model choice, performance, safety, and repository-scale reliability. Upstage users need a first-class coding CLI that matches leading UX while being deeply optimized for Upstage models and enterprise operating constraints.

## Product Vision

Build `upstage-cli`: a modern AI coding agent for terminal-native development with:

- Gemini CLI-grade conversational UX
- Opencode-like extensible tool ecosystem
- Upstage-native model and embedding support
- Rust performance core
- TypeScript reasoning/orchestration layer

## Target Users

1. **Individual developers** working in local repos and terminal workflows.
2. **AI-first teams** needing auditable code generation/refactoring pipelines.
3. **Platform/DevOps teams** integrating coding agents into CI and GitHub workflows.
4. **Korean/English bilingual engineering orgs** prioritizing Upstage model strengths.

## Key Features

1. Interactive coding chat with streaming output and resumable sessions.
2. Safe file editing pipeline with diff preview and patch apply.
3. Repository-scale navigation (symbol search + embeddings + file graph).
4. Tool framework (filesystem, shell, git, GitHub, web retrieval).
5. Deterministic agent loop with explicit stop reasons and budget controls.
6. Auth flow (`upstage login`) with env/config support.
7. Sandbox profiles (`read-only`, `workspace-write`, `danger-full-access`).
8. Verification pipeline integration (lint/test/build gates).

## Non-Goals (Initial Releases)

1. Full IDE replacement (focus is terminal-first).
2. Fully autonomous long-running cloud agents with no human confirmation.
3. Cross-organization multi-tenant control plane in v1.
4. Real-time collaborative multi-user session editing in terminal.

## Success Metrics

## Adoption

- Weekly active CLI users
- Session completion rate
- Median sessions per developer per week

## Quality

- Patch apply success rate
- Verification pass rate after agent edits
- Hallucinated-file edit rate (should trend toward zero)

## Performance

- Time-to-first-token
- End-to-end task completion latency
- Retrieval/index query latency in medium/large repos

## Reliability/Safety

- Tool execution failure rate by category
- Sandbox policy violation count
- Secret leakage incidents in logs/output

## MVP Scope

- Upstage model integration (chat + embeddings)
- Core tools: read/write/edit/search/shell/git status/diff
- Session persistence and resume
- Diff preview/apply flow
- Fast verify profile

## Post-MVP Expansion

- GitHub PR/issue tools
- Multi-agent planner/editor/reviewer lanes
- Advanced symbol intelligence and refactor tooling
- Optional graph orchestration for parallel investigations
