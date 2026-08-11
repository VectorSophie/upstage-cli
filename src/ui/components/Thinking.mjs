import React, { useEffect, useState } from "react";
import { THEME } from "../colors.mjs";
import { t } from "../../i18n/index.mjs";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinnerFrame(intervalMs = 80) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return FRAMES[frame];
}

export const Thinking = ({ status, steps = [] }) => {
  const spinner = useSpinnerFrame();

  return React.createElement(
    "box",
    { flexDirection: "column", paddingLeft: 1, borderStyle: "rounded", borderColor: THEME.dim },
    React.createElement(
      "box",
      { flexDirection: "row" },
      React.createElement("text", { fg: THEME.accent }, `${spinner} ${status || t("thinking.default")}`)
    ),
    steps.length > 0 ? React.createElement(
      "box",
      { flexDirection: "column", marginLeft: 2, marginTop: 1 },
      steps.map((step, i) =>
        React.createElement(
          "box",
          { key: i, flexDirection: "row" },
          React.createElement("text", { fg: step.done ? THEME.text.success : THEME.text.dim }, step.done ? "✓ " : "○ "),
          React.createElement("text", { fg: THEME.text.dim }, step.label)
        )
      )
    ) : null
  );
};
