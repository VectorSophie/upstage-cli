import { isPositive } from "./rules.mjs";
export function check(n) {
  return isPositive(n) ? "ok" : "bad";
}
