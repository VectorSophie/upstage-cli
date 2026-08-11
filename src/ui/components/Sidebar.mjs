import React from "react";
import { useAppContext } from "@opentui/react";
import { THEME } from "../colors.mjs";

export const Sidebar = ({ activeTab, tabs, isFocused, height, onTabClick }) => {
  const { renderer } = useAppContext();
  const setPointer = (style) => renderer?.setMousePointer?.(style);

  return React.createElement(
    "box",
    {
      flexDirection: "column",
      width: 36,
      height,
      backgroundColor: isFocused ? THEME.backgroundPanel : THEME.background,
      paddingX: 1,
      overflow: "hidden"
    },
    React.createElement(
      "box",
      { flexDirection: "row", marginBottom: 1, gap: 2 },
      // Click to switch tabs, same handler the p/c/t keyboard shortcuts
      // call — mouse and keyboard are just two triggers for one action.
      ...tabs.map((tab) => React.createElement(
        "text",
        {
          key: tab.id,
          fg: activeTab === tab.id ? THEME.primary : THEME.text.dim,
          bold: activeTab === tab.id,
          onMouseUp: () => onTabClick?.(tab.id),
          onMouseOver: () => setPointer("pointer"),
          onMouseOut: () => setPointer("default")
        },
        activeTab === tab.id ? `[${tab.label}]` : ` ${tab.label} `
      ))
    ),
    React.createElement(
      "box",
      { flexGrow: 1, flexDirection: "column" },
      tabs.find((tb) => tb.id === activeTab)?.component ?? null
    )
  );
};
