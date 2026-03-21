import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../colors.js';

export const DiffPreview = ({ diff }) => {
  if (!diff) return null;

  const lines = diff.split('\n');

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1, borderStyle: "round", borderColor: THEME.dim, marginY: 1 },
    lines.map((line, i) => {
      let color = THEME.text.primary;
      if (line.startsWith('+')) color = THEME.text.success;
      else if (line.startsWith('-')) color = THEME.text.error;
      else if (line.startsWith('@@')) color = THEME.accent;

      return React.createElement(
        Text,
        { key: i, color },
        line
      );
    })
  );
};
