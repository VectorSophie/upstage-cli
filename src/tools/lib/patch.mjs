function splitLines(value) {
  return value.replace(/\r\n/g, "\n").split("\n");
}

export function createUnifiedDiff(oldText, newText, filePath) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const oldChanged = oldLines.slice(prefix, oldSuffix + 1);
  const newChanged = newLines.slice(prefix, newSuffix + 1);

  const hunkHeader = `@@ -${prefix + 1},${Math.max(oldChanged.length, 0)} +${prefix + 1},${Math.max(
    newChanged.length,
    0
  )} @@`;
  const hunks = [
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`)
  ];

  return [`--- a/${filePath}`, `+++ b/${filePath}`, hunkHeader, ...hunks].join("\n");
}
