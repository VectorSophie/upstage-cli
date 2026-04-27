import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { failToPassRate, passToPassRate } from "../src/evaluation/checks.mjs";
import {
  aggregate, checksScore, patchMinimalityScore,
  toolCallScore, costScore, speedScore
} from "../src/evaluation/scorer.mjs";
import { classifyFailure } from "../src/evaluation/taxonomy.mjs";
import { passAtK, passAtKSuite } from "../src/evaluation/pass-at-k.mjs";

// ── checks rates ──────────────────────────────────────────────────────────────

describe("failToPassRate / passToPassRate", () => {
  it("returns 1.0 for empty array", () => {
    assert.equal(failToPassRate([]), 1.0);
    assert.equal(passToPassRate([]), 1.0);
  });

  it("returns 0.0 when all fail", () => {
    const results = [{ passed: false }, { passed: false }];
    assert.equal(failToPassRate(results), 0.0);
  });

  it("returns 1.0 when all pass", () => {
    const results = [{ passed: true }, { passed: true }];
    assert.equal(failToPassRate(results), 1.0);
  });

  it("returns 0.5 for half passing", () => {
    const results = [{ passed: true }, { passed: false }];
    assert.equal(failToPassRate(results), 0.5);
  });
});

// ── scoring formula ───────────────────────────────────────────────────────────

describe("checksScore", () => {
  it("full pass → ~1.0", () => {
    assert.equal(checksScore(1.0, 1.0), 1.0);
  });

  it("all fail → 0.0", () => {
    assert.equal(checksScore(0.0, 0.0), 0.0);
  });

  it("weights: FTP=0.7, PTP=0.3", () => {
    assert.equal(checksScore(1.0, 0.0), 0.7);
    assert.equal(checksScore(0.0, 1.0), 0.3);
  });
});

describe("patchMinimalityScore", () => {
  it("0 lines changed → 1.0", () => {
    assert.equal(patchMinimalityScore(0, 0), 1.0);
  });

  it("larger patch → lower score", () => {
    const s1 = patchMinimalityScore(1, 0);
    const s100 = patchMinimalityScore(100, 0);
    assert.ok(s1 > s100);
  });

  it("always in [0, 1]", () => {
    for (const n of [0, 1, 10, 100, 1000]) {
      const s = patchMinimalityScore(n, 0);
      assert.ok(s >= 0 && s <= 1, `patchMinimalityScore(${n}, 0) out of range: ${s}`);
    }
  });
});

describe("toolCallScore", () => {
  it("0 tool calls → 1.0", () => {
    assert.equal(toolCallScore(0), 1.0);
  });

  it("more calls → lower score", () => {
    assert.ok(toolCallScore(5) > toolCallScore(20));
  });
});

describe("costScore / speedScore", () => {
  it("0 cost → 1.0", () => {
    assert.equal(costScore(0, 1.0), 1.0);
  });

  it("cost at budget → 0.0", () => {
    assert.equal(costScore(1.0, 1.0), 0.0);
  });

  it("cost clamped to [0, 1]", () => {
    assert.equal(costScore(2.0, 1.0), 0.0);
  });

  it("0ms duration → speedScore near 1.0", () => {
    assert.ok(speedScore(0, 120) > 0.99);
  });
});

describe("aggregate", () => {
  it("perfect run → high score", () => {
    const checks = {
      fail_to_pass: [{ passed: true }],
      pass_to_pass: [{ passed: true }],
      custom: []
    };
    const metrics = { toolCalls: 3, estimatedCostUsd: 0.01, patch: { linesAdded: 1, linesRemoved: 0 } };
    const result = aggregate(checks, metrics, {}, 10000, 120);
    assert.ok(result.score > 0.7);
    assert.equal(result.failToPassRate, 1.0);
    assert.equal(result.passToPassRate, 1.0);
  });

  it("all fail → low score", () => {
    const checks = {
      fail_to_pass: [{ passed: false }],
      pass_to_pass: [{ passed: false }],
      custom: []
    };
    const result = aggregate(checks, { toolCalls: 20, estimatedCostUsd: 0.90, patch: { linesAdded: 200, linesRemoved: 100 } }, {}, 115000, 120);
    assert.ok(result.score < 0.4);
    assert.equal(result.failToPassRate, 0.0);
  });

  it("score is in [0, 1]", () => {
    const checks = { fail_to_pass: [], pass_to_pass: [], custom: [] };
    const result = aggregate(checks, { toolCalls: 0, estimatedCostUsd: 0, patch: { linesAdded: 0, linesRemoved: 0 } }, {}, 0, 120);
    assert.ok(result.score >= 0 && result.score <= 1);
  });
});

// ── taxonomy ──────────────────────────────────────────────────────────────────

function makeRun(overrides = {}) {
  return {
    status: "fail",
    durationMs: 50000,
    safety: { riskFlags: [], secretsDetected: false },
    evaluation: {
      failToPassRate: 0,
      passToPassRate: 1,
      checks: { fail_to_pass: [{ passed: false, id: "f1" }], pass_to_pass: [{ passed: true, id: "p1" }] }
    },
    metrics: { toolCalls: 5, patch: { linesAdded: 5, linesRemoved: 0 } },
    trace: { toolCalls: [], turns: [{}], stopReason: "end_turn" },
    patch: { filesChanged: ["app.py"], model_patch: "" },
    ...overrides
  };
}

describe("classifyFailure — Dimension 5: Safety", () => {
  it("unsafe_command when riskFlags present", () => {
    const run = makeRun({ safety: { riskFlags: ["curl pipe to shell"], secretsDetected: false } });
    const f = classifyFailure(run, {});
    assert.equal(f.dimension, "safety");
    assert.equal(f.symptom, "unsafe_command");
  });

  it("secret_exfiltration_attempt when secretsDetected", () => {
    const run = makeRun({ safety: { riskFlags: [], secretsDetected: true } });
    const f = classifyFailure(run, {});
    assert.equal(f.symptom, "secret_exfiltration_attempt");
  });
});

describe("classifyFailure — Dimension 4: Runtime", () => {
  it("timeout when durationMs >= sandbox.timeout * 1000", () => {
    const run = makeRun({ durationMs: 120001 });
    const f = classifyFailure(run, { sandbox: { timeout: 120 } });
    assert.equal(f.symptom, "timeout");
  });

  it("budget_exhausted when stopReason matches", () => {
    const run = makeRun({ trace: { toolCalls: [], turns: [], stopReason: "budget_exhausted" } });
    const f = classifyFailure(run, {});
    assert.equal(f.symptom, "budget_exhausted");
  });
});

describe("classifyFailure — Dimension 1: Cognition", () => {
  it("over_engineering when linesAdded >> expectedMaxLines", () => {
    const run = makeRun({ metrics: { patch: { linesAdded: 500, linesRemoved: 0 }, toolCalls: 5 } });
    const f = classifyFailure(run, { expectedMaxLines: 3 });
    assert.equal(f.symptom, "over_engineering");
  });

  it("misunderstood_task when files changed outside expectedPatchScope", () => {
    const run = makeRun({ patch: { filesChanged: ["unrelated.py"] } });
    const f = classifyFailure(run, { expectedPatchScope: ["app.py"] });
    assert.equal(f.symptom, "misunderstood_task");
  });
});

describe("classifyFailure — Dimension 2: Tooling", () => {
  it("incomplete_patch when no lines changed", () => {
    const run = makeRun({ metrics: { patch: { linesAdded: 0, linesRemoved: 0 }, toolCalls: 5 }, patch: { filesChanged: [] } });
    const f = classifyFailure(run, {});
    assert.equal(f.symptom, "incomplete_patch");
  });

  it("test_gaming when test files modified", () => {
    const run = makeRun({ patch: { filesChanged: ["tests/test_app.py"] } });
    const f = classifyFailure(run, {});
    assert.equal(f.symptom, "test_gaming");
  });

  it("tool_loop when same tool+args called 3+ times", () => {
    const toolCalls = Array(3).fill({ tool: "read_file", args: { path: "app.py" } });
    const run = makeRun({ trace: { toolCalls, turns: [], stopReason: "end_turn" } });
    const f = classifyFailure(run, {});
    assert.equal(f.symptom, "tool_loop");
  });
});

describe("classifyFailure — Dimension 3: Perception", () => {
  it("broke_unrelated_code when pass_to_pass fails", () => {
    const run = makeRun({
      patch: { filesChanged: ["app.py"] },
      metrics: { patch: { linesAdded: 10, linesRemoved: 0 }, toolCalls: 3 },
      evaluation: {
        failToPassRate: 0,
        passToPassRate: 0,
        checks: { fail_to_pass: [{ passed: false, id: "f1" }], pass_to_pass: [{ passed: false, id: "p1" }] }
      }
    });
    const f = classifyFailure(run, {});
    assert.equal(f.symptom, "broke_unrelated_code");
  });
});

describe("classifyFailure — pass returns null", () => {
  it("returns null when status=pass", () => {
    assert.equal(classifyFailure({ status: "pass" }), null);
  });
});

// ── pass@k ────────────────────────────────────────────────────────────────────

describe("passAtK", () => {
  it("0 passes → 0.0", () => {
    const runs = [{ status: "fail" }, { status: "fail" }];
    assert.equal(passAtK(runs, 1), 0);
  });

  it("all pass → 1.0", () => {
    const runs = [{ status: "pass" }, { status: "pass" }];
    assert.equal(passAtK(runs, 2), 1.0);
  });

  it("k=1 with 1 pass out of 2 → 0.5", () => {
    const runs = [{ status: "pass" }, { status: "fail" }];
    assert.equal(passAtK(runs, 1), 0.5);
  });

  it("empty array → 0", () => {
    assert.equal(passAtK([], 1), 0);
  });

  it("throws when k > n", () => {
    assert.throws(() => passAtK([{ status: "pass" }], 2), /k.*greater than n/);
  });

  it("passAtKSuite returns rates for multiple k values", () => {
    const runs = Array(5).fill({ status: "pass" });
    const suite = passAtKSuite(runs, [1, 3, 5]);
    assert.equal(suite.k1, 1.0);
    assert.equal(suite.k5, 1.0);
  });
});
