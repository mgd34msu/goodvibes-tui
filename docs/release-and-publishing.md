# Release and Publishing

`goodvibes-tui` has two release distributions:

- GitHub Releases with compiled platform binaries
- an npm package that downloads the matching prebuilt binary during install

The binary release is the primary distribution channel.

## Local Release Checks

Before cutting a release tag, run:

```bash
bun x tsc --noEmit --pretty false
bun run test
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
- a GitHub Release is created from the matching `CHANGELOG.md` section
- npm publishing is optional and stays disabled unless explicitly enabled in repo configuration

## npm Distribution

The npm package is intended to be directly installable:

- `npm install -g goodvibes-tui`
- `pnpm add -g goodvibes-tui`
- `bun add -g goodvibes-tui`

Install behavior:

- on Linux and macOS, `postinstall` downloads the matching prebuilt binary from the GitHub release for the package version
- on Windows, native execution is not supported; users should use WSL so the Linux binary path applies
- if Bun is already available and no vendored binary is present, the launcher can still fall back to Bun + source

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
- the tarball does not accidentally ship a stale vendored binary

If npm publishing is enabled in GitHub Actions, the workflow expects:

- repository variable `PUBLISH_NPM=true`
- repository secret `NPM_TOKEN`

The release workflow also needs the release assets to exist before npm publishing:

- `goodvibes-linux-x64`
- `goodvibes-linux-arm64`
- `goodvibes-macos-x64`
- `goodvibes-macos-arm64`
- `SHA256SUMS.txt`

For normal users who just want the executable, GitHub Releases remain the simplest path.
