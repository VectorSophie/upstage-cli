export function cToF(c) {
  return (c * 9) / 5; // BUG: missing + 32
}
