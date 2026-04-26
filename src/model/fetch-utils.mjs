const RETRY_MAX_RETRIES = 3;
const RETRY_INITIAL_DELAY_MS = 1000;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export function isTimeoutError(error) {
  if (!(error instanceof Error)) return false;
  const name = String(error.name || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  return (
    name.includes("timeout") ||
    name === "aborterror" ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

export async function fetchWithRetry(fetchCall, options = {}) {
  const maxRetries =
    typeof options.maxRetries === "number" && options.maxRetries >= 0
      ? options.maxRetries
      : RETRY_MAX_RETRIES;
  const initialDelayMs =
    typeof options.initialDelayMs === "number" && options.initialDelayMs > 0
      ? options.initialDelayMs
      : RETRY_INITIAL_DELAY_MS;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetchCall();
      if (!isRetriableStatus(response.status) || attempt === maxRetries) {
        return response;
      }
    } catch (error) {
      if (!isTimeoutError(error) || attempt === maxRetries) throw error;
    }
    await delay(initialDelayMs * 2 ** attempt);
    attempt += 1;
  }

  throw new Error("API request failed after retry attempts");
}

export function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;

  const promptTokens = toFiniteNumber(
    rawUsage.promptTokens ?? rawUsage.prompt_tokens ?? rawUsage.inputTokens ?? rawUsage.input_tokens
  );
  const completionTokens = toFiniteNumber(
    rawUsage.completionTokens ?? rawUsage.completion_tokens ?? rawUsage.outputTokens ?? rawUsage.output_tokens
  );
  const reportedTotal = toFiniteNumber(rawUsage.totalTokens ?? rawUsage.total_tokens);
  const totalTokens = reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens;
  const cost = toFiniteNumber(rawUsage.cost);

  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0 && cost <= 0) return null;

  return { promptTokens, completionTokens, totalTokens, cost };
}
