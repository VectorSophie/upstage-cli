import React, { useMemo } from "react";
import { useKeyboard } from "@opentui/react";
import { THEME } from "../colors.mjs";
import { t } from "../../i18n/index.mjs";

export const RepoMap = ({ data, onCancel, isSidebar }) => {
  useKeyboard((key) => {
    if (!isSidebar && key.name === "escape") onCancel?.();
  });

  const options = useMemo(() => Object.entries(data.byExtension || {})
    .flatMap(([ext, files]) => files.map((f) => ({ name: f, description: ext })))
    .slice(0, 60), [data]);

  const body = options.length === 0
    ? React.createElement("text", { fg: THEME.dim }, t("repoMap.noData"))
    : React.createElement("select", {
        options,
        focused: !isSidebar,
        height: isSidebar ? undefined : Math.min(14, options.length + 1),
        flexGrow: isSidebar ? 1 : undefined,
        textColor: THEME.text.secondary,
        focusedTextColor: THEME.text.primary,
        focusedBackgroundColor: THEME.secondary
      });

  if (isSidebar) {
    return React.createElement(
      "box",
      { flexDirection: "column", flexGrow: 1 },
      body
    );
  }

  return React.createElement(
    "box",
    {
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      borderStyle: "rounded",
      borderColor: THEME.secondary,
      width: 60,
      position: "absolute",
      top: 2,
      left: 5
    },
    React.createElement(
      "box",
      { marginBottom: 1, justifyContent: "center" },
      React.createElement("text", { fg: THEME.primary, bold: true }, t("repoMap.title"))
    ),
    body,
    React.createElement(
      "box",
      { marginTop: 1, justifyContent: "center" },
      React.createElement("text", { fg: THEME.dim }, t("repoMap.navigate"))
    )
  );
};
