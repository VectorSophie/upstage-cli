# upstage-cli Reasoning Format

## Objective

Define a structured reasoning envelope that is inspectable, tool-compatible, and deterministic enough for replay and testing.

## Canonical Format

```text
THOUGHT
- Brief internal rationale (non-sensitive, concise)

PLAN
- Ordered next steps with success criteria

ACTION
- One of: RESPOND | TOOL_CALL | REQUEST_INPUT | STOP
- If TOOL_CALL: include tool name + validated arguments

OBSERVATION
- Tool output summary or state update from previous step
```

## Agent Loop Interpretation

1. Parse model output into sections.
2. Validate `ACTION` against schema and policy.
3. Execute action:
   - `TOOL_CALL` -> run tool and capture observation
   - `RESPOND` -> stream user-facing answer
   - `REQUEST_INPUT` -> ask focused clarification
   - `STOP` -> end run with explicit stop reason
4. Feed `OBSERVATION` into next cycle.

## Rules

- `THOUGHT` must be short and action-oriented.
- `PLAN` cannot include irreversible operations without confirmation path.
- `ACTION` is mandatory every cycle.
- `OBSERVATION` must reference concrete evidence (tool outputs), not assumptions.

## Stop Reasons (Required)

- `done`
- `needs_user_input`
- `budget_exhausted`
- `tool_error`
- `policy_blocked`
- `model_error`

## Example

```text
THOUGHT
- Need to inspect failing test before proposing code edits.

PLAN
- Read test file.
- Locate implementation.
- Apply minimal patch.
- Run targeted tests.

ACTION
TOOL_CALL: read_file
ARGS: {"path":"tests/parser.test.ts"}

OBSERVATION
- No tool output yet (first step).
```

## Why this format

- Keeps loop machine-readable without over-constraining model quality.
- Supports deterministic replay and auditing.
- Makes tool invocation intent explicit before execution.
