# GitHub Action: run-goodvibes

A composite action (`action.yml` at the repo root) that installs a pinned,
checksum-verified GoodVibes release and runs a non-interactive command or prompt
against a workspace in CI. It reuses the committed `scripts/install.sh`
download-verify-swap logic, so every binary is verified against
`SHA256SUMS.txt` (a missing manifest entry is a hard failure).

## Usage

Install and print the version:

```yaml
- uses: mgd34msu/goodvibes-tui@v1
  with:
    version: v1.13.1   # or "latest"
```

Run a health check:

```yaml
- uses: mgd34msu/goodvibes-tui@v1
  with:
    version: latest
    command: doctor
    args: --json
```

Run a non-interactive prompt (needs a provider credential in the job env):

```yaml
- uses: mgd34msu/goodvibes-tui@v1
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
| `version` | `latest` | Release tag (`v1.13.1`) or `latest`. |
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
  self-test job (`.github/workflows/ci.yml` → `action-self-test`) therefore
  exercises install + `--version` + `doctor`; a real `run` turn is a consumer
  step that supplies a credential.
- Publishing this action to the GitHub Marketplace is the repository owner's
  step and is out of scope here.
