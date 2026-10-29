export function prepare(xs) {
  return [...new Set(xs)].sort((a, b) => b - a);
}
export function topTwo(sortedDesc) {
  return sortedDesc.slice(0, 2);
}
