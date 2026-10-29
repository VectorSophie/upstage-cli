# multi-step fixture

## Bug
parseCsvLine splits on ";" (should be ",") and does not trim fields.

## Expected Fix
### file: parser.mjs
```
export function parseCsvLine(line) {
  return line.split(",").map((f) => f.trim());
}
```
