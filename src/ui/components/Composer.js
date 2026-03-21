import React from 'react';
import { Box, Text, useInput } from 'ink';
import TextInputImport from 'ink-text-input';
import { THEME } from '../colors.js';

const TextInput = TextInputImport.default || TextInputImport;

export const Composer = ({ onSend, isDisabled, isFocused, value, onChange }) => {
  const query = typeof value === 'string' ? value : '';

  useInput((input, key) => {
    if (isFocused && key.return && !isDisabled && query.trim()) {
      onSend(query);
      onChange('');
    }
  });

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      paddingX: 1,
      borderStyle: "round",
      borderColor: !isFocused ? THEME.dim : (isDisabled ? THEME.dim : THEME.accent)
    },
    React.createElement(
      Box,
      { marginBottom: 0 },
      React.createElement(
        Text,
        { color: isFocused ? THEME.primary : THEME.dim, bold: true },
        isDisabled ? ' ◌ ' : ' ✦ '
      ),
      React.createElement(
        Box,
        { marginLeft: 1 },
        React.createElement(TextInput, {
          value: query,
          onChange,
          placeholder: isDisabled ? "Processing..." : "Ask anything...",
          focus: isFocused && !isDisabled
        })
      )
    ),
    React.createElement(
      Box,
      { justifyContent: "flex-end" },
      React.createElement(
        Text,
        { dimColor: true },
        isFocused ? (query.length > 0 ? 'Press Enter to send' : 'Type / for commands') : 'Press "i" to focus'
      )
    )
  );
};
