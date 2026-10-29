export function clamp(x, lo, hi) {
  // BUG: lower bound applied, upper bound ignored
  return Math.max(x, lo);
}
