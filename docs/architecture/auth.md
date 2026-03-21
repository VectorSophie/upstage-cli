# upstage-cli Authentication Design

## Goals

- Simple API-key-first onboarding.
- Works in interactive and CI/headless environments.
- Supports secure local persistence and key rotation.

## Auth Methods

1. **Environment variable** (highest precedence in runtime)
2. **Config file storage** (encrypted when available)
3. **Interactive login command** (`upstage login`)

## Environment Variable Support

Primary variable:

- `UPSTAGE_API_KEY`

Optional provider fallback variables for multi-model operations may be introduced later but should not be required for core Upstage flow.

## Config File Storage

Path strategy:

- Linux/macOS: `${XDG_CONFIG_HOME:-~/.config}/upstage-cli/config.toml`
- Windows: `%APPDATA%\\upstage-cli\\config.toml`

Stored fields:

- active profile
- key reference metadata
- model defaults
- auth mode metadata

Security policy:

- Prefer OS keychain/credential vault for raw secret material.
- Config stores key alias/reference, not plaintext where possible.
- If secure store unavailable, warn user and require explicit opt-in for plaintext fallback.

## CLI Login Flow

Command:

```bash
upstage login
```

Flow:

1. Prompt for API key (hidden input).
2. Validate by lightweight API probe.
3. Save to secure store and write profile metadata.
4. Print active profile and test status.

Related commands:

- `upstage logout`
- `upstage auth status`
- `upstage auth switch <profile>`

## Resolution Order at Runtime

1. `UPSTAGE_API_KEY` env value
2. Active profile in secure store/config
3. Fail with actionable error and `upstage login` hint

## Headless/CI Behavior

- Non-interactive runs do not prompt.
- If key missing, exit non-zero with clear remediation.
- CI docs recommend injecting `UPSTAGE_API_KEY` at job scope.

## Rotation and Revocation

- `upstage login --replace` rotates active key.
- `upstage logout` removes local references and cache.
- If API returns auth failure repeatedly, mark key invalid and request re-login.
