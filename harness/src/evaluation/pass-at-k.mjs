/**
 * pass@k metric (Chen et al., 2021 — HumanEval paper).
 * Given n runs of the same task, at least k of which need to be correct,
 * returns the estimated probability that at least one of k randomly sampled
 * runs is correct.
 *
 * Unbiased estimator:
 *   pass@k = 1 - C(n-c, k) / C(n, k)
 * where n = total runs, c = passing runs, k = sample size
 */
export function passAtK(results, k = 1) {
  const n = results.length;
  if (n === 0) return 0;
  const c = results.filter((r) => r.status === "pass").length;
  if (k > n) {
    throw new Error(`k (${k}) cannot be greater than n (${n})`);
  }
  if (c === 0) return 0;
  if (c >= n) return 1.0;

  // Numerically stable: product form of C(n-c, k) / C(n, k)
  let prob = 1.0;
  for (let i = 0; i < k; i++) {
    prob *= (n - c - i) / (n - i);
  }
  return Math.max(0, Math.min(1, 1 - prob));
}

export function passAtKSuite(results, ks = [1, 3, 5]) {
  const out = {};
  for (const k of ks) {
    if (k <= results.length) {
      out[`k${k}`] = passAtK(results, k);
    }
  }
  return out;
}

/**
 * pass^k (Yao et al., 2024 — τ-bench): probability that ALL k i.i.d. attempts
 * succeed — a reliability metric, unlike pass@k (≥1 of k succeeds).
 * Unbiased estimator: C(c, k) / C(n, k).
 */
export function passHatK(results, k = 1) {
  const n = results.length;
  if (n === 0) return 0;
  if (k > n) throw new Error(`k (${k}) cannot be greater than n (${n})`);
  const c = results.filter((r) => r.status === "pass").length;
  let prob = 1.0;
  for (let i = 0; i < k; i++) {
    prob *= Math.max(0, c - i) / (n - i);
  }
  return Math.max(0, Math.min(1, prob));
}

/**
 * Summarise k attempts. Only scorable attempts (status pass|fail) enter the
 * estimators; error/incomplete attempts are counted separately, and the
 * metrics are null (unknown) when fewer than k attempts were scorable.
 */
export function summarizeAttempts(runs, k = runs.length) {
  const scorable = runs.filter((r) => r.status === "pass" || r.status === "fail");
  const count = (s) => runs.filter((r) => r.status === s).length;
  const enough = k > 0 && scorable.length >= k;
  return {
    attempts: runs.length,
    scorable: scorable.length,
    passed: count("pass"),
    failed: count("fail"),
    errored: runs.length - scorable.length - count("incomplete"),
    incomplete: count("incomplete"),
    k,
    passAtK: enough ? passAtK(scorable, k) : null,
    passHatK: enough ? passHatK(scorable, k) : null
  };
}
