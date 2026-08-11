import React, { useState } from "react";
import { THEME } from "../colors.mjs";
import { t } from "../../i18n/index.mjs";

export const Composer = ({ onSend, isDisabled, isFocused, value, onChange }) => {
  const query = typeof value === "string" ? value : "";
  // OpenTUI's native `input` doesn't resync its own displayed buffer when
  // the controlling `value` prop changes to "" right after a submit fired
  // from inside itself (confirmed via live pty testing: the app's state
  // does clear — the placeholder hint below flips correctly — but the
  // rendered text stays stuck). Forcing a remount via `key` is the
  // standard workaround for a controlled native input that won't resync.
  const [resetKey, setResetKey] = useState(0);

  const handleSubmit = (submitted) => {
    const text = typeof submitted === "string" ? submitted : query;
    if (!isFocused || isDisabled || !text.trim()) {
      return;
    }
    onSend(text);
    onChange("");
    setResetKey((k) => k + 1);
  };

  return React.createElement(
    "box",
    {
      flexDirection: "column",
      paddingX: 1,
      borderStyle: "rounded",
      borderColor: !isFocused ? THEME.dim : (isDisabled ? THEME.dim : THEME.accent)
    },
    React.createElement(
      "box",
      { flexDirection: "row" },
      React.createElement(
        "text",
        { fg: isFocused ? THEME.primary : THEME.dim, bold: true },
        isDisabled ? " ◌ " : " ✦ "
      ),
      React.createElement("input", {
        key: resetKey,
        value: query,
        onInput: onChange,
        onSubmit: handleSubmit,
        placeholder: isDisabled ? t("composer.processing") : t("composer.askAnything"),
        focused: isFocused && !isDisabled,
        flexGrow: 1
      })
    ),
    React.createElement(
      "box",
      { justifyContent: "flex-end" },
      React.createElement(
        "text",
        { fg: THEME.text.dim },
        isFocused
          ? (query.length > 0 ? t("composer.pressEnter") : t("composer.typeForCommands"))
          : t("composer.pressToFocus")
      )
    )
  );
};
