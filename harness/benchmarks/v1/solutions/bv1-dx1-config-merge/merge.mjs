export function deepMerge(base, over) {
  if (base === null || typeof base !== "object" || Array.isArray(base)) return over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const bv = base[k], ov = over[k];
    out[k] = (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object" && !Array.isArray(bv))
      ? deepMerge(bv, ov) : ov;
  }
  return out;
}
