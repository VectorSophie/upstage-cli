import React from "react";
import { useKeyboard } from "@opentui/react";
import { THEME } from "../colors.mjs";
import { DiffPreview } from "./DiffPreview.mjs";
import { t } from "../../i18n/index.mjs";

export const ApprovalDialog = ({ tool, params, pii, onApprove, onDeny }) => {
  useKeyboard((key) => {
    if (key.name === "y") onApprove();
    if (key.name === "n") onDeny();
  });

  const isEdit = tool === "edit_file" || tool === "write_file";
  const isShell = tool === "run_shell";

  return React.createElement(
    "box",
    {
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      borderStyle: "double",
      borderColor: pii ? THEME.text.error : THEME.accent,
      width: 80,
      position: "absolute",
      top: 5,
      left: 10
    },
    React.createElement(
      "box",
      { flexDirection: "row", marginBottom: 1 },
      React.createElement("text", { fg: THEME.text.warning, bold: true }, t("approval.required")),
      React.createElement("text", { fg: THEME.primary }, ` ${tool}`)
    ),
    isEdit && params.diff ? React.createElement(DiffPreview, { diff: params.diff, filetype: params.filetype }) : null,
    isShell ? React.createElement(
      "box",
      { paddingX: 1, borderStyle: "rounded", borderColor: THEME.dim, marginTop: 1, marginBottom: 1 },
      React.createElement("text", { fg: THEME.text.secondary }, params.command)
    ) : null,
    // Korean PII guardrail (docs/feature-landscape-2026.md §2.1/§2.3): a
    // distinct, named warning — not folded into the generic confirmation —
    // so it reads as "this specific action touches Korean personal-data
    // patterns" rather than routine risk-based friction.
    pii ? React.createElement(
      "box",
      { flexDirection: "column", paddingX: 1, borderStyle: "rounded", borderColor: THEME.text.error, marginTop: 1, marginBottom: 1 },
      React.createElement("text", { fg: THEME.text.error, bold: true },
        `⚠ ${t("approval.piiDetected")}: ${Object.entries(pii.counts).map(([k, n]) => `${t(`approval.piiType.${k}`)}×${n}`).join(", ")}`),
      pii.pipaWarning
        ? React.createElement("text", { fg: THEME.text.warning }, `⚠ ${t("approval.pipaWarning")}`)
        : null
    ) : null,
    React.createElement(
      "box",
      { flexDirection: "row", marginTop: 1, justifyContent: "center" },
      React.createElement("text", { fg: THEME.text.primary }, `${t("approval.allowAction")} `),
      React.createElement("text", { fg: THEME.text.success, bold: true }, `${t("approval.yes")} `),
      React.createElement("text", { fg: THEME.text.error, bold: true }, t("approval.no"))
    )
  );
};
