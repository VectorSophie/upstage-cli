import { normalize } from "./path.mjs";
const table = new Map();
export function register(path, handler) { table.set(normalize(path), handler); }
export function lookup(path) { return table.get(normalize(path)); }
register("/users", () => "USERS");
register("/health", () => "OK");
