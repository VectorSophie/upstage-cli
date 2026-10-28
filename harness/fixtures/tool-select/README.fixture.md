# tool-select fixture

## Bug
`mul` in math.mjs is implemented as addition. `add` is correct and must stay correct.

## Expected Fix
### file: math.mjs
```
export function add(a, b) {
  return a + b;
}

export function mul(a, b) {
  return a * b;
}
```
