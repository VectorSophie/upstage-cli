export function rangeSum(n) {
  let s = 0;
  for (let i = 1; i < n; i++) s += i; // BUG: excludes n
  return s;
}
