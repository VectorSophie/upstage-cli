export function add(a, b) {
  return a + b;
}

export function mul(a, b) {
  // BUG: multiplication implemented as addition
  return a + b;
}
