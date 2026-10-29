import { DEFAULT_SIZE } from "./defaults.mjs";
import { validate } from "./check.mjs";
export function run(size = DEFAULT_SIZE) { return validate(size) * 2; }
