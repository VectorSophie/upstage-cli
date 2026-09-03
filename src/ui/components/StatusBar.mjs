import React from "react";
import { useAppContext } from "@opentui/react";
import { THEME } from "../colors.mjs";
import { modeLabel, modeColor } from "../mode-cycle.mjs";
import { reasoningEffortLabel, reasoningEffortColor } from "../reasoning-cycle.mjs";
import { t } from "../../i18n/index.mjs";

export const StatusBar = ({ statusKey, tokenUsage, approvalMode, systemWarning, language, onModeClick, reasoningEffort, onReasoningClick }) => {
  const { renderer } = useAppContext();
  const setPointer = (style) => renderer?.setMousePointer?.(style);
  const statusLabel = t(`status.${statusKey || "idle"}`);

  return React.createElement(
    "box",
    {
      flexDirection: "row",
      paddingX: 1,
      justifyContent: "space-between"
    },
    React.createElement(
      "box",
      { flexDirection: "row" },
      // Click to cycle mode — same action Shift+Tab already triggers.
      React.createElement(
        "text",
        {
          fg: modeColor(approvalMode), bold: true,
          onMouseUp: onModeClick,
          onMouseOver: () => setPointer("pointer"),
          onMouseOut: () => setPointer("default")
        },
        `▶ ${modeLabel(approvalMode)}  `
      ),
      // Click to cycle Solar Pro2's reasoning_effort — same action Ctrl+E triggers.
      React.createElement(
        "text",
        {
          fg: reasoningEffortColor(reasoningEffort), bold: true,
          onMouseUp: onReasoningClick,
          onMouseOver: () => setPointer("pointer"),
          onMouseOut: () => setPointer("default")
        },
        `${reasoningEffortLabel(reasoningEffort)}  `
      ),
      React.createElement("text", { fg: THEME.text.dim }, `${t("statusBar.status")}: `),
      React.createElement(
        "text",
        { fg: statusKey === "idle" ? THEME.secondary : THEME.accent },
        statusLabel
      )
    ),
    React.createElement(
      "box",
      { flexDirection: "row" },
      React.createElement(
        "text",
        { fg: THEME.text.dim },
        `${t("statusBar.tokens")}: ${tokenUsage.total.toLocaleString()} | ${t("statusBar.cost")}: $${tokenUsage.cost.toFixed(4)} | ${t("statusBar.language")}: ${String(language || "").toUpperCase()}`
      ),
      systemWarning
        ? React.createElement("text", { fg: THEME.text.warning }, ` | ${t("statusBar.warn")}`)
        : null
    )
  );
};
