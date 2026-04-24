export function chunkText(text, options = {}) {
  const chunkSize = Number.isInteger(options.chunkSize) ? options.chunkSize : 800;
  const overlap = Number.isInteger(options.overlap) ? options.overlap : 120;
  const safeChunkSize = Math.max(200, chunkSize);
  const safeOverlap = Math.max(0, Math.min(overlap, safeChunkSize / 2));

  const source = String(text || "");
  if (source.length <= safeChunkSize) {
    return [source];
  }

  const chunks = [];
  let start = 0;
  while (start < source.length) {
    const end = Math.min(source.length, start + safeChunkSize);
    chunks.push(source.slice(start, end));
    if (end >= source.length) {
      break;
    }
    start = Math.max(start + 1, end - safeOverlap);
  }
  return chunks;
}
