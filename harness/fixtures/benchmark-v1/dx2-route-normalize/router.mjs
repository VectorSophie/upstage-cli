import { lookup } from "./routes.mjs";
export function route(path) { const h = lookup(path); return h ? h() : "not found"; }
