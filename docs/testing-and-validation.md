# Testing and validation

## What runs where

| When | What | Command |
|------|------|---------|
| While you work | the test files your change affects, the files you touched, and a typecheck | `bun run test:changed`, `bun test <file>`, `bun run typecheck:test` |
| Every push to `main` and every PR (`ci.yml`) | typecheck, import-cycle and layer check, workflow structure, the full test run, the linux-x64 build and banner smoke, the end-to-end smoke (startup, first turn) on that build, the SDK-pin and tarball checks | CI |
| Before a push that releases, nightly, on demand (`release-gates.yml`) | the perf budgets and the release end-to-end set: daemon adoption, a WRFC chain through its fix phase, the turn-end notification, resize | CI |
| Version bump | version stamps, generated docs and contract artifacts, the lockfile, workflow pins, the CHANGELOG section | `bun run release:prepare` |
| Release (`release.yml`) | verifies the tagged commit's push CI was green job by job, then builds, smokes and publishes | CI |

Local work never needs the whole suite. CI runs it on every push, once.

## Local commands

```bash
bun run test:changed                       # test files affected by changes since origin/main
bun test src/test/input/context-cap.test.ts   # one file
bun run test context-cap                   # the runner, filtered by a path fragment
bun run typecheck:test                     # src/, scripts/, examples/ and the tests
bun run architecture:check                 # import cycles and layer boundaries

bun run build:linux-x64                    # the binary the end-to-end tests drive
bun run test:e2e:fast                      # startup and a first turn
bun run test:e2e                           # all six end-to-end scenarios
bun run perf:check                         # the perf budgets
```

`test:changed` is `bun run scripts/run-tests.ts --changed=origin/main`. The
runner keeps its per-file processes and temp-directory containment and hands
each file Bun's own `--changed` selection: a file whose import graph touches
nothing changed since `origin/main` (committed or not) runs no tests and is
counted as "not affected by the change". Pass another base with
`bun run scripts/run-tests.ts --changed=<ref>`, or a bare `--changed` for
Bun's default base. `--changed` and a positional path filter combine.

`bun run test` runs every file under `src/` except `src/test/e2e`. It is what
the CI `test` job runs; you rarely need it locally.

## Test layers

- **Unit.** One TUI module called directly with real inputs: a renderer, a
  command handler, an input route, a view. Fakes stand in only for what is
  outside the unit: a provider, a clock, the network, a host tool.
- **Composed runtime.** The TUI's own composition (`src/runtime/services.ts`)
  over a temp home (`src/test/helpers/runtime-services.ts`), for what that
  composition wires: which handlers exist, which stores are real, what a
  command reaches.
- **Golden frames.** `src/test/renderer/golden-frames*.test.ts` render a
  surface at fixed widths and compare it byte for byte with the committed frame
  under `src/test/renderer/golden-frames*/`. A deliberate visual change updates
  the frame in the same commit.
- **End to end.** `src/test/e2e/` drives the COMPILED binary in a real terminal
  (a tmux server the harness owns) with an isolated `GOODVIBES_HOME`, a scratch
  git workspace, the daemon port pinned to an unused one, and a scripted
  OpenAI-compatible model served from the test process
  (`src/test/e2e/harness.ts`). It reads the rendered screen, the raw bytes the
  binary wrote, the workspace's files and git history, and, for adoption, the
  daemon's own session list.

| Scenario | File | Runs |
|----------|------|------|
| a fresh home reaches the input area with no error | `startup.e2e.test.ts` | every push |
| a typed prompt reaches the model and its reply is drawn | `first-turn.e2e.test.ts` | every push |
| a daemon already on the configured port is adopted (the SDK's `bootDaemon`) | `daemon-adoption.e2e.test.ts` | release gates |
| a WRFC chain's failing review starts a fix, the re-review passes, the fix lands as a commit | `wrfc-chain.e2e.test.ts` | release gates |
| the OSC 9 notification for a finished turn names the turn | `turn-notification.e2e.test.ts` | release gates |
| 80, 120 and 200 columns each redraw at the new width and keep the transcript | `resize.e2e.test.ts` | release gates |

Each scenario was checked against a broken build: breaking the behavior in
source, rebuilding and running the test made it fail, and restoring the file
made it pass again.

Nothing in the suite calls a real external service or a host tool whose state
it cannot control, and nothing touches the real home directory, the host's
daemon or its service units.

A test earns its place by failing when behavior breaks. Tests that read
source, docs or workflow files as text, pin wording or constants nothing
parses, assert a mock's own return value, render twice and compare, or only
check that something is defined do not; neither do tests of SDK code, which
belong in the SDK. They were removed in the 2026-09 overhaul and should not
come back. Before adding a test, break the behavior it covers and watch it
fail.

## Per-push CI (`ci.yml`)

| Job | Command | Purpose |
|-----|---------|---------|
| `typecheck` | `bun run typecheck:test`, `bun run architecture:check`, `bun run workflows:check` | tsc over everything; no runtime import cycles and no forbidden layer edges; every workflow parses and no job hides behind `continue-on-error` |
| `test` | `bun run test` | The suite, one process per file |
| `build` | `bun run build:linux-x64`, `bun run smoke:tui` | The binary and the toolchain banner smoke; uploaded for `e2e-smoke` and the release gates |
| `e2e-smoke` | `bun run test:e2e:fast` | Startup and a first turn on the built binary |
| `package-gate` | `bun run publish:check`, `bun run package:install-check` | SDK pin, installed version and lockfile agree; the npm tarball holds the files an install needs; the bin shims resolve |
| `release-intent` | `git ls-remote` | Pushes to `main` only: does this version still need a tag? |
| `release-gates` | `release-gates.yml` | Only when `release-intent` says the push releases |
| `auto-release` | tag + dispatch | Only when the push releases, after every job above; tags the version and dispatches `release.yml` |

## Release gates (`release-gates.yml`)

| Job | Command | Purpose |
|-----|---------|---------|
| `perf` | `bun run perf:check` | Startup import, compositor frame p95/p99, and the Line[] builders against `scripts/perf-baseline.json` |
| `e2e` | `bun run test:e2e:release` | Daemon adoption, the WRFC fix phase and merge, the turn-end notification, resize |

The perf budgets are the worst value of three measurement runs times two
(`HEADROOM` in `scripts/perf-check.ts`). `bun run perf:baseline` rewrites them
on your machine; dispatching the workflow with `perf-baseline` checked
re-measures them on a GitHub runner and uploads the file to commit.

## Version bump: `bun run release:prepare`

Everything that carries the version or is generated from source is written at
the bump, never checked per push:

```bash
bun run release:prepare --minor         # or --patch, --major, --version X.Y.Z
bun run release:prepare --no-bump       # regenerate at the current version
```

It sets `package.json`'s version, relocks (`bun install`), then in a fresh
process writes the `src/version.ts` fallback, the README badge,
`docs/foundation-artifacts` and `docs/commands-reference.md`
(`scripts/prebuild.ts`), points every SDK reusable-workflow reference in
`.github/workflows` at the commit the pinned SDK version's tag names and every
toolchain spec at the pinned toolchain version, and scaffolds the CHANGELOG
section. It never commits or tags. `npm version` runs it through the `version`
script, and the toolchain `release-cut` (`bun run release`) runs it as its sync
command with `--no-bump --no-changelog`, since release-cut writes those two
itself. `--no-install` and `--no-pins` skip the two steps that need the
network.
