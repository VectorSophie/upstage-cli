const DEFAULT_BASE_URL = process.env.UPSTAGE_API_BASE_URL || "https://api.upstage.ai/v1";
const DEFAULT_MODEL = process.env.UPSTAGE_MODEL || "solar-pro2";
const RETRY_MAX_RETRIES = 3;
const RETRY_INITIAL_DELAY_MS = 1000;

function parseStreamChunk(line) {
  if (!line.startsWith("data:")) {
    return null;
  }
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }
  return JSON.parse(payload);
}

function mergeToolCall(collector, delta) {
  if (!Array.isArray(delta.tool_calls)) {
    return;
  }
  for (const toolCall of delta.tool_calls) {
    const idx = Number.isInteger(toolCall.index) ? toolCall.index : 0;
    if (!collector[idx]) {
      collector[idx] = {
        id: toolCall.id || `call_${idx}`,
        type: "function",
        function: {
          name: toolCall.function?.name || "",
          arguments: toolCall.function?.arguments || ""
        }
      };
      continue;
    }
    if (toolCall.id) {
      collector[idx].id = toolCall.id;
    }
    if (toolCall.function?.name) {
      collector[idx].function.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments) {
      collector[idx].function.arguments += toolCall.function.arguments;
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTimeoutError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = String(error.name || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  return (
    name.includes("timeout") ||
    name === "aborterror" ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

async function fetchWithRetry(fetchCall, options = {}) {
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
      if (!isTimeoutError(error) || attempt === maxRetries) {
        throw error;
      }
    }

    const delayMs = initialDelayMs * 2 ** attempt;
    await delay(delayMs);
    attempt += 1;
  }

  throw new Error("Upstage API request failed after retry attempts");
}

function toFiniteNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }
  return numericValue;
}

function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") {
    return null;
  }

  const promptTokens = toFiniteNumber(
    rawUsage.promptTokens ?? rawUsage.prompt_tokens ?? rawUsage.inputTokens ?? rawUsage.input_tokens
  );
  const completionTokens = toFiniteNumber(
    rawUsage.completionTokens ?? rawUsage.completion_tokens ?? rawUsage.outputTokens ?? rawUsage.output_tokens
  );
  const reportedTotalTokens = toFiniteNumber(rawUsage.totalTokens ?? rawUsage.total_tokens);
  const totalTokens = reportedTotalTokens > 0 ? reportedTotalTokens : promptTokens + completionTokens;
  const cost = toFiniteNumber(rawUsage.cost);

  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0 && cost <= 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost
  };
}

async function readSseStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = [];
  let content = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const parsed = parseStreamChunk(line.trim());
      if (!parsed) {
        continue;
      }
      const chunkUsage = normalizeUsage(parsed.usage);
      if (chunkUsage) {
        usage = chunkUsage;
      }
      if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        continue;
      }
      const delta = parsed.choices[0].delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        if (typeof onToken === "function") {
          onToken(delta.content);
        }
      }
      mergeToolCall(toolCalls, delta);
    }
  }

  return {
    content,
    toolCalls: toolCalls.filter(Boolean),
    usage
  };
}

async function readJsonResponse(response) {
  const data = await response.json();
  const choice = Array.isArray(data.choices) && data.choices[0] ? data.choices[0] : null;
  const message = choice?.message || {};
  const usage = normalizeUsage(data.usage);
  return {
    content: message.content || "",
    toolCalls: message.tool_calls || [],
    usage
  };
}

export class UpstageAdapter {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.model = options.model || DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.UPSTAGE_API_KEY || "";
    this.temperature = typeof options.temperature === "number" ? options.temperature : 0.1;
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  async complete({ messages, tools = [], stream = true, onToken }) {
    if (!this.isConfigured()) {
      throw new Error("UPSTAGE_API_KEY is not configured");
    }

    const payload = {
      model: this.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: this.temperature,
      stream
    };

    const response = await fetchWithRetry(() =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })
    );

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Upstage API error (${response.status}): ${bodyText}`);
    }

    if (stream) {
      return readSseStream(response, onToken);
    }

    return readJsonResponse(response);
  }
}
