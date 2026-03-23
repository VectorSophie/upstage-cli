import test from "node:test";
import assert from "node:assert/strict";

import { shouldRoutePrintableToComposer } from "../src/ui/input-routing.js";

test("routes printable input to composer when focus is not input", () => {
  const shouldRoute = shouldRoutePrintableToComposer({
    focusedPane: "chat",
    input: "a",
    key: {},
    isProcessing: false,
    showSessions: false,
    hasApproval: false
  });
  assert.equal(shouldRoute, true);
});

test("does not route control/navigation keys to composer", () => {
  assert.equal(
    shouldRoutePrintableToComposer({
      focusedPane: "chat",
      input: "x",
      key: { ctrl: true },
      isProcessing: false,
      showSessions: false,
      hasApproval: false
    }),
    false
  );
  assert.equal(
    shouldRoutePrintableToComposer({
      focusedPane: "sidebar",
      input: "",
      key: { return: true },
      isProcessing: false,
      showSessions: false,
      hasApproval: false
    }),
    false
  );
});

test("does not route when UI should ignore typing", () => {
  assert.equal(
    shouldRoutePrintableToComposer({
      focusedPane: "chat",
      input: "a",
      key: {},
      isProcessing: true,
      showSessions: false,
      hasApproval: false
    }),
    false
  );
  assert.equal(
    shouldRoutePrintableToComposer({
      focusedPane: "chat",
      input: "a",
      key: {},
      isProcessing: false,
      showSessions: true,
      hasApproval: false
    }),
    false
  );
  assert.equal(
    shouldRoutePrintableToComposer({
      focusedPane: "chat",
      input: "a",
      key: {},
      isProcessing: false,
      showSessions: false,
      hasApproval: true
    }),
    false
  );
});
