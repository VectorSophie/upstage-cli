import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../colors.js';

export const RepoMap = ({ data, onCancel }) => {
  const [index, setIndex] = useState(0);

  const flatFiles = Object.entries(data.byExtension || {})
    .flatMap(([ext, files]) => files.map(f => ({ ext, path: f })))
    .slice(0, 30);

  useInput((input, key) => {
    if (key.upArrow) setIndex(Math.max(0, index - 1));
    if (key.downArrow) setIndex(Math.min(flatFiles.length - 1, index + 1));
    if (key.escape) onCancel();
  });

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      borderStyle: "round",
      borderColor: THEME.secondary,
      width: 60,
      position: "absolute",
      marginTop: 2,
      marginLeft: 5
    },
    React.createElement(
      Box,
      { marginBottom: 1, justifyContent: "center" },
      React.createElement(Text, { color: THEME.primary, bold: true }, "📂 REPO MAP")
    ),
    flatFiles.length === 0
      ? React.createElement(Text, { color: THEME.dim }, "No repository data found.")
      : flatFiles.map((file, i) =>
          React.createElement(
            Box,
            { key: i, paddingX: 1, backgroundColor: i === index ? THEME.secondary : undefined },
            React.createElement(
              Text,
              { color: i === index ? THEME.text.primary : THEME.text.secondary },
              `${i === index ? '→ ' : '  '}${file.path}`
            ),
            React.createElement(
              Text,
              { color: THEME.dim, italic: true },
              ` (${file.ext})`
            )
          )
        ),
    React.createElement(
      Box,
      { marginTop: 1, justifyContent: "center" },
      React.createElement(Text, { color: THEME.dim, size: "xs" }, "↑↓: Navigate · Esc: Close")
    )
  );
};
