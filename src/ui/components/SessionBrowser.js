import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../colors.js';

export const SessionBrowser = ({ sessions = [], onSelect, onCancel }) => {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex(Math.max(0, index - 1));
    if (key.downArrow) setIndex(Math.min(sessions.length - 1, index + 1));
    if (key.return) onSelect(sessions[index]);
    if (key.escape) onCancel();
  });

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      borderStyle: "double",
      borderColor: THEME.primary,
      width: 60,
      position: "absolute",
      marginTop: 2,
      marginLeft: 10
    },
    React.createElement(
      Box,
      { marginBottom: 1, justifyContent: "center" },
      React.createElement(Text, { color: THEME.primary, bold: true }, "✦ SESSION BROWSER ✦")
    ),
    sessions.length === 0
      ? React.createElement(Text, { color: THEME.dim }, "No active sessions found.")
      : sessions.map((s, i) =>
          React.createElement(
            Box,
            { key: s.id, paddingX: 1, backgroundColor: i === index ? THEME.accent : undefined },
            React.createElement(
              Text,
              { color: i === index ? THEME.text.primary : THEME.text.secondary },
              `${i === index ? '> ' : '  '}${s.id.slice(0, 12)}...`
            ),
            React.createElement(
              Text,
              { color: THEME.text.dim, dimColor: true },
              ` (${s.workspace?.cwd?.split(/[\\/]/).pop() || 'unknown'})`
            )
          )
        ),
    React.createElement(
      Box,
      { marginTop: 1, justifyContent: "space-between" },
      React.createElement(Text, { color: THEME.dim, size: "xs" }, "↑↓: Navigate"),
      React.createElement(Text, { color: THEME.dim, size: "xs" }, "Enter: Select · Esc: Cancel")
    )
  );
};
