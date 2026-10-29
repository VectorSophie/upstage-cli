import { padLeft } from "./format.mjs";
export function rightAlign(name, width) {
  return padLeft(name, width);
}
