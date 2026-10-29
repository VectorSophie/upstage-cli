import { randomBytes } from "node:crypto";

// T3 (v2) tool-result-continuation challenge.
//
// This script emits a FRESH, unpredictable token on every execution. The token
// is generated at runtime from a CSPRNG — it is NOT present anywhere in this
// source. Reading this file reveals only the mechanism, never the answer; the
// value changes on every run and cannot be guessed, hardcoded, or copied from a
// previous attempt.
//
// The only way to obtain the token is to RUN this script and read its stdout.
// The evaluator confirms, from the harness-recorded trace (a trusted channel the
// agent cannot write to), that this exact command ran and returned the token,
// that this file was not modified, and that the token was written out verbatim.
process.stdout.write("T3-" + randomBytes(16).toString("hex") + "\n");
