import React from "react";
import { THEME, gradientColors } from "../colors.mjs";

// A single 4-pointed sparkle, hand-drawn in block-drawing characters —
// crisp and dense rather than a downsampled photo (a pixel-accurate
// half-block reproduction of the reference image was tried first; it read
// as a blurry raster image and forced an explicit background fill behind
// every cell, losing both the density of plain character art and true
// transparency).
//
// All 4 points taper by the same rule: a proper triangular flange per axis
// direction (thick at the center, narrowing linearly to a single-cell tip),
// generated from a small distance formula rather than hand-tuned per side —
// two earlier attempts special-cased the east/west arms (a flat doubled
// block run, then a thin line-drawing "─" run) and both read as visually
// different from the north/south points instead of matching them.
const SPARKLE = [
  "       ▄       ",
  "      ▄█▄      ",
  "     ▄███▄     ",
  " ▄▄█████████▄▄ ",
  " ▀▀█████████▀▀ ",
  "     ▀███▀     ",
  "      ▀█▀      ",
  "       ▀       "
];

// Colors sampled from the reference image itself: pale periwinkle top
// fading into the blue core (rows 0-3), then the two legs split left/right
// exactly like the source — pink on the left leg, blue on the right
// (rows 4-7) — rather than one flat top-to-bottom sweep, which is what the
// actual mark looks like.
const TOP_STOPS = ["#cfd2e0", "#a9b4f8"];
const PINK_STOPS = ["#ac98f8", "#e49dec"];
const BLUE_STOPS = ["#6880f1", "#4c6ce7"];
const SPLIT_FROM_ROW = 4;

function splitMid(str) {
  const cut = Math.ceil(str.length / 2);
  return [str.slice(0, cut), str.slice(cut)];
}

// No background fill anywhere — only the glyph's own characters are drawn,
// so the star sits directly on whatever's behind it (truly transparent,
// not a same-colored rectangle standing in for transparency).
export function Sparkle() {
  const topColors = gradientColors(TOP_STOPS, SPLIT_FROM_ROW);
  const legColors = gradientColors(PINK_STOPS, SPARKLE.length - SPLIT_FROM_ROW);
  const rightColors = gradientColors(BLUE_STOPS, SPARKLE.length - SPLIT_FROM_ROW);
  return React.createElement(
    "box",
    { flexDirection: "column" },
    ...SPARKLE.map((row, i) => {
      if (i < SPLIT_FROM_ROW) {
        return React.createElement("text", { key: i, fg: topColors[i] }, row);
      }
      const li = i - SPLIT_FROM_ROW;
      const [left, right] = splitMid(row);
      return React.createElement(
        "text",
        { key: i },
        React.createElement("span", { fg: legColors[li] }, left),
        React.createElement("span", { fg: rightColors[li] }, right)
      );
    })
  );
}

// A plain, classic 2-stop sweep (light blue → violet) — softer than the
// first pass, which started on a fairly saturated blue and ran all the way
// to the sparkle's brightest pink; that end stop is dropped here rather
// than swapped for a dimmer pink, per feedback to keep it to the two tones.
const TEXT_GRADIENT = ["#7C93F5", THEME.accent];

// Big splash-screen wordmark: the sparkle + "UPSTAGE" in OpenTUI's built-in
// ascii-font, mirroring opencode's Home screen composition (centered Logo
// above the prompt) — see packages/tui/src/routes/home.tsx and
// src/component/logo.tsx upstream. `ascii-font`'s own `color` prop only
// supports per-glyph-segment indices baked into the font data (not a free
// gradient), so the wordmark gradient is built by rendering each letter as
// its own ascii-font run, colored along TEXT_GRADIENT.
//
// Font size is width-aware: measured via a throwaway pty render, the
// "block" font needs ~68 columns for "UPSTAGE" (too wide for a chat pane
// next to our 36-col sidebar below ~110-col terminals) while "tiny" needs
// only ~27 — so pick block only when there's real room, otherwise fall back
// to tiny rather than let it overflow into the sidebar (same
// responsive-by-width spirit as the old responsive-logo.mjs). The sparkle
// itself is only 16 columns wide, so it needs no such switch.
export function BigLogo({ width = 0 } = {}) {
  const font = width >= 72 ? "block" : "tiny";
  const letters = [..."UPSTAGE"];
  const colors = gradientColors(TEXT_GRADIENT, letters.length);
  return React.createElement(
    "box",
    { flexDirection: "column", alignItems: "center" },
    React.createElement(Sparkle),
    React.createElement("box", { height: 1 }),
    React.createElement(
      "box",
      { flexDirection: "row" },
      ...letters.map((ch, i) => React.createElement("ascii-font", { key: i, text: ch, font, color: colors[i] }))
    )
  );
}

// Compact header wordmark — small gradient-tinted stars + plain text.
export function SmallWordmark({ sessionId, model, language }) {
  const [starTop, starBottom] = gradientColors(TEXT_GRADIENT, 2);
  return React.createElement(
    "box",
    { flexDirection: "row", paddingX: 1 },
    React.createElement("text", { fg: starTop, bold: true }, "✦"),
    React.createElement("text", { fg: starBottom, bold: true }, "✧ "),
    React.createElement("text", { fg: THEME.primary, bold: true }, "upstage"),
    React.createElement("text", { fg: THEME.text.dim }, `  ${model || "solar-pro2"}  ·  ${sessionId?.slice(0, 8) || "--------"}  ·  ${(language || "ko").toUpperCase()}`)
  );
}
