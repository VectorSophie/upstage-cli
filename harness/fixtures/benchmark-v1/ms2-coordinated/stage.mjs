export function prepare(xs) {
  // BUG: should return unique values sorted descending
  return xs.slice();
}
export function topTwo(sortedDesc) {
  // BUG: skips the first (largest) element
  return sortedDesc.slice(1, 3);
}
