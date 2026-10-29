export function padLeft(s, n) {
  return " ".repeat(Math.max(0, n - s.length)) + s;
}
