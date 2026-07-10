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
