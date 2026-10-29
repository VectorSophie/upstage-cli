export function deepMerge(base, over) {
  // BUG: shallow spread — a nested object in `over` replaces the whole branch,
  // dropping sibling keys.
  return { ...base, ...over };
}
