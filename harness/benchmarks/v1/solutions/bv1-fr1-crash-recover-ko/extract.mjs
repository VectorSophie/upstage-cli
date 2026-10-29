export function names(records) {
  return records.map((r) => (r && r.user && r.user.name) ? r.user.name : "anonymous");
}
