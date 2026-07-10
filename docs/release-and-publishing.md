# Release and Publishing

`goodvibes-tui` has two release distributions:

- GitHub Releases with compiled platform binaries
- an npm package that installs the matching platform binaries during `postinstall`

It also mirrors the npm package to GitHub Packages:

- npmjs: `@pellux/goodvibes-tui`
- GitHub Packages: `@mgd34msu/goodvibes-tui`

The binary release is the primary distribution channel.

## Local Release Checks

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

## GitHub CD

The repo includes:

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

Release workflow behavior:

- tag pushes matching `v*` create compiled binary artifacts
- the release workflow re-runs the same core validation gates used for normal CI before building release assets
- npm publish targets `@pellux/goodvibes-tui`
- GitHub Packages publish targets `@mgd34msu/goodvibes-tui`
- the GitHub Release is created from `docs/releases/<version>.md` when present, otherwise it falls back to the matching `CHANGELOG.md` section
- the GitHub Release is created before the registry publish jobs so the package install script can fetch version-matched release assets immediately
- npm publishing runs when repository variable `PUBLISH_NPM=true` is set; the GitHub Release is still created for release tags so compiled assets are available before registry install smoke runs

## npm Distribution

The npm package is intended to be directly installable:

- `bun add -g @pellux/goodvibes-tui`
- `npm install -g @pellux/goodvibes-tui`
- `pnpm add -g @pellux/goodvibes-tui`

Install behavior:

- Bun is the recommended global installer because GoodVibes is a Bun program and the package is hosted on the npm registry.
- Bun global installs require trusting only the app package's own postinstall after the first install:

  ```sh
  bun pm trust -g @pellux/goodvibes-tui
  ```

  No dependency needs trusting: the binaries arrive through the platform-specific `@pellux/goodvibes-tui-<os>-<arch>` package (registry integrity, no lifecycle script), and the tree-sitter grammar packages contribute only their prebuilt `.wasm` files.

- `bun pm -g untrusted` should report `Found 0 untrusted dependencies with scripts`.
- the main package declares four `@pellux/goodvibes-tui-<os>-<arch>` payload packages as `optionalDependencies` with `os`/`cpu` fields (the esbuild pattern), so the package manager installs exactly the one that matches the host, verified against the registry integrity hash. This is why plain `npm`/`pnpm` installs work, not just Bun.
- `postinstall` prefers the platform package's binaries (a plain copy into `vendor/`, no download) and falls back to the version-matched GitHub Release download (checksum-verified against `SHA256SUMS.txt`) only when no platform package is present. The `bin/goodvibes` and `bin/goodvibes-daemon` launchers also resolve the platform package directly, so the binaries run even if the postinstall was skipped.
- npm and pnpm installs still require `bun` to be on `PATH` for the from-source fallback; the preinstall check fails clearly if it is missing.
- on Windows, native execution is not supported; users should use WSL so the Linux binary path applies
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

What `publish:check` verifies:

- package metadata is present
- the published tarball exposes the `goodvibes` bin
- the publish bin is executable
- the tarball does not accidentally include CI/workflow or test-only paths
- the tarball includes the required runtime and bootstrap files
- the tarball does not accidentally include vendored release binaries
- the tarball stays under the package-size guardrail for registry publishing

If npm publishing is enabled in GitHub Actions, the workflow expects:

- repository variable `PUBLISH_NPM=true`
- repository secret `NPM_TOKEN`
- built-in `GITHUB_TOKEN` package permissions for the GitHub Packages mirror

The release workflow publishes these release assets before registry publishing:

- `goodvibes-linux-x64`
- `goodvibes-linux-arm64`
- `goodvibes-macos-x64`
- `goodvibes-macos-arm64`
- `goodvibes-daemon-linux-x64`
- `goodvibes-daemon-linux-arm64`
- `goodvibes-daemon-macos-x64`
- `goodvibes-daemon-macos-arm64`
- `SHA256SUMS.txt`

For normal users who just want the executable, GitHub Releases remain the simplest path.
