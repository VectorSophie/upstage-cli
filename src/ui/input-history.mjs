/**
 * InputHistory — shell-style prompt history with ↑/↓ navigation.
 * `prev()` walks backward into the past; `next()` walks forward toward the
 * present (returning "" once you step past the newest entry). No React.
 */
export class InputHistory {
  constructor(items = [], max = 200) {
    this.items = Array.isArray(items) ? items.slice(-max) : [];
    this.max = max;
    this.cursor = this.items.length; // points "after" the newest entry
  }

  push(entry) {
    const e = typeof entry === "string" ? entry.trim() : "";
    if (!e) return;
    if (this.items[this.items.length - 1] === e) {
      this.cursor = this.items.length;
      return; // skip consecutive duplicates
    }
    this.items.push(e);
    if (this.items.length > this.max) this.items.shift();
    this.cursor = this.items.length;
  }

  /** Move back one entry (older). Returns the entry or null at the start. */
  prev() {
    if (this.items.length === 0) return null;
    if (this.cursor > 0) this.cursor -= 1;
    return this.items[this.cursor] ?? null;
  }

  /** Move forward one entry (newer). Returns "" once past the newest. */
  next() {
    if (this.cursor < this.items.length) this.cursor += 1;
    return this.cursor >= this.items.length ? "" : this.items[this.cursor];
  }

  reset() {
    this.cursor = this.items.length;
  }

  toArray() {
    return [...this.items];
  }
}
