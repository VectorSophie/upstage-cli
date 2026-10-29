const CJK_START = 0x1100;
const CJK_END = 0xd7a3;

function charTokenRatio(str) {
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp >= CJK_START && cp <= CJK_END) cjk++;
  }
  // Blend ratio: CJK characters cost ~2 chars/token, ASCII ~4 chars/token
  const cjkRatio = cjk / str.length;
  return cjkRatio > 0.3 ? 2.5 : 4;
}

// Exported so other modules that need to report token counts consistent
// with ContextManager's own compaction decisions (e.g. src/agent/
// context-budget.mjs, powering `upstage context` and the TUI's `/context`)
// can reuse this exact heuristic instead of inventing a second one that
// would silently disagree with /compact's/`/cost`'s own numbers.
export function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / charTokenRatio(str));
}

function messageTokens(msg) {
  if (!msg) return 0;
  let count = 0;

  if (typeof msg.content === "string") {
    count += estimateTokens(msg.content);
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      count += estimateTokens(JSON.stringify(tc));
    }
  }

  return count;
}

const TRUNCATION_SUFFIX = " …[truncated]";
const MICRO_MAX_CHARS = 100;

export class ContextManager {
  // options.estimateMessage: per-message token estimator (default: the
  // heuristic above). A caller with a validated context budget passes a
  // calibrated one (src/agent/effective-context.mjs).
  constructor(maxTokens = 65_536, threshold = 0.8, options = {}) {
    this.maxTokens = maxTokens;
    this.threshold = threshold;
    this._messageTokens = typeof options.estimateMessage === "function" ? options.estimateMessage : messageTokens;
    this.compactionCount = 0;
    this.lastPreCompactTokens = 0;
    this.lastPostCompactTokens = 0;
  }

  getTokenCount(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((sum, msg) => sum + this._messageTokens(msg), 0);
  }

  shouldCompact(messages) {
    return this.getTokenCount(messages) >= this.maxTokens * this.threshold;
  }

  microCompact(messages, recentTurns = 5) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    // Find the boundary: last N user/assistant exchanges (2 * recentTurns messages)
    const boundary = Math.max(0, messages.length - recentTurns * 2);

    return messages.map((msg, idx) => {
      if (idx >= boundary) return msg;
      if (msg.role !== "tool") return msg;
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.length <= MICRO_MAX_CHARS) return msg;
      return { ...msg, content: content.slice(0, MICRO_MAX_CHARS) + TRUNCATION_SUFFIX };
    });
  }

  // options.pinned: a message (by reference) that must survive compaction
  // verbatim — the current task's instruction. options.force: skip the
  // micro-only shortcut and always do a full compaction.
  // options.maxSummaryChars: bound the summary (its most recent lines kept).
  compact(messages, keepRecent = 6, options = {}) {
    if (!Array.isArray(messages)) return messages;
    const pinned = options.pinned;

    // First try microCompact
    const micro = this.microCompact(messages);
    if (!options.force && !this.shouldCompact(micro)) {
      this.compactionCount++;
      this.lastPreCompactTokens = this.getTokenCount(messages);
      this.lastPostCompactTokens = this.getTokenCount(micro);
      return micro;
    }

    // Full compaction: keep last keepRecent messages, summarize the rest
    const pre = this.getTokenCount(messages);
    const kept = messages.slice(-keepRecent);
    const dropped = messages.slice(0, messages.length - keepRecent).filter((m) => m !== pinned);
    const keepPinned = pinned && !kept.includes(pinned) && messages.includes(pinned);

    const summary = dropped
      .map((m) => {
        const preview = typeof m.content === "string"
          ? m.content.slice(0, 120)
          : m.role === "assistant" && Array.isArray(m.tool_calls)
            ? `[called ${m.tool_calls.map((tc) => tc.function?.name).join(", ")}]`
            : "";
        return `${m.role}: ${preview}`;
      })
      .join("\n");

    const maxSummary = options.maxSummaryChars;
    const boundedSummary = Number.isInteger(maxSummary) && summary.length > maxSummary
      ? `…[earlier summary truncated]\n${summary.slice(summary.length - maxSummary)}`
      : summary;
    const summaryMessage = {
      role: "user",
      content: `[Context compacted — summary of ${dropped.length} earlier messages]\n\n${boundedSummary}`
    };

    const compacted = keepPinned ? [pinned, summaryMessage, ...kept] : [summaryMessage, ...kept];
    this.compactionCount++;
    this.lastPreCompactTokens = pre;
    this.lastPostCompactTokens = this.getTokenCount(compacted);
    return compacted;
  }

  addMessage(messages, msg) {
    const updated = [...messages, msg];
    return this.shouldCompact(updated) ? this.compact(updated) : updated;
  }

  getStats() {
    return {
      compactionCount: this.compactionCount,
      lastPreCompactTokens: this.lastPreCompactTokens,
      lastPostCompactTokens: this.lastPostCompactTokens
    };
  }
}
