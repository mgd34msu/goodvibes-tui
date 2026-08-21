# GitHub Action: run-goodvibes

A composite action (`action.yml` at the repo root) that installs a pinned,
checksum-verified GoodVibes release and runs a non-interactive command or prompt
against a workspace in CI. It runs the published suite installer, fetched from
`https://goodvibes.sh/install.sh` (a Cloudflare Pages project; its `_redirects`
file owns this path), the same script `curl -fsSL https://goodvibes.sh/install.sh
| sh` runs, so every binary is verified against its own repository's
`SHA256SUMS.txt` (a missing manifest entry is a hard failure). The installer is
hosted there, not attached to any one product's GitHub release, because it
installs across all four product repositories; there is one copy of it, not
one per consumer.

## Usage

Every release is tagged with its exact version (`v2.0.9`, and so on); there is
no moving major-version tag to pin against. Pin the `uses:` line itself to the
exact release tag you want, the same way the `version` input below pins the
binary that tag's release step downloads.

Install and print the version:

```yaml
- uses: mgd34msu/goodvibes-tui@v2.0.9
  with:
    version: v2.0.9   # or "latest"
```

Run a health check:

```yaml
- uses: mgd34msu/goodvibes-tui@v2.0.9
  with:
    version: latest
    command: doctor
    args: --json
```

Run a non-interactive prompt (needs a provider credential in the job env):

```yaml
- uses: mgd34msu/goodvibes-tui@v2.0.9
  with:
    version: latest
    prompt: "summarize the changes in this workspace"
    output: json
    working-directory: .
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Inputs

| input | default | description |
| --- | --- | --- |
| `version` | `latest` | Release tag (`v2.0.9`) or `latest`. |
| `prompt` | `""` | Non-interactive prompt for `goodvibes run`. Needs a provider credential. |
| `command` | `""` | A subcommand to run instead (e.g. `doctor`, `status`). Ignored when `prompt` is set. |
| `args` | `""` | Extra arguments appended after the command. |
| `output` | `text` | Output format for `run`: `text` \| `json` \| `stream-json`. |
| `working-directory` | `.` | Workspace directory to run in. |
| `install-dir` | `$HOME/.goodvibes-bin` | Where to install the binaries (added to `PATH`). |
| `install-agent` | `0` | Also install `goodvibes-agent` (pulls in Bun) when `1`. |

## Outputs

| output | description |
| --- | --- |
| `version` | The `goodvibes --version` string of the installed binary. |

## Notes

- A non-interactive one-shot mode exists (`goodvibes run --non-interactive`),
  but it requires a provider credential (e.g. `OPENAI_API_KEY`). The repo's own
  self-test job (`.github/workflows/action-self-test.yml`) therefore exercises
  install + `--version` + `doctor`; a real `run` turn is a consumer step that
  supplies a credential. That self-test deliberately lives in its own workflow
  file rather than as a job inside `ci.yml`. It installs the previous
  published release to exercise the action wrapper, which says nothing about
  whether the current commit is releasable, and any job inside `ci.yml` is
  release-gating whether or not the release path lists it as a dependency.
- Publishing this action to the GitHub Marketplace is the repository owner's
  step and is out of scope here.
