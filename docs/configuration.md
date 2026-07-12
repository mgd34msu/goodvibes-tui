# Configuration reference — TUI-extension keys

Most settings live under the schema owned by the platform config system and are
editable from `/settings` (or `/config`). This page documents the additional
TUI-owned namespaces you can add by hand to your settings file:

- global settings: `~/.goodvibes/tui/settings.json`
- project settings: `.goodvibes/tui/settings.json`

Project settings win over global settings. These namespaces are read directly
from the settings file; a missing or malformed value falls back to the built-in
default rather than erroring.

## `checkpoints.*` — workspace checkpoint root guard

The workspace checkpoint manager takes whole-workspace snapshots at turn and
agent boundaries so a session can rewind. These keys tune the root guard that
decides where and how much it snapshots. All keys are optional; an omitted key
uses the manager's own default.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `checkpoints.preferGitRoot` | boolean | `true` | Prefer the enclosing git repository's top level over the raw workspace root when the working directory is inside one. Keeps a session started in a subdirectory snapshotting the whole repo. Set `false` to snapshot exactly the working directory. |
| `checkpoints.allowBroadRoot` | boolean | `false` | Opt in to snapshotting a broad root (the filesystem root, your home directory, or `~/.goodvibes`). Such roots are refused by default to avoid an unbounded store. Set `true` only when a broad root is genuinely intended. |
| `checkpoints.allowLargeFirstSnapshot` | boolean | `false` | Opt in to a first snapshot whose full file sweep exceeds `maxFirstSnapshotFiles`. Refused by default with a message stating the count. |
| `checkpoints.maxFirstSnapshotFiles` | number | `50000` | Ceiling for the first-ever snapshot's file sweep. Must be a positive integer. |
| `checkpoints.autoRetention` | boolean | `true` | Run a retention sweep automatically after each snapshot and once at startup. Set `false` to drive retention only via manual garbage collection. |

Example (`.goodvibes/tui/settings.json`):

```json
{
  "checkpoints": {
    "preferGitRoot": true,
    "allowBroadRoot": false,
    "maxFirstSnapshotFiles": 20000
  }
}
```

> Compatibility note: these root-guard keys take effect only with a platform
> build whose checkpoint manager exposes them. On an older pinned build the
> keys are read and validated but ignored by the manager until it is upgraded.

## `statusline.*` — scriptable status line

Point `statusline.command` at any command and its output renders as a dim line
in the status area (just above the prompt). The command runs as a POSIX shell
command (`/bin/sh -c <command>`) in your working directory at each turn
boundary — when a turn completes, errors, or is cancelled — and once at
startup.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `statusline.command` | string | *(unset)* | Shell command to run. Its first stdout line is shown. Unset or empty disables the feature. |
| `statusline.timeoutMs` | number | `2000` | Per-run timeout in milliseconds. Clamped to `[100, 15000]`. A command that exceeds it is killed and the line is cleared. |

Behavior notes:

- Only the **first line** of stdout is used. ANSI colors and control characters
  are stripped; the result is trimmed and capped at 512 characters.
- Each run is bounded by the timeout, and runs never overlap — refreshes that
  arrive while a run is in flight coalesce into a single trailing run, so a slow
  command cannot stall the UI or pile up.
- If the command exits non-zero, times out, or fails to start, the line is
  cleared rather than left showing stale text.

Example (`.goodvibes/tui/settings.json`):

```json
{
  "statusline": {
    "command": "git rev-parse --abbrev-ref HEAD 2>/dev/null | sed 's/^/branch: /'",
    "timeoutMs": 1500
  }
}
```

## `session.*` — session behavior

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `session.autoTitle` | boolean | `false` | Auto-title an untitled session using the configured tool/helper (weak/fast) model after the first turn completes. Off by default because it spends a small model call. Only ever sets a system title — a title you set yourself is never overwritten — and it runs at most once per session. Requires the tool LLM to be configured (`/config` → tools). |

```json
{
  "session": { "autoTitle": true }
}
```

## `update.*` — launch-time self-update

Binary installs (the `curl … | sh` installer) check for a newer release at
every TUI launch and, when one exists, install it through the same
checksum-verified download/verify/swap path as `/update apply`, then restart
onto the new binary with a receipt line naming both versions. When the check
cannot complete quickly (offline, slow network) the current version starts
with one line: `update check skipped: offline`. Every swap keeps the outgoing
file at `<path>.previous`; `/update rollback` restores it in one command.
Package-manager and from-source runs never self-update at launch.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `update.autoUpdateAtLaunch` | boolean | `true` | Check for and install a newer release at TUI launch. Set `false` to only update when you run `/update apply` yourself. |
| `update.launchCheckTimeoutMs` | number | `2500` | Budget for the launch-time version check. Clamped to `[250, 30000]`. A check that outlives it is skipped and the current version starts. |

```json
{
  "update": { "autoUpdateAtLaunch": false }
}
```
