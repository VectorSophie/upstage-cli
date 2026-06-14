/**
 * StreamBatcher — coalesce streamed tokens into ~frame-rate flushes so the Ink
 * TUI doesn't re-render on every single token (the #1 TUI perf trap). Tokens
 * accumulate and are flushed together on a timer or when `flush()` is called.
 */
export class StreamBatcher {
  constructor(onFlush, { intervalMs = 24 } = {}) {
    if (typeof onFlush !== "function") throw new Error("onFlush must be a function");
    this.onFlush = onFlush;
    this.intervalMs = intervalMs;
    this._buf = "";
    this._timer = null;
  }

  push(token) {
    if (token == null || token === "") return;
    this._buf += token;
    if (this._timer === null) {
      this._timer = setTimeout(() => this.flush(), this.intervalMs);
      if (typeof this._timer.unref === "function") this._timer.unref();
    }
  }

  /** Emit the buffered text now (if any) and clear the pending timer. */
  flush() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._buf) {
      const chunk = this._buf;
      this._buf = "";
      this.onFlush(chunk);
    }
  }

  /** Flush and stop — call when the stream ends. */
  stop() {
    this.flush();
  }

  get pending() {
    return this._buf;
  }
}
