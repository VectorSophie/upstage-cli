import React, { useMemo } from "react";
import { useKeyboard } from "@opentui/react";
import { THEME } from "../colors.mjs";
import { t } from "../../i18n/index.mjs";

export const SessionBrowser = ({ sessions = [], onSelect, onCancel }) => {
  useKeyboard((key) => {
    if (key.name === "escape") onCancel();
  });

  const options = useMemo(() => sessions.map((s) => ({
    name: `${s.id.slice(0, 12)}...`,
    description: s.workspace?.cwd?.split(/[\\/]/).pop() || t("sessionBrowser.unknown"),
    value: s
  })), [sessions]);

  return React.createElement(
    "box",
    {
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      borderStyle: "double",
      borderColor: THEME.primary,
      width: 60,
      position: "absolute",
      top: 2,
      left: 10
    },
    React.createElement(
      "box",
      { marginBottom: 1, justifyContent: "center" },
      React.createElement("text", { fg: THEME.primary, bold: true }, t("sessionBrowser.title"))
    ),
    sessions.length === 0
      ? React.createElement("text", { fg: THEME.dim }, t("sessionBrowser.noSessions"))
      : React.createElement("select", {
          options,
          focused: true,
          height: Math.min(12, sessions.length + 1),
          textColor: THEME.text.secondary,
          focusedTextColor: THEME.text.primary,
          focusedBackgroundColor: THEME.accent,
          onSelect: (_index, option) => {
            if (option) onSelect(option.value);
          }
        }),
    React.createElement(
      "box",
      { marginTop: 1, justifyContent: "space-between" },
      React.createElement("text", { fg: THEME.dim }, t("sessionBrowser.navigate")),
      React.createElement("text", { fg: THEME.dim }, t("sessionBrowser.selectCancel"))
    )
  );
};
