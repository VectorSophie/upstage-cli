import { randomBytes, randomInt } from "node:crypto";
// Emits items with fresh id tokens and DISTINCT random scores (non-overlapping
// buckets guarantee a unique maximum). The agent must select the id of the
// highest-scoring item — interpretation, not copying.
const tok = () => "BV1H-" + randomBytes(16).toString("hex");
const scores = [randomInt(10, 30), randomInt(31, 60), randomInt(61, 90)];
// shuffle so position of the max varies run to run
for (let i = scores.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [scores[i], scores[j]] = [scores[j], scores[i]]; }
const items = scores.map((s) => ({ id: tok(), score: s }));
process.stdout.write(JSON.stringify({ items }) + "\n");
