import React from 'react';
import { Box, Text, useInput } from 'ink';
import TextInputImport from 'ink-text-input';
import { THEME } from '../colors.js';
import { t } from '../../i18n/index.js';

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
          placeholder: isDisabled ? t('composer.processing') : t('composer.askAnything'),
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
        isFocused
          ? (query.length > 0 ? t('composer.pressEnter') : t('composer.typeForCommands'))
          : t('composer.pressToFocus')
      )
    )
  );
};
