# upstage-cli Tool System Design

## Goals

- Modular, typed, and secure tool architecture.
- Deterministic tool execution semantics.
- Clear permission model for safe local automation.

## Core Tool Interface

Each tool implements a shared contract:

```ts
type ToolSpec<I, O> = {
  name: string;
  description: string;
  category: "read" | "edit" | "execute" | "git" | "github" | "network";
  risk: "low" | "medium" | "high";
  inputSchema: JsonSchema<I>;
  outputSchema: JsonSchema<O>;
  timeoutMs: number;
  requiresConfirmation: boolean;
};
```

Execution envelope:

```ts
type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  requestContext: {
    cwd: string;
    sandboxProfile: "read-only" | "workspace-write" | "danger-full-access";
    userApproved: boolean;
  };
};
```

## Core Tools

- `read_file`
- `write_file`
- `edit_file`
- `search_code`
- `run_shell`
- `git_diff`
- `git_commit`
- `git_status`
- `create_patch`

### Recommended semantics

- `write_file`: full-file create/overwrite, always diff-previewed.
- `edit_file`: surgical replacement operations with conflict detection.
- `create_patch`: returns structured patch object before apply.
- `run_shell`: command allow/deny policy + timeout + output cap.

## GitHub Tools

- `gh_pr_create`
- `gh_issue_read`
- `gh_issue_comment`
- `gh_pr_review`

Execution model:

- Prefer GitHub CLI (`gh`) in isolated subprocess.
- Parse outputs into structured JSON for model consumption.
- Mask tokens/secrets in both logs and tool observations.

## Tool Registration

Registration is explicit and versioned:

1. Tool defines `ToolSpec`.
2. Tool is added to registry with version tag.
3. Registry enforces unique `(name, version)`.
4. Deprecated tools are marked non-default but still replayable for old sessions.

## Tool Permissions

## Risk classes

- **Low**: read-only (`read_file`, `search_code`, `git_status`)
- **Medium**: local mutation (`edit_file`, `write_file`, `create_patch`)
- **High**: shell execution, commit, remote GitHub mutations

## Policy rules

- High-risk tools require explicit confirmation.
- In `read-only` sandbox, only low-risk tools are executable.
- In `workspace-write`, medium-risk allowed, high-risk confirmation required.
- In `danger-full-access`, all tools available but high-risk still confirmation-gated by default policy.

## Tool Sandboxing

Sandbox controls:

- Working directory confinement
- Path allowlist enforcement
- Command timeout and output truncation
- Environment filtering (drop secrets unless explicitly needed)
- Optional network deny mode for local-only runs

## Tool Result Contract

```ts
type ToolResult = {
  id: string;
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: {
    code: "VALIDATION" | "PERMISSION" | "TIMEOUT" | "EXECUTION" | "INTERNAL";
    message: string;
    retryable: boolean;
  };
  timingMs: number;
};
```

## Agent Integration Pattern

1. Agent selects tool call.
2. Runtime validates schema + policy.
3. User confirmation requested when required.
4. Tool executes under sandbox.
5. Structured result is appended to loop observations.

## Auditing and Replay

- Store every call/result pair with timestamps and policy decisions.
- Redact secrets in persisted traces.
- Enable deterministic replay mode by feeding recorded results into loop for regression tests.
