export function validate(size) {
  if (size <= 0) throw new RangeError("size must be positive");
  return size;
}
