export function parseCsvLine(line) {
  // BUG 1: splits on the wrong delimiter (semicolon instead of comma)
  const parts = line.split(";");
  // BUG 2: does not trim surrounding whitespace from fields
  return parts;
}
