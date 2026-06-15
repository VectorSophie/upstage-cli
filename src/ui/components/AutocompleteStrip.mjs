import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from "../colors.mjs";

/**
 * Suggestion strip shown under the composer. Renders nothing when there is no
 * active autocomplete. `autocomplete` is the result of getAutocomplete();
 * `commands` is the COMMANDS map (for descriptions on slash suggestions).
 */
export const AutocompleteStrip = ({ autocomplete, commands = {} }) => {
  if (!autocomplete || !autocomplete.items || autocomplete.items.length === 0) return null;

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 2 },
    ...autocomplete.items.slice(0, 6).map((it, idx) => {
      const name = autocomplete.mode === 'command' ? it.name : `@${it}`;
      const desc = autocomplete.mode === 'command' ? (commands[it.name]?.description || '') : '';
      return React.createElement(
        Text,
        { key: name, color: idx === 0 ? THEME.primary : THEME.dim },
        `${idx === 0 ? '› ' : '  '}${name}${desc ? '  ' : ''}`,
        desc ? React.createElement(Text, { color: THEME.text.dim }, desc) : null
      );
    }),
    React.createElement(Text, { color: THEME.text.dim }, '  ⇥ accept  ·  ⇧⇥ change mode')
  );
};
