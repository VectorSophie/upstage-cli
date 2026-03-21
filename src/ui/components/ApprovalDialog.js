import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../colors.js';
import { DiffPreview } from './DiffPreview.js';

export const ApprovalDialog = ({ tool, params, onApprove, onDeny }) => {
  useInput((input, key) => {
    if (input === 'y') onApprove();
    if (input === 'n') onDeny();
  });

  const isEdit = tool === 'edit_file' || tool === 'write_file';
  const isShell = tool === 'run_shell';

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      borderStyle: "bold",
      borderColor: THEME.accent,
      width: 80,
      position: "absolute",
      marginTop: 5,
      marginLeft: 10
    },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { color: THEME.text.warning, bold: true }, "⚠️ APPROVAL REQUIRED: "),
      React.createElement(Text, { color: THEME.primary }, tool)
    ),
    isEdit && params.diff && React.createElement(DiffPreview, { diff: params.diff }),
    isShell && React.createElement(
      Box,
      { paddingX: 1, borderStyle: "round", borderColor: THEME.dim, marginY: 1 },
      React.createElement(Text, { color: THEME.text.secondary }, params.command)
    ),
    React.createElement(
      Box,
      { marginTop: 1, justifyContent: "center" },
      React.createElement(Text, { color: THEME.text.primary }, "Allow this action? "),
      React.createElement(Text, { color: THEME.text.success, bold: true }, "(y)es "),
      React.createElement(Text, { color: THEME.text.error, bold: true }, "(n)o")
    )
  );
};
