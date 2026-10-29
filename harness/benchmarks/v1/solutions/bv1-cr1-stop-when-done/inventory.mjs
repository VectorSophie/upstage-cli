export function total(items) {
  let sum = 0;
  for (const it of items) sum += it.qty;
  return sum;
}
