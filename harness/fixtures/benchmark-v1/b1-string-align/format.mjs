export function padLeft(s, n) {
  // BUG: pads on the RIGHT instead of the left
  return s + " ".repeat(Math.max(0, n - s.length));
}
