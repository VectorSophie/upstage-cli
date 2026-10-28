# T3 tool-result-continuation: trusted trace evaluation

## The problem with the original T3

The original T3 (`fixtures/tool-continuation/gen.mjs`) printed a fixed token
(`TOKEN-7F3A9C`) that was present in the generator source and in the check
command. An agent could pass by reading the source (or recalling the token) and
writing it — without ever executing the tool. A shell check can only inspect the
final files; it cannot establish *how* they were produced.

## v2 — trace-aware evaluation (first rigorous version)

`fixtures/tool-continuation-v2/challenge.mjs` emits a **fresh CSPRNG token at
runtime** (not in source). A trace-aware evaluator verifies, from the
harness-recorded tool-call trace plus a pinned generator hash, that the challenge
ran and that `out.txt` matched an emitted token. This removed the static-answer
leak.

## Hardened evaluator (current) — three trust-boundary fixes

Final review found three ways to satisfy the v2 evaluator **without** a genuine,
unmodified generator execution. All were reproduced:

| Bypass | v2 weakness | Fix |
|---|---|---|
| **A. command spoofing** | accepted any command whose string *contained* `challenge.mjs` (`echo T3-… challenge.mjs`, `… # challenge.mjs`, chaining) | **command identity**: tokenise exactly as the executor does (reject `; & | \` $(` and `# < >` and newlines) and require an **exact argv match** — never a substring |
| **C. output spoofing** | extracted the token from the whole serialized result (stdout **+ stderr + echoed command + metadata**); accepted failed/timed-out results | **stdout-only**: read the structured result the audit log now preserves (`resultData`), take the token from **stdout** of a **successful, complete** execution (ok + exit 0 + not timed-out/truncated) only |
| **B. modify / run / restore (TOCTOU)** | hashed the generator only *after* the run, so an agent could modify it, run it, then restore the original bytes | **immutable generator**: the trusted generator runs from a **read-only mount outside the writable workspace**; there is no writable copy to tamper with, so integrity is structural (time-of-check = time-of-use) |

### Command identity (`src/evaluation/evaluators.mjs`)

`config.command` is the EXACT command the agent must run (e.g.
`node /opt/t3/challenge.mjs`). The evaluator tokenises `tc.args.command` the same
way the sandbox executor does and requires the argv to equal it exactly. A
command that merely mentions the filename, is commented, chained, piped, or
redirected does not tokenise to the expected argv and is rejected.

### Stdout-only, successful execution

The audit log (`src/tracking/audit-log.mjs`) now preserves a structured,
length-capped `resultData` for execution tools (`ok`, `code`, `stdout`, `stderr`,
`timedOut`, `truncated`). The evaluator reads the token from `stdout` only, and
only when the execution succeeded cleanly — so a token in stderr, in the echoed
command, or in serialized metadata, and any failed/timed-out/truncated run, can
never count.

### Immutable generator (Docker read-only mount)

The T3-v3 task declares `sandbox.readonlyMounts`, and the harness `DockerSandbox`
mounts the trusted generator **read-only** at `/opt/t3/challenge.mjs`, outside the
bind-mounted (read-write) `/workspace`. `buildDockerRunArgs` enforces that such a
mount is `:ro` and its container path is absolute and outside `/workspace`. The
agent therefore cannot read-and-copy a stored answer, cannot rewrite the
generator, and cannot modify-then-restore it — there is no writable copy. With
`immutableGenerator: true` the evaluator relies on this structural guarantee and
performs no post-hoc file hash.

The evaluator runs in the trusted harness process (not in the sandbox, not from
fixture code; referenced by **name**, so a task can never make the harness
execute untrusted JS) and reads only the harness-authored trace and the final
workspace — it does not weaken Docker isolation (the agent still runs confined).

### Why each adversarial path fails (hardened)

| Attack | Result |
|---|---|
| Read only the source | No token in source, no exec call → fail |
| Hardcode old token / guess | Fresh CSPRNG token never matches → fail |
| Write an arbitrary value | Not an emitted stdout token → fail |
| Command mentions the filename but does not execute it | Not an exact argv → fail |
| Shell comment / chaining / redirect spoofing | Rejected by tokeniser / exact argv → fail |
| Alternate command prints a fabricated token | Not the trusted argv → fail |
| Token only in stderr / echoed metadata | stdout-only extraction → fail |
| Execution failed or timed out | success/complete check → fail |
| Generator modified before execution and restored after | read-only mount: cannot modify (write fails) → structurally impossible |
| Decoy: run a workspace copy instead of the mounted path | Not the trusted argv → fail |
| Correct execution but wrong/absent final output | out.txt ≠ emitted token → fail |
| Genuine execution of the mounted generator + consume stdout | **pass** |

### Native vs Docker trust boundary

The immutable-generator guarantee requires the read-only mount, i.e. **Docker**.
T3-v3 is a Docker task and provides it. T3-v2 remains a **native** variant: it
gains the command-identity and stdout-only hardening, but native shares
filesystem identity with the agent, so its generator integrity is only
best-effort (a post-run hash that does **not** prove execution-time integrity).
Use T3-v3 for the real guarantee.

## Versioning / historical compatibility

- `tool-continuation` (v1) — original, answer-leaking. Historical only.
- `tool-continuation-v2` — native, trace-aware; now also A/C-hardened. Its
  **original live-pilot results were produced under the pre-hardening evaluator**
  and are **not** relabeled as passing the hardened evaluator.
- `tool-continuation-v3` — canonical hardened task: Docker, generator mounted
  read-only at `/opt/t3/challenge.mjs`, `immutableGenerator: true`.

Old v2 raw traces are **not** treated as proof of execution-time integrity: they
predate `resultData` and the read-only mount, so they lack the necessary
evidence. The hardened evaluator is validated by the regression tests and the
live T3-v3 pilot instead.

## Tests

- `tests/h18-t3-trace-evaluator.test.mjs` — 18 unit (every bypass in the table,
  both legacy and immutable configs) + 5 real-pipeline (live `node` exec, stubbed
  model), incl. a live Bypass-A rejection.
- `tests/h17-local-docker.test.mjs` — real Docker isolation: genuine mounted-path
  run passes; an overwrite of the read-only mount fails (bypass B impossible);
  decoy substitution (running a workspace copy) fails.
