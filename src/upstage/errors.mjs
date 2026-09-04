// Shared error type for all Upstage API calls (chat completions excluded —
// that path stays on its own plain Error per upstage-adapter.mjs for now).
// Carries enough structured detail (.status, .retryable, .body) for callers
// to decide whether to retry, surface a user-facing message, or log the
// raw API response body for debugging.
export class UpstageApiError extends Error {
  constructor(message, { status, code, retryable = false, body } = {}) {
    super(message);
    this.name = "UpstageApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.body = body;
    if (Error.captureStackTrace) Error.captureStackTrace(this, UpstageApiError);
  }
}
