import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from "../colors.mjs";
import { t } from "../../i18n/index.mjs";

export const StatusBar = ({ statusKey, tokenUsage, approvalMode, systemWarning, language }) => {
  const getModeColor = () => {
    if (approvalMode === 'plan') return THEME.accent;
    if (approvalMode === 'auto') return THEME.secondary;
    return THEME.dim;
  };

  const modeKey = approvalMode === 'plan' || approvalMode === 'auto' ? approvalMode : 'default';
  const statusLabel = t(`status.${statusKey || 'idle'}`);

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
          ` ▶ ${t(`statusBar.mode.${modeKey}`)} `
        )
      ),
      React.createElement(Text, { dimColor: true }, `${t('statusBar.status')}: `),
      React.createElement(
        Text,
        { color: statusKey === 'idle' ? THEME.secondary : THEME.accent },
        statusLabel
      )
    ),
    React.createElement(
      Box,
      null,
      React.createElement(
        Text,
        { color: THEME.text.dim },
        `${t('statusBar.tokens')}: ${tokenUsage.total.toLocaleString()} | ${t('statusBar.cost')}: $${tokenUsage.cost.toFixed(4)} | ${t('statusBar.language')}: ${String(language || '').toUpperCase()}`
      ),
      systemWarning ? React.createElement(
        Text,
        { color: THEME.text.warning },
        ` | ${t('statusBar.warn')}`
      ) : null
    )
  );
};
