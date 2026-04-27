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
  const c = results.filter((r) => r.status === "pass" || r.ok === true).length;
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
