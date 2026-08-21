# /share: session export

Export the current session to a local file and optionally share it.

## Syntax

```
/share <html|json|md> [path] [--redact] [--upload] [--copy] [--open]
```

## Formats

| Format | Description |
|--------|-------------|
| `html` | Self-contained HTML with syntax highlighting, best for sharing |
| `json` | Structured JSON (machine-readable), includes token/cost summary |
| `md`   | Markdown, portable plain-text format |

## Options

| Flag       | Description |
|------------|-------------|
| `--redact` | Redact API keys, tokens, and personal home-directory paths from the output |
| `--upload` | Upload the export as a secret GitHub Gist and print the share link |
| `--copy`   | Copy the output file path to the clipboard (OSC 52; terminal must support it) |
| `--open`   | Open an HTML export in the default browser (`xdg-open` / `open` / `start`) |

Flags can be combined:

```
/share html --redact --upload --copy
```

## Cost summary

Every export includes a token-usage and cost summary derived from the live session.
Cost is computed using the same per-model pricing table as the Cost Tracker panel
(USD per 1 M tokens). Unknown models default to $0. The cost field is always present
in JSON exports (`metadata.costUsd`) and in HTML exports (visible in the usage section).
For Markdown, a `## Cost` section is appended when cost > $0.

## Redaction guarantees

With `--redact` the exporter applies server-side redaction patterns to every message
before serialising:

- API key prefixes: `sk-`, `key-`, `ghp_`, `gho_`, `github_pat_`, `glpat-`, `xoxb-`, `xoxp-`, AWS `AKIA*`
- Bearer and raw tokens in Authorization headers
- Filesystem paths under `/home/`, `/Users/`, and `C:\\Users\\`

Redacted tokens are replaced with typed placeholders (`[REDACTED_API_KEY]`,
`[REDACTED_GITHUB_TOKEN]`, etc.). Tool-call arguments and reasoning content are
also redacted. The original conversation is never modified.

## Upload privacy

Gist upload creates a **secret** (unlisted) Gist. It is not indexed by GitHub search
and is not shown on your profile. However, **anyone with the URL can view it**. Do not
upload sessions containing secrets without first using `--redact`.

## Token resolution for --upload

The uploader looks for a GitHub PAT in this order:

1. Service registry `github` entry (configured via `/services` or `.goodvibes/tui/services.json`
   with `tokenKey: GITHUB_TOKEN` and `authType: bearer`).
2. `GITHUB_TOKEN` environment variable.

If neither is available the upload is skipped and guidance is printed. The token requires
`gist` scope only.

## Default path

When no path is given, exports go to:

```
~/goodvibes-exports/session-<YYYY-MM-DDTHH-MM-SS>.<ext>
```

The directory is created automatically.

## Examples

```
/share html                          # export to default path
/share html /tmp/session.html        # export to explicit path
/share json --redact                 # JSON with sensitive data removed
/share html --upload                 # export + Gist link
/share html --upload --copy --open   # export + link + clipboard + open browser
/share md --redact --upload          # redacted Markdown Gist
```

## Related

- `/plugin`: manage plugins
- `/services`: configure external service credentials (including GitHub PAT for upload)
- [Deployment and services](deployment-and-services.md)
