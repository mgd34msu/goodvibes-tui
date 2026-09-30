# Local verification

Two read-only tools check a real GoodVibes home and a real build on your machine, which the test suite cannot see.

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

Run the compiled CLI, authenticated daemon probes, and home audit together:

```bash
bun run verification:live -- --home ~/.goodvibes --out /tmp/goodvibes-live-verification
```

The live verifier checks:

- `~/.goodvibes/tui/settings.json` has no stale TUI keys;
- `dist/goodvibes` exists and can run `version`, `status --output json`, `providers`, `control-plane status`, `listener test`, `surfaces check`, `service check`, and `doctor`;
- the daemon bearer token can authenticate `/status`, `/api/health`, and `/v1/models`;
- warnings are preserved for real posture problems such as an enabled-but-unreachable web surface or an enabled service that is not installed.

By default, warnings do not fail the command because they are useful runtime findings. Use strict mode when every warning should fail automation:

```bash
bun run verification:live -- --strict --out /tmp/goodvibes-live-verification-strict
```

## Before a release

CI runs the test suite, the typecheck, the build and the binary smokes on every
push, and the release gates before a release (see
[testing and validation](../testing-and-validation.md)). What CI cannot check
is your own machine's state, so before a release or a large config migration:

```bash
bun run build
bun run verification:live -- --home ~/.goodvibes --out /tmp/goodvibes-live-verification
```

`surfaces check` can return a non-zero exit when an enabled external surface is not reachable. That is a real readiness finding, not a test harness failure.
