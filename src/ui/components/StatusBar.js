import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../colors.js';

export const StatusBar = ({ status, tokenUsage, approvalMode, isFocused, systemWarning }) => {
  const getModeColor = () => {
    if (approvalMode === 'plan') return THEME.accent;
    if (approvalMode === 'auto') return THEME.secondary;
    return THEME.dim;
  };

  return React.createElement(
    Box,
    { 
      borderStyle: "single", 
      borderColor: THEME.dim, 
      paddingX: 1, 
      justifyContent: "space-between",
      marginBottom: 0
    },
    React.createElement(
      Box,
      null,
      React.createElement(
        Box,
        { marginRight: 2 },
        React.createElement(
          Text,
          { color: getModeColor(), bold: true },
          ` ▶ ${approvalMode?.toUpperCase() || 'DEFAULT'} `
        )
      ),
      React.createElement(Text, { dimColor: true }, "Status: "),
      React.createElement(
        Text,
        { color: status === 'Idle' ? THEME.secondary : THEME.accent },
        status
      )
    ),
    React.createElement(
      Box,
      null,
      React.createElement(
        Text,
        { color: THEME.text.dim },
        `Tokens: ${tokenUsage.total.toLocaleString()} | Cost: $${tokenUsage.cost.toFixed(4)}`
      ),
      systemWarning ? React.createElement(
        Text,
        { color: THEME.text.warning },
        " | WARN"
      ) : null
    )
  );
};

