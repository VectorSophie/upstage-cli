# T3 tool-result-continuation: trusted trace evaluation

## The problem with the original T3

The original T3 (`fixtures/tool-continuation/gen.mjs`) printed a fixed token:

```js
console.log("TOKEN-7F3A9C");
```

and the task checked `grep -qx TOKEN-7F3A9C out.txt`. The answer was therefore
present **in the generator source and in the check command**. An agent could
pass by reading the source (or recalling the token from a prior run) and writing
it — without ever executing the tool. A shell check can only inspect the final
files; it cannot establish *how* they were produced. So the original T3 did not
distinguish genuine tool-result continuation from source inspection, prior
knowledge, or answer copying.

## The rigorous design (v2)

Two things the agent cannot forge are used as trusted channels:

1. **The harness-recorded tool-call trace** (`AuditLog.toolCalls()`), built by the
   harness from the agent's event stream. The agent cannot write to it.
2. **A pinned sha256 of the generator source**, stored in the task config
   (outside the agent-editable workspace).

`fixtures/tool-continuation-v2/challenge.mjs` emits a **fresh CSPRNG token at
runtime**:

```js
process.stdout.write("T3-" + randomBytes(16).toString("hex") + "\n");
```

The token is not in the source (reading the file reveals only the mechanism), is
different on every execution, and cannot be guessed, hardcoded, or copied from a
previous attempt.

### The evaluator (`src/evaluation/evaluators.mjs` → `tool-result-continuation`)

Runs in the trusted harness process (not in the sandbox, not from fixture code;
referenced by **name**, so a task can never make the harness execute untrusted
JS). It passes iff **all** hold:

1. a successful `run_shell`/`run` call executed `challenge.mjs` and its recorded
   result contains a token matching the pattern → the required tool call really
   happened and returned a valid result;
2. `challenge.mjs` in the final workspace is byte-identical to its pinned hash →
   the generator was not rewritten to self-emit a chosen value;
3. `out.txt` equals one of the tokens the generator actually emitted in the trace
   → the agent consumed and used the tool result.

### Why each adversarial path fails

| Attack | Result |
|---|---|
| Read only the source | No token in source, no exec call → fail (1) |
| Hardcode the old token / guess | Fresh CSPRNG token never matches → fail (3) |
| Write an arbitrary value | Not an emitted token → fail (3) |
| Run the tool but ignore its output | `out.txt` ≠ emitted token → fail (3) |
| Never create `out.txt` | → fail (3) |
| Rewrite `challenge.mjs` to emit a chosen token | generator sha ≠ pinned → fail (2) |
| Modify only `out.txt` (no run) | No exec call in trace → fail (1) |

Run through the real pipeline, a correct final file alone never passes (requires
the trace), and a tool call alone never passes (requires the output to match).

### Trust boundary & isolation

The evaluator reads the final workspace (bind-mounted / native) and the
harness-authored trace. It does not execute agent-supplied code and does not run
inside the sandbox, so it does not weaken Docker isolation — the agent still runs
fully confined. Baseline validation treats the custom acceptance check like a
`fail_to_pass`: against the pristine, no-agent state (empty trace) it must fail,
so the task cannot be passed by a no-op.

### Provenance / versioning

The rigorous task is `tasks/local/pilot-t3-tool-continuation-v2.yaml`
(`version: 2`), with its own fixture `fixtures/tool-continuation-v2/`. The
original fixture and task are retained unchanged so the original pilot evidence
stays identifiable as the pre-repair (non-rigorous) T3. The per-attempt challenge
value is the CSPRNG token recorded in each run's trace.

Tests: `tests/h18-t3-trace-evaluator.test.mjs` (11 unit adversarial + 4 real
pipeline) and `tests/h17-local-docker.test.mjs` (2 real-Docker-isolation cases).
