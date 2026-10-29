import { randomBytes } from "node:crypto";
// Trusted, immutable tool-result-dependence generator (benchmark v1, cat. D).
// Mounted READ-ONLY outside the workspace; emits a fresh CSPRNG token at runtime
// (not in source). Only obtainable by executing this exact command and reading
// stdout. See docs/T3_TRACE_EVALUATION.md for the trust model.
process.stdout.write("BV1-" + randomBytes(16).toString("hex") + "\n");
