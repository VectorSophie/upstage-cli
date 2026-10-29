export function parseLine(line) {
  return line.split(",").map((s) => s.trim());
}
