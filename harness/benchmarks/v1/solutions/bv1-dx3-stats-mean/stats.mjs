export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
export function mean(xs) { return sum(xs) / xs.length; }
