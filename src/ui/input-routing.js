export function shouldRoutePrintableToComposer({
  focusedPane,
  input,
  key,
  isProcessing,
  showSessions,
  hasApproval
}) {
  if (focusedPane === 'input') {
    return false;
  }
  if (isProcessing || showSessions || hasApproval) {
    return false;
  }
  if (typeof input !== 'string' || input.length === 0) {
    return false;
  }
  if (key?.ctrl || key?.meta || key?.tab || key?.escape || key?.return) {
    return false;
  }
  return true;
}
