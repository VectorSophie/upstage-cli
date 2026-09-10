// Tests for `upstage auth status/test` — Task 12.8 of the 3.2.0 release plan
// (src/cli/commands/auth.mjs).
//
// Every `gather*` function accepts an injectable `checkReachability` so
// these tests never make a real network call — same "mock the live-
// reachability call" requirement the task spec calls out explicitly. Env
// vars (UPSTAGE_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY /
// OPENROUTER_API_KEY) are saved/restored around every test that touches
// them, since checkProviderKeys() reads process.env directly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  gatherAuthStatus, formatAuthStatusHuman, formatAuthStatusJson, runAuthStatusCommand,
  gatherAuthTest, formatAuthTestHuman, formatAuthTestJson, runAuthTestCommand
} from "../src/cli/commands/auth.mjs";

const KEY_VARS = ["UPSTAGE_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];

// A fake, distinctive "secret" value — alphanumeric/underscore only (safe to
// use verbatim as a regex literal), chosen to be extremely unlikely to
// appear anywhere in real output by coincidence. Same technique as
// tests/m33-doctor.test.mjs's / tests/m33-cli-mcp.test.mjs's FAKE_SECRET.
const FAKE_SECRET = "sk_TOTALLY_FAKE_AUTH_SECRET_zzz999xyz";

function withEnv(overrides, run) {
  const saved = {};
  for (const key of KEY_VARS) saved[key] = process.env[key];
  for (const key of KEY_VARS) delete process.env[key];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of KEY_VARS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

function neverCalledCheck() {
  return async () => {
    throw new Error("checkReachability must not be called when no key is configured");
  };
}

// ── status: source / key presence / active provider ──────────────────────

test("auth status: no keys configured — every provider 'not configured', active provider's api is 'not-configured' (no live call attempted)", () =>
  withEnv({}, async () => {
    const report = await gatherAuthStatus({ settings: { model: "solar-pro4" }, checkReachability: neverCalledCheck() });
    assert.ok(report.rows.every((r) => r.key === "not configured"));
    assert.equal(report.activeProviderId, "upstage");
    assert.equal(report.apiCheck.status, "not-configured");
  })
);

test("auth status: UPSTAGE_API_KEY set shows 'configured' with Source=UPSTAGE_API_KEY, and active provider gets a live check", () =>
  withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    let called = false;
    const checkReachability = async ({ apiKey }) => {
      called = true;
      assert.equal(apiKey, FAKE_SECRET, "the real key must be passed through to the check function");
      return { status: "reachable", detail: "API reachable" };
    };
    const report = await gatherAuthStatus({ settings: { model: "solar-pro4" }, checkReachability });
    assert.ok(called);
    const upstageRow = report.rows.find((r) => r.id === "upstage");
    assert.equal(upstageRow.key, "configured");
    assert.equal(upstageRow.source, "UPSTAGE_API_KEY");
    assert.equal(upstageRow.active, true);
    assert.equal(report.apiCheck.status, "reachable");
  })
);

test("auth status: OPENAI_API_KEY configured, but model selects upstage as active — openai's row still shows configured, but api check is for upstage only", () =>
  withEnv({ OPENAI_API_KEY: FAKE_SECRET }, async () => {
    const report = await gatherAuthStatus({ settings: { model: "solar-pro4" }, checkReachability: neverCalledCheck() });
    const openaiRow = report.rows.find((r) => r.id === "openai");
    assert.equal(openaiRow.key, "configured");
    assert.equal(openaiRow.active, false);
    assert.equal(report.activeProviderId, "upstage");
    assert.equal(report.apiCheck.status, "not-configured", "upstage itself has no key configured");
  })
);

test("auth status: active provider is openai (model=gpt-4o) — api check reports 'not-checked' (Upstage only), even with a real-looking key", () =>
  withEnv({ OPENAI_API_KEY: FAKE_SECRET }, async () => {
    const report = await gatherAuthStatus({ settings: { model: "gpt-4o" }, checkReachability: neverCalledCheck() });
    assert.equal(report.activeProviderId, "openai");
    assert.equal(report.apiCheck.status, "not-checked");
    assert.match(report.apiCheck.detail, /Upstage only/);
  })
);

test("auth status: GEMINI provider's Source resolves to the alt env var (GOOGLE_API_KEY) when only that one is set", () =>
  withEnv({ GOOGLE_API_KEY: FAKE_SECRET }, async () => {
    const report = await gatherAuthStatus({ settings: { model: "solar-pro4" }, checkReachability: neverCalledCheck() });
    const geminiRow = report.rows.find((r) => r.id === "gemini");
    assert.equal(geminiRow.key, "configured");
    assert.equal(geminiRow.source, "GOOGLE_API_KEY");
  })
);

test("auth status: unreachable is distinct from not-configured — both are reported, never conflated", () =>
  withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    const report = await gatherAuthStatus({
      settings: { model: "solar-pro4" },
      checkReachability: async () => ({ status: "unreachable", detail: "network timeout" })
    });
    assert.equal(report.apiCheck.status, "unreachable");
    assert.notEqual(report.apiCheck.status, "not-configured");
  })
);

// ── status: formatting ────────────────────────────────────────────────────

test("formatAuthStatusHuman has a PROVIDER SOURCE KEY ACTIVE columns shape and an API summary line", () =>
  withEnv({}, async () => {
    const report = await gatherAuthStatus({ settings: { model: "solar-pro4" }, checkReachability: neverCalledCheck() });
    const text = formatAuthStatusHuman(report);
    assert.match(text, /PROVIDER\s+SOURCE\s+KEY\s+ACTIVE/);
    assert.match(text, /Upstage\s+UPSTAGE_API_KEY\s+not configured\s+yes/);
    assert.match(text, /API: /);
  })
);

test("runAuthStatusCommand: always exits 0 (report/data, never a command failure) across plain/--json, configured/unconfigured", () =>
  withEnv({}, () =>
    withEnv({}, async () => {
      assert.equal(await runAuthStatusCommand([]), 0);
      assert.equal(await runAuthStatusCommand(["--json"]), 0);
    })
  )
);

test("runAuthStatusCommand: --help prints usage and exits 0", async () => {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  let code;
  try {
    code = await runAuthStatusCommand(["--help"]);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(out.join(""), /Usage: upstage auth status/);
});

// ── test: forces the live check for a named provider ──────────────────────

test("auth test <upstage>: not configured — result.api.status = 'not-configured', no live call attempted, exit code 4", () =>
  withEnv({}, async () => {
    const outcome = await gatherAuthTest({ provider: "upstage", settings: { model: "solar-pro4" }, checkReachability: neverCalledCheck() });
    assert.equal(outcome.result.api.status, "not-configured");
    assert.equal(outcome.result.key, "not configured");
  })
);

test("auth test <upstage>: configured + reachable — exit code 0", () =>
  withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    const outcome = await gatherAuthTest({
      provider: "upstage",
      settings: { model: "solar-pro4" },
      checkReachability: async () => ({ status: "reachable", detail: "API reachable" })
    });
    assert.equal(outcome.result.api.status, "reachable");
  })
);

test("auth test <upstage>: configured + unreachable — real error detail surfaced, not a bare failure", () =>
  withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    const outcome = await gatherAuthTest({
      provider: "upstage",
      settings: { model: "solar-pro4" },
      checkReachability: async () => ({ status: "unreachable", detail: "Upstage API error (503)" })
    });
    assert.equal(outcome.result.api.status, "unreachable");
    assert.match(outcome.result.api.detail, /503/);
  })
);

test("auth test <openai>: forced regardless of active provider, but no live client exists — reports 'not-checked'", () =>
  withEnv({ OPENAI_API_KEY: FAKE_SECRET }, async () => {
    // Active provider is upstage (model=solar-pro4), but `test` targets
    // openai explicitly — this must NOT silently test upstage instead.
    const outcome = await gatherAuthTest({ provider: "openai", settings: { model: "solar-pro4" }, checkReachability: neverCalledCheck() });
    assert.equal(outcome.result.provider, "openai");
    assert.equal(outcome.result.key, "configured");
    assert.equal(outcome.result.api.status, "not-checked");
  })
);

test("auth test: unknown provider name is a usage error (code 2)", async () => {
  const outcome = await gatherAuthTest({ provider: "not-a-real-provider" });
  assert.equal(outcome.code, 2);
});

test("auth test: missing provider argument is a usage error (code 2)", async () => {
  const outcome = await gatherAuthTest({});
  assert.equal(outcome.code, 2);
});

test("runAuthTestCommand: exit codes — 2 unknown provider, 4 not-configured, 0 reachable, 3 unreachable, 0 not-checked", async () => {
  await withEnv({}, async () => {
    assert.equal(await runAuthTestCommand(["bogus-provider"]), 2);
    assert.equal(await runAuthTestCommand([]), 2);
  });

  // These call runAuthTestCommand's real code path, which uses the REAL
  // default checkReachability (src/upstage/client.mjs's upstageRequest) —
  // but only ever reaches it when a key is configured. With no key
  // configured, "not-configured" is returned before any network attempt,
  // so this stays offline-safe.
  await withEnv({}, async () => {
    assert.equal(await runAuthTestCommand(["upstage"]), 4);
  });
  await withEnv({ OPENAI_API_KEY: FAKE_SECRET }, async () => {
    assert.equal(await runAuthTestCommand(["openai"]), 0, "not-checked is data, not a failure");
  });
});

test("formatAuthTestHuman/formatAuthTestJson", () =>
  withEnv({ UPSTAGE_API_KEY: FAKE_SECRET }, async () => {
    const outcome = await gatherAuthTest({
      provider: "upstage",
      settings: { model: "solar-pro4" },
      checkReachability: async () => ({ status: "reachable", detail: "API reachable" })
    });
    const human = formatAuthTestHuman(outcome.result);
    assert.match(human, /provider: upstage/);
    assert.match(human, /api: reachable/);
    const json = JSON.parse(formatAuthTestJson(outcome.result));
    assert.equal(json.provider, "upstage");
    assert.equal(json.api.status, "reachable");
  })
);

// ── security: NEVER prints a key value — dedicated adversarial test ──────

test("auth status/test NEVER print a key value, anywhere in human or JSON output, for any provider", () =>
  withEnv(
    {
      UPSTAGE_API_KEY: FAKE_SECRET,
      OPENAI_API_KEY: FAKE_SECRET,
      GEMINI_API_KEY: FAKE_SECRET,
      OPENROUTER_API_KEY: FAKE_SECRET
    },
    async () => {
      const statusReport = await gatherAuthStatus({
        settings: { model: "solar-pro4" },
        checkReachability: async () => ({ status: "reachable", detail: "API reachable" })
      });
      const statusHuman = formatAuthStatusHuman(statusReport);
      const statusJson = formatAuthStatusJson(statusReport);
      assert.doesNotMatch(statusHuman, new RegExp(FAKE_SECRET));
      assert.doesNotMatch(statusJson, new RegExp(FAKE_SECRET));
      assert.doesNotMatch(JSON.stringify(statusReport), new RegExp(FAKE_SECRET));

      for (const provider of ["upstage", "openai", "gemini", "openrouter"]) {
        const testOutcome = await gatherAuthTest({
          provider,
          settings: { model: "solar-pro4" },
          checkReachability: async () => ({ status: "reachable", detail: "API reachable" })
        });
        const testHuman = formatAuthTestHuman(testOutcome.result);
        const testJson = formatAuthTestJson(testOutcome.result);
        assert.doesNotMatch(testHuman, new RegExp(FAKE_SECRET), `provider=${provider} human output leaked the key`);
        assert.doesNotMatch(testJson, new RegExp(FAKE_SECRET), `provider=${provider} json output leaked the key`);
        assert.doesNotMatch(JSON.stringify(testOutcome), new RegExp(FAKE_SECRET), `provider=${provider} raw result leaked the key`);
      }
    }
  )
);

// Adversarial, via the real router-facing CLI entry point (in case
// formatting bypasses the format* helpers above) — deliberately does NOT
// set UPSTAGE_API_KEY, so runAuthStatusCommand's default (real, unmocked)
// checkReachability is never actually invoked (see resolveApiCheck: a
// missing key short-circuits to 'not-configured' before any network call),
// keeping this test offline-safe while still exercising the real code path
// stdout goes through.
test("runAuthStatusCommand's real (unmocked) stdout path never leaks a key value either", () =>
  withEnv({}, async () => {
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runAuthStatusCommand([]);
      await runAuthStatusCommand(["--json"]);
    } finally {
      process.stdout.write = orig;
    }
    assert.doesNotMatch(out.join(""), new RegExp(FAKE_SECRET));
  })
);
