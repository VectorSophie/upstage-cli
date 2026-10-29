export function parseLine(line) {
  // BUG 1: wrong delimiter (semicolon). BUG 2: fields are not trimmed.
  return line.split(";");
}
