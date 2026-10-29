import { prepare, topTwo } from "./stage.mjs";
export function biggestTwo(xs) { return topTwo(prepare(xs)); }
