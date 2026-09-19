// Keeps one CDPClient alive per agent session across the several browser_*
// tool calls a verification flow makes (3.3.0 Thread C). Each tool call is
// a fresh execute() invocation with no object to carry state through
// except this in-process registry, keyed by session id.

const openBrowsers = new Map();

export function getBrowser(sessionKey) {
  return openBrowsers.get(sessionKey) || null;
}

export function setBrowser(sessionKey, client) {
  openBrowsers.set(sessionKey, client);
}

export async function closeBrowser(sessionKey) {
  const client = openBrowsers.get(sessionKey);
  if (!client) return;
  openBrowsers.delete(sessionKey);
  await client.close();
}
