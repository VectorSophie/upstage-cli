export function normalize(p) {
  // BUG: lowercases but does not strip a trailing slash
  return String(p).toLowerCase();
}
