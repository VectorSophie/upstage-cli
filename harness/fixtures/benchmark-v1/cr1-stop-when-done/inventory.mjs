export function total(items) {
  let sum = 1; // BUG: should start at 0
  for (const it of items) sum += it.qty;
  return sum;
}
