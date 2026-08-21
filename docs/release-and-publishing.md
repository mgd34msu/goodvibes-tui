# Release and publishing

`goodvibes-tui` has two release distributions:

- GitHub Releases with compiled platform binaries
- an npm package that installs the matching platform binaries during `postinstall`

It also mirrors the npm package to GitHub Packages:

- npmjs: `@pellux/goodvibes-tui`
- GitHub Packages: `@mgd34msu/goodvibes-tui`

The binary release is the primary distribution channel.

## Breaking changes

A breaking change gets a bold-prefixed entry under `### Changes` in the
`[Unreleased]` section of `CHANGELOG.md`, stating in plain language what
refuses to work, why, what the user sees, and the remedy. The GitHub Release
body is generated from that section when no `docs/releases/<version>.md`
exists (see GitHub CD below), so a breaking-change entry written there is also
what a reader sees on the release page.

- **1.28.0 daemon build floor.** This client refuses to attach to a daemon
  older than `1.28.0`, the release where the daemon became its own product,
  and reports it as an unadopted, incompatible service rather than adopting
  it. The floor is declared as `TUI_DAEMON_BUILD_FLOOR` in
  `src/runtime/client/build-floors.ts`; see the `[2.0.0]` entry in
  `CHANGELOG.md` for the full account of what a user sees and the remedy.
  It shipped as a bold-prefixed `### Changes` entry under `[Unreleased]`
  before that release cut it into its own version section, which is the
  path a new breaking-change entry follows today.

## Local release checks

Before cutting a release tag, run:

```bash
bun x tsc --noEmit --pretty false
bun run test
bun run test:coverage
bun run architecture:check
bun run perf:check
bun run eval:gate
bun run build
bun run foundation:artifacts
bun run publish:check
git diff --check
```

If you are cutting a version, the repo-level release helper is:

```bash
bun run release
```

Or preview it without writing:

```bash
bun run release:dry
```

`bun run release` bumps the version, prepends the CHANGELOG section, commits,
and creates an annotated tag locally; it does not push. Pushing the commit
and tag is what starts the release, because `release.yml` triggers on tag
pushes matching `v*`.

A version bump can also reach `main` without ever being tagged by hand. In
that case CI's `auto-release` job in `.github/workflows/ci.yml` (a zero-touch
release step that runs only after every other CI gate on that push is green)
tags `package.json`'s current version and dispatches `release.yml` in release
mode itself, so the release still ships without anyone pushing a tag.

## GitHub CD

The repo includes:

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

`release.yml` is a by-reference release. Instead of re-running the CI gates,
its `release-verify` job checks that the tagged commit's own `ci.yml` push
run already finished green, per job, and only then lets the binary matrix
build. `verify-tag-version` runs first and fails the whole run if the pushed
git tag does not equal `v` followed by `package.json`'s version.

Release workflow behavior:

- tag pushes matching `v*` (or a `workflow_dispatch` with `mode: release` at
  a tag ref) build the 4-target binary matrix (`linux-x64`, `linux-arm64`,
  `darwin-x64`, `darwin-arm64`); a plain `workflow_dispatch` with the default
  `mode: dry-run` builds the same matrix for preview without publishing
- a native `darwin-arm64` banner smoke runs on `macos-14`, and a separate
  job installs the packed npm tarball into a clean project and asserts the
  `goodvibes` and `goodvibes-daemon` bin shims both work
- npm publish targets `@pellux/goodvibes-tui`
- GitHub Packages publish targets `@mgd34msu/goodvibes-tui`
- the GitHub Release is created from `docs/releases/<version>.md` when present, otherwise it falls back to the matching `CHANGELOG.md` section
- the GitHub Release is created before the registry publish jobs so the package install script can fetch version-matched release assets immediately
- npm publishing runs when repository variable `PUBLISH_NPM=true` is set; the GitHub Release is still created for release tags even when that variable is unset, so compiled assets stay available to anyone downloading them directly

## npm distribution

The npm package is intended to be directly installable:

- `bun add -g @pellux/goodvibes-tui`
- `npm install -g @pellux/goodvibes-tui`
- `pnpm add -g @pellux/goodvibes-tui`

Install behavior:

- Bun is the recommended global installer because GoodVibes is a Bun program and the package is hosted on the npm registry.
- Bun global installs require trusting the app package and the daemon package it depends on, so both postinstalls can place their binaries:

  ```sh
  bun pm trust -g @pellux/goodvibes-tui goodvibes-daemon
  ```

  No other dependency needs trusting. The TUI binary arrives through the platform-specific `@pellux/goodvibes-tui-<os>-<arch>` package (registry integrity, no lifecycle script), and the tree-sitter grammar packages contribute only their prebuilt `.wasm` files. `@pellux/goodvibes-daemon` is a regular dependency, so installing this package always brings the daemon along, and its own postinstall places the `goodvibes-daemon` binary the same way this package's postinstall places `goodvibes`.

- `bun pm -g untrusted` should report `Found 0 untrusted dependencies with scripts`.
- the main package declares four `@pellux/goodvibes-tui-<os>-<arch>` payload packages as `optionalDependencies` with `os`/`cpu` fields (the esbuild pattern), so the package manager installs exactly the one that matches the host, verified against the registry integrity hash. This is why plain `npm`/`pnpm` installs work, not just Bun.
- `postinstall` prefers the platform package's binary (a plain copy into `vendor/`, no download) and falls back to the version-matched GitHub Release download (checksum-verified against `SHA256SUMS.txt`) only when no platform package is present. The `bin/goodvibes` launcher also resolves the platform package directly, so the binary runs even if the postinstall was skipped. This package ships one bin entry, `goodvibes`; the `goodvibes-daemon` binary and its launcher belong to the separate `@pellux/goodvibes-daemon` package.
- npm and pnpm installs still require `bun` to be on `PATH` for the from-source fallback; the preinstall check fails clearly if it is missing.
- on Windows, use WSL2 (the Linux binary path applies unchanged); native Windows is beta and non-gating. See [windows.md](windows.md)
- if Bun is available and no prebuilt binary is present, the launchers can still fall back to Bun + source

Platform packages are assembled and published by the Release workflow after the per-target build job:

```bash
bun run scripts/assemble-platform-packages.ts --require-all   # populate bin/ from dist/
bun run scripts/publish-platform-packages.ts                  # publish each to npm
```

The `publish-platform-packages` job runs before `publish-npm`, so the payload packages exist in the registry before the main package that references them is published.

Local npm packaging checks:

```bash
bun run publish:dry-run
bun run publish:check
```

`publish:check` runs four gates, in order:

- The SDK-pin gate confirms `@pellux/goodvibes-sdk` is pinned to an exact
  version in `package.json`, that no local SDK overlay is active, that the
  installed copy matches the pin, and that `bun.lock` resolves that same
  pin, then sweeps source imports for anything that reaches into the SDK by
  a path other than its published npm specifier.
- The package-metadata check confirms `name`, `version`, `description`,
  `license`, `homepage`, `repository.url`, and the `goodvibes` bin entry are
  all present in `package.json`.
- The tarball-policy gate packs the publish staging directory and checks
  it. The `goodvibes` bin shim must exist, be executable, and start with
  the right shebang; the tarball must exclude CI/workflow and test-only
  paths (`.github/`, `src/test/`, `src/.test/`, `.goodvibes/memory/`,
  `vendor/`); it must include every required runtime and bootstrap file
  (`README.md`, `CHANGELOG.md`, `package.json`, `src/main.ts`,
  `bin/goodvibes`, `scripts/check-bun.sh`, `scripts/postinstall.js`,
  `.goodvibes/GOODVIBES.md`); and it must stay under the 50 MB
  package-size guardrail.
- Unless `GOODVIBES_SKIP_NPM_AUTH_CHECK=1` is set, a registry-auth probe
  (`npm whoami`) confirms the current npm token can actually publish before
  any binaries or the GitHub Release are produced.

If npm publishing is enabled in GitHub Actions, the workflow expects:

- repository variable `PUBLISH_NPM=true`
- repository secret `NPM_TOKEN`
- built-in `GITHUB_TOKEN` package permissions for the GitHub Packages mirror

The release workflow publishes these release assets before registry publishing:

| Asset | What it is |
| --- | --- |
| `goodvibes-linux-x64`, `goodvibes-linux-arm64`, `goodvibes-macos-x64`, `goodvibes-macos-arm64` | The compiled TUI binary, one per supported target |
| `sqlite-vec-linux-x64.so`, `sqlite-vec-linux-arm64.so`, `sqlite-vec-darwin-x64.dylib`, `sqlite-vec-darwin-arm64.dylib` | The sqlite-vec native addon powering semantic memory search, one per target |
| `SHA256SUMS.txt` | The checksum manifest every downloaded file is verified against |
| `install.sh` | The suite installer, described below |

`install.sh` is the suite installer (`scripts/install.sh` in this
repository, staged as a release asset by the same `release.yml` run). It is
what `curl -fsSL https://goodvibes.sh/install.sh | sh` fetches, and it
installs all four GoodVibes products from their own repositories in one
command, the daemon, this terminal client, the agent with its browser
driver, and the web UI bundle that the daemon serves. Every file it places is
verified against its own repository's `SHA256SUMS.txt` first, so riding the
same manifest as the binaries above means the installer people run is
checksummed by the release that produced it.

The `goodvibes-daemon-*` binaries are a separate release, built and published by the `goodvibes-daemon` repository's own release workflow.

For normal users who just want the executable, GitHub Releases remain the simplest path.
