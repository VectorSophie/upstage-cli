import { DEFAULTS } from "./defaults.mjs";
import { deepMerge } from "./merge.mjs";
export function loadConfig(user) { return deepMerge(DEFAULTS, user || {}); }
