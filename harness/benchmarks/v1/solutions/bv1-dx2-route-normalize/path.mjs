export function normalize(p) {
  return String(p).toLowerCase().replace(/\/+$/, "") || "/";
}
