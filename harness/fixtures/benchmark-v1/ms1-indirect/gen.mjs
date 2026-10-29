import { randomBytes, randomInt } from "node:crypto";
// Dependent interpretation: the agent must first read `primary`, THEN select
// ports[primary]. Which value is correct depends on another field of the same
// runtime output. All ports are fresh CSPRNG tokens.
const tok = () => "BV1H-" + randomBytes(16).toString("hex");
const names = ["api", "db", "cache"];
const primary = names[randomInt(0, names.length)];
const ports = Object.fromEntries(names.map((n) => [n, tok()]));
process.stdout.write(JSON.stringify({ primary, ports }) + "\n");
