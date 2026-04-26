#!/usr/bin/env node
/**
 * Smoke test — verifies the CLI starts and produces output without a real API key.
 * The mock planner handles responses when UPSTAGE_API_KEY is unset.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const entry = join(root, "src", "cli", "index.mjs");

const TESTS = [
  {
    label: "ask --no-stream (mock planner echo)",
    args: ["ask", "-p", "echo hello smoke", "--no-stream"],
    env: { UPSTAGE_API_KEY: "" },
    expect: (stdout, code) => {
      if (code !== 0) throw new Error(`exit code ${code}, stdout: ${stdout}`);
      if (!stdout.trim()) throw new Error("empty output");
    },
  },
  {
    label: "--help exits 0 and prints usage",
    args: ["--help"],
    env: {},
    expect: (stdout, code) => {
      if (code !== 0) throw new Error(`exit code ${code}`);
      if (!stdout.includes("upstage")) throw new Error("no usage text in output");
    },
  },
];

let passed = 0;
let failed = 0;

for (const test of TESTS) {
  const result = spawnSync(process.execPath, [entry, ...test.args], {
    env: { ...process.env, ...test.env },
    encoding: "utf8",
    timeout: 15_000,
    cwd: root,
  });

  const stdout = (result.stdout || "") + (result.stderr || "");
  try {
    test.expect(stdout, result.status ?? 0);
    console.log(`  ✓  ${test.label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${test.label}: ${err.message}`);
    failed++;
  }
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
