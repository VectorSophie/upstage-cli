import React from "react";
import { THEME } from "../colors.mjs";

// Thin wrapper around OpenTUI's native `diff` component — it colors/syntax-
// highlights internally from the raw unified-diff string, so unlike the old
// hand-rolled version there's no pre-baked ANSI text to worry about wrapping.
export const DiffPreview = ({ diff, filetype }) => {
  if (!diff) return null;

  return React.createElement("box", { paddingX: 1, borderStyle: "rounded", borderColor: THEME.dim, marginTop: 1 },
    React.createElement("diff", {
      diff,
      filetype,
      view: "unified",
      showLineNumbers: true,
      addedBg: "#0c2c0c",
      removedBg: "#2c0c0c",
      addedSignColor: THEME.text.success,
      removedSignColor: THEME.text.error,
      height: Math.min(24, diff.split("\n").length + 1)
    })
  );
};
