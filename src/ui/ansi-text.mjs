import React from "react";
import wrapAnsi from "wrap-ansi";

/**
 * Renders pre-colored (chalk/ANSI) text as a column of <text> lines, each
 * pre-wrapped to `width`. OpenTUI's own text-wrap splits on raw byte offsets
 * and can slice an SGR escape sequence in half, corrupting colors and even
 * losing text — every line handed to a <text> node must already fit on its
 * own. Returns an array of elements; spread as children of a column box.
 */
export function ansiLines(text, width, keyPrefix = "l") {
  const src = Array.isArray(text) ? text : String(text ?? "").split("\n");
  const w = Math.max(4, width || 80);
  const wrapped = src.flatMap((line) => wrapAnsi(line, w, { hard: true, trim: false }).split("\n"));
  return wrapped.map((line, i) =>
    React.createElement("text", { key: `${keyPrefix}${i}` }, line.length ? line : " ")
  );
}
