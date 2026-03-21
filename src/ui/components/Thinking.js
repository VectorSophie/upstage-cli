import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import SpinnerImport from 'ink-spinner';
import { THEME } from '../colors.js';
import { t } from '../../i18n/index.js';

const Spinner = SpinnerImport.default || SpinnerImport;

export const Thinking = ({ status, steps = [] }) => {
  return React.createElement(
    Box,
    { flexDirection: "column", paddingLeft: 1, borderStyle: "round", borderColor: THEME.dim },
    React.createElement(
      Box,
      null,
      React.createElement(
        Text,
        { color: THEME.accent },
        React.createElement(Spinner, { type: "dots" }),
        ` ${status || t('thinking.default')}`
      )
    ),
    steps.length > 0 && React.createElement(
      Box,
      { flexDirection: "column", marginLeft: 2, marginTop: 1 },
      steps.map((step, i) =>
        React.createElement(
          Box,
          { key: i },
          React.createElement(Text, { color: step.done ? THEME.text.success : THEME.text.dim }, step.done ? '✓ ' : '○ '),
          React.createElement(Text, { color: THEME.text.dim, italic: true }, step.label)
        )
      )
    )
  );
};
