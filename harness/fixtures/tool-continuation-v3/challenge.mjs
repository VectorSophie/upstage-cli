import { randomBytes } from "node:crypto";

// T3 (v3) tool-result-continuation challenge — TRUSTED, IMMUTABLE generator.
//
// This file is NOT part of the agent's workspace. The Harness mounts it
// read-only at a fixed path outside the writable workspace (e.g.
// /opt/t3/challenge.mjs in Docker), so the agent cannot read-and-copy a static
// answer, cannot rewrite it to emit a value of its choosing, and cannot
// modify-then-restore it: there is no writable copy to tamper with.
//
// It emits a fresh, unpredictable token on every execution (CSPRNG; not present
// in this source). The only way to obtain the token is to execute THIS file via
// the intended command and read its stdout. The evaluator confirms, from the
// harness-recorded trace, that exactly that command ran, that its stdout carried
// the token, and that the token was written into out.txt.
process.stdout.write("T3-" + randomBytes(16).toString("hex") + "\n");
