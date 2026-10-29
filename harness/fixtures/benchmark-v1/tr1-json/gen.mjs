import { randomBytes } from "node:crypto";
// Trusted, immutable tool-result-INTERPRETATION generator (benchmark v1).
// Mounted READ-ONLY outside the workspace; emits fresh CSPRNG port tokens at
// runtime. The agent must parse the JSON and select the "api" service's port —
// copying the whole stdout, or any other port, is wrong. See the trusted
// evaluator tool-result-selection.
const tok = () => "BV1H-" + randomBytes(16).toString("hex");
const services = [
  { name: "api", port: tok() },
  { name: "db", port: tok() },
  { name: "cache", port: tok() }
];
process.stdout.write(JSON.stringify({ services }) + "\n");
