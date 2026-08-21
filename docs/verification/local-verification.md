# Local verification

GoodVibes has three verification layers:

| Layer | What it covers |
| --- | --- |
| `local signal` | Schema, routing, rendering, persistence, CLI, daemon, and real-state checks that can run without proving an external SaaS or device outcome |
| `local behavior` | Behavior that completes locally through in-process tests, the compiled CLI, a daemon smoke, or controlled persisted state |
| `external outcome` | Real delivery/provisioning checks such as Slack delivery, Cloudflare provisioning, Home Assistant device behavior, or a remote runner |

## Verification ledger

Run the inventory ledger:

```bash
bun run verification:ledger
```

Write JSON for automation:

```bash
bun run verification:ledger -- --json --out /tmp/goodvibes-verification-ledger
```

The ledger counts settings, feature flags, slash commands, panels, CLI commands, external surfaces, and onboarding capability bundles. It intentionally separates local proof from external proof so the project can show where verification is strong without claiming that a third-party service was exercised.

## GoodVibes home audit

Run a read-only audit against the active GoodVibes home:

```bash
bun run audit:home -- --home ~/.goodvibes
```

Write machine-readable output:

```bash
bun run audit:home -- --home ~/.goodvibes --json --out /tmp/goodvibes-home-audit
```

The audit checks:

- which files are owned by TUI, daemon, or another GoodVibes product;
- stale or unknown TUI settings in `tui/settings.json`;
- schema/default coverage for current settings;
- sensitive-file permissions for TUI and daemon secrets;
- duplicated generated profile names;
- write-boundary diffs so tests can prove TUI code did not mutate unrelated GoodVibes products.

The audit treats root-level `~/.goodvibes` files as owned by other GoodVibes products unless they are in `tui/` or `daemon/`.

## Live verification

Run the compiled CLI, authenticated daemon probes, inventory ledger, and home audit together:

```bash
bun run verification:live -- --home ~/.goodvibes --out /tmp/goodvibes-live-verification
```

The live verifier checks:

- inventory coverage is at least 90% local signal;
- `~/.goodvibes/tui/settings.json` has no stale TUI keys;
- `dist/goodvibes` exists and can run `version`, `status --output json`, `providers`, `control-plane status`, `listener test`, `surfaces check`, `service check`, and `doctor`;
- the daemon bearer token can authenticate `/status`, `/api/health`, and `/v1/models`;
- warnings are preserved for real posture problems such as an enabled-but-unreachable web surface or an enabled service that is not installed.

By default, warnings do not fail the command because they are useful runtime findings. Use strict mode when every warning should fail automation:

```bash
bun run verification:live -- --strict --out /tmp/goodvibes-live-verification-strict
```

## Release-oriented local gate

For a practical local gate before a release or large config migration:

```bash
bun test src/test/config/goodvibes-home-audit.test.ts src/test/verification/verification-ledger.test.ts
bun test src/test/input src/test/panels
bun run tsc --noEmit --pretty false
bun run architecture:check
bun run perf:check
bun run build
bun run smoke:tui
bun run verification:live -- --home ~/.goodvibes --out /tmp/goodvibes-live-verification
```

`surfaces check` can return a non-zero exit when an enabled external surface is not reachable. That is a real readiness finding, not a test harness failure.
