import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from "../colors.mjs";

export const Sidebar = ({ activeTab, tabs, focusColor, isFocused, height }) => {
  return React.createElement(
    Box,
    { 
      flexDirection: "column", 
      width: 36, 
      height: height,
      borderStyle: "round", 
      borderColor: isFocused ? focusColor : THEME.dim,
      paddingX: 1,
      overflow: "hidden"
    },
    React.createElement(
      Box,
      { marginBottom: 1, justifyContent: "space-between" },
      tabs.map(tab => (
        React.createElement(
          Box,
          { 
            key: tab.id, 
            borderStyle: "single", 
            borderColor: activeTab === tab.id ? THEME.primary : THEME.dim,
            paddingX: 1
          },
          React.createElement(
            Text,
            { color: activeTab === tab.id ? THEME.secondary : THEME.text.dim, bold: activeTab === tab.id },
            tab.label
          )
        )
      ))
    ),
    React.createElement(
      Box,
      { flexGrow: 1, flexDirection: "column" },
      tabs.find(t => t.id === activeTab)?.component
    )
  );
};
