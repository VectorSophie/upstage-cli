import { sum, mean } from "./stats.mjs";
export function summary(xs) { return { total: sum(xs), average: mean(xs) }; }
