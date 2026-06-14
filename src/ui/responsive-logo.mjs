/**
 * Responsive logo selection — keep the brand, fit the terminal.
 * Returns which logo variant to render given terminal dimensions:
 *   "full"     — the multi-line ASCII wordmark (tall, wide terminals)
 *   "wordmark" — the compact "◉ solar" one-liner (everything else)
 */

// The ASCII block is ~70 cols wide and ~10 rows tall.
const MIN_COLS_FOR_FULL = 72;
const MIN_ROWS_FOR_FULL = 22;

export function selectLogo({ cols = 80, rows = 24 } = {}) {
  if (cols >= MIN_COLS_FOR_FULL && rows >= MIN_ROWS_FOR_FULL) return "full";
  return "wordmark";
}

/** Convenience reading the live terminal size from stdout. */
export function selectLogoForStdout(stdout = process.stdout) {
  return selectLogo({ cols: stdout?.columns || 80, rows: stdout?.rows || 24 });
}
