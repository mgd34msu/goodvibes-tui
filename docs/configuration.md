# Configuration reference

Settings are layered, not stored in a single working-directory file. Four layers apply in order, and each later layer wins over the ones before it:

| Layer | Source |
| --- | --- |
| 1. Defaults | Built into the platform config schema |
| 2. Global TUI settings | `~/.goodvibes/tui/settings.json` |
| 3. Project settings | `.goodvibes/tui/settings.json` in the working directory |
| 4. CLI/runtime overrides | Flags at launch and live changes made during the session | The shared file `~/.goodvibes/goodvibes.json` is reserved for future
cross-app state; TUI settings do not live there.

Most settings live under the schema owned by the platform config system and
are editable live from the fullscreen `/config` workspace or `/settings`. See
[Key settings](#key-settings) below for a curated reference table of the most
commonly used ones. This page also documents the additional TUI-owned
namespaces you can add by hand to your settings file (further down). Those are
read directly from the settings file, and a missing or malformed value falls
back to the built-in default rather than erroring.

Settings sit next to several other stores that follow the same global-versus-project split:

| Path | What it holds |
| --- | --- |
| `~/.goodvibes/tui/secrets.enc` and project/ancestor `.goodvibes/tui/secrets.enc` | Secure encrypted secrets |
| `~/.goodvibes/goodvibes.secrets.json` and project/ancestor `.goodvibes/goodvibes.secrets.json` | Plaintext compatibility secrets |
| `.goodvibes/tui/services.json` | The service registry, backing auth/account surfaces in the TUI and daemon |
| `~/.goodvibes/tui/providers/*.json` | Custom provider JSON |
| `~/.goodvibes/tui/keybindings.json` | Keybinding overrides |
| `.goodvibes/tui/repl-history.json` | REPL history |
| `.goodvibes/tui/automation-jobs.json` | Scheduled and automation jobs |

## Key settings

These settings live in the platform-owned config schema, not in the
TUI-extension namespaces documented further down this page. Edit them from the
fullscreen `/config` workspace or `/settings`; the table below is listed here
for reference.

| Key | Default | Description |
|-----|---------|-------------|
| `display.stream` | `true` | Stream responses token by token |
| `display.lineNumbers` | `off` | Line-number mode: `off`, `code`, or `all` |
| `display.collapseThreshold` | `30` | Lines before a block auto-collapses |
| `display.theme` | `vaporwave` | Color palette name |
| `display.themeMode` | `auto` | Light/dark appearance: `auto` probes the terminal background once at startup, `dark`/`light` force a fixed appearance. Independent of `display.theme` |
| `display.showThinking` | `false` | Show model thinking traces |
| `display.showTokenSpeed` | `false` | Show tokens/sec in status bar |
| `provider.model` | `openrouter:openrouter/free` | Active model ID, provider-qualified as `<provider>:<model>` |
| `provider.reasoningEffort` | `medium` | Reasoning depth for supported models |
| `provider.systemPromptFile` | `` | Path to a custom system prompt file |
| `behavior.autoApprove` | `false` | Auto-approve all tool permission prompts |
| `behavior.autoCompactThreshold` | `80` | Context % before auto-compact triggers |
| `behavior.saveHistory` | `true` | Persist conversation history |
| `behavior.returnContextMode` | `off` | Session return-context mode: `off`, `local`, `assisted` |
| `behavior.notifyOnComplete` | `true` | Emit terminal bell and desktop notification when a long turn completes |
| `behavior.guidanceMode` | `minimal` | Operational guidance mode: `off`, `minimal`, `guided` |
| `storage.secretPolicy` | `preferred_secure` | Secret storage policy: prefer secure backing store, fall back when allowed |
| `permissions.mode` | `prompt` | Permission mode: `prompt`, `accept-edits`, `plan`, `allow-all`, `custom` |
| `permissions.backgroundAgents` | `inherit` | How background/subagent tool calls consult the permission layer: `inherit` or `allow-all` |
| `ui.systemMessages` | `panel` | Route general system messages to `panel`, `conversation`, or `both` |
| `ui.operationalMessages` | `panel` | Route operational runtime notices to `panel`, `conversation`, or `both` |
| `ui.wrfcMessages` | `both` | Route WRFC/orchestration updates to `panel`, `conversation`, or `both` |
| `service.enabled` | `true` | Enable service-install and daemon-management verbs, including the standalone daemon's self-promotion to a supervised service at its first idle moment |
| `service.autostart` | `false` | Install/enable or disable/remove the OS autostart service |
| `service.restartOnFailure` | `true` | Restart managed daemon services after failure |
| `controlPlane.hostMode` | `local` | Control-plane bind mode: `local`, `network`, or `custom` |
| `controlPlane.port` | `3421` | Control-plane daemon/API port |
| `httpListener.port` | `3422` | Webhook/event listener port |
| `web.enabled` | `true` | Enable the browser operator surface (bound to loopback until `web.hostMode` is widened) |
| `web.hostMode` | `local` | Web surface bind mode: `local`, `network`, or `custom` |
| `web.port` | `3423` | Web/browser surface port |
| `orchestration.recursionEnabled` | `false` | Allow recursive agent orchestration under bounded policy controls |
| `orchestration.maxDepth` | `0` | Maximum recursive orchestration depth: `0` disables, higher values (up to `5`) allow deeper bounded recursion |
| `daemon.enabled` | `true` | Whether this client adopts a running daemon at all. It does not start one itself; see [deployment-and-services.md](deployment-and-services.md) |
| `danger.httpListener` | `false` | Enable HTTP webhook listener |
| `tools.autoHeal` | `false` | Auto-fix syntax errors on write/edit |
| `tools.hooksFile` | `hooks.json` | Hook configuration file name |
| `cache.enabled` | `true` | Enable provider-aware prompt caching |
| `cache.stableTtl` | `1h` | TTL for stable content (system prompt + tools) |
| `cache.monitorHitRate` | `true` | Track and warn on low cache hit rates |
| `helper.enabled` | `false` | Route grunt work to a cheaper helper model |
| `helper.globalProvider` | `` | Helper model provider (e.g., `ollama`) |
| `helper.globalModel` | `` | Helper model ID (e.g., `llama3.2:3b`) |

## Permission modes

`permissions.mode` takes five values. Two of them display under a different label in the UI than the value stored in config:

| Value | Shown as | Behavior |
| --- | --- | --- |
| `prompt` (default) | `normal` | Auto-approves reads and asks before write, edit, exec, fetch, agent, workflow, and MCP calls |
| `accept-edits` | `accept-edits` | Auto-approves file write and edit tools; exec and the other risky classes still ask |
| `plan` | `plan` | Allows read-only tools and refuses every mutating or exec tool with a structured plan-mode denial |
| `allow-all` | `auto` | Never prompts and allows everything |
| `custom` | `custom` | Applies per-tool overrides using `permissions.tools.<name>` keys, each set to `allow`, `prompt`, or `deny` |

`Shift+Tab` cycles the four session postures in this order, `normal` → `accept-edits`
→ `plan` → `auto` → `normal`. `/plan` toggles plan mode directly. `custom`
is a per-rule policy rather than a session posture, so it is left out of the
cycle; cycling from `custom` starts again at `normal`.

`permissions.backgroundAgents` decides how background and subagent tool calls
consult that mode. `inherit` (the default) runs them through the same session
mode as the foreground turn loop, brokering asks through the same
blocked-on-user machinery with subagent attribution; `allow-all` exempts
background agents entirely regardless of the session mode.

Changing `service.autostart` or `service.enabled` from `/config` reconciles
the OS service where supported. On Linux this installs/enables, disables, or
rewrites the user `systemd` service so the daemon state matches the setting
instead of only changing JSON.

## Policy, permissions, and trust

The permission system is more than a prompt toggle. Policy evaluation is layered, matching prefix rules, arg-shape rules, path scope, network scope, and mode constraints, and every decision lands in a log for audit and review. Policy changes travel as bundles: a preflight review runs before a bundle applies, candidate bundles can be simulated with a divergence report before promotion, bundles are signed and their signatures verified, and the policy runtime tracks bundle lifecycle with promote, rollback, and diff support. The system can also generate rule suggestions from your actual approval decisions.

An adjacent trust layer grades plugins into trust tiers, can quarantine a plugin or degrade its posture, subjects marketplace entries and MCP servers to trust review, and exposes security and policy control-room surfaces for review and remediation. The result is that approvals, policy rollout, trust posture, and plugin degradation are inspectable product behavior.

## `checkpoints.*`: workspace checkpoint root guard

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

> **Compatibility note.** These root-guard keys take effect only with a platform
> build whose checkpoint manager exposes them. On an older pinned build the
> keys are read and validated but ignored by the manager until it is upgraded.

## `statusline.*`: scriptable status line

Point `statusline.command` at any command and its output renders as a dim line
in the status area (just above the prompt). The command runs as a POSIX shell
command (`/bin/sh -c <command>`) in your working directory at each turn
boundary, when a turn completes, errors, or is cancelled, and once at
startup.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `statusline.command` | string | *(unset)* | Shell command to run. Its first stdout line is shown. Unset or empty disables the feature. |
| `statusline.timeoutMs` | number | `2000` | Per-run timeout in milliseconds. Clamped to `[100, 15000]`. A command that exceeds it is killed and the line is cleared. |

Behavior notes:

- Only the **first line** of stdout is used. ANSI colors and control characters
  are stripped; the result is trimmed and capped at 512 characters.
- Each run is bounded by the timeout, and runs never overlap. Refreshes that
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

## `behavior.*`: TUI-local notification keys

These keys are read directly by the TUI's notifier modules rather than by
the platform schema, so they do not appear in the Key Settings table above.
They are still editable from `/config behavior`, which injects them into the
behavior group alongside the schema-owned keys.

`behavior.notifyAfterSeconds` gates the long-running-turn notification, and
four separate boolean keys gate point-in-time alert classes covering a budget
breach, an agent failure, a WRFC chain failure, and a tool call blocked on
your approval. `behavior.notifyOnlyWhenUnfocused` is the master gate over all
of them.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `behavior.notifyAfterSeconds` | number | `60` | Seconds a turn must run before a push notification fires; `0` turns it off. Delivers to the desktop (`notify-send` / `osascript`) and to any configured ntfy/webhook URLs. Notification text is metadata only: task kind, elapsed time, ok/fail, session id. Never conversation content. |
| `behavior.notifyOnBudgetBreach` | boolean | `true` | Alert when session cost crosses the configured budget (set via the Cost panel's `b` key). |
| `behavior.notifyOnAgentFailure` | boolean | `true` | Alert when a delegated or background agent fails. |
| `behavior.notifyOnChainFailure` | boolean | `true` | Alert when a WRFC review chain fails. |
| `behavior.notifyOnApprovalPending` | boolean | `true` | Alert the moment a tool call becomes a real, user-blocking permission prompt. Message text is tool name and permission category only, never the call's arguments. |
| `behavior.notifyOnlyWhenUnfocused` | boolean | `true` | Master gate over the four alert-class keys above and over `notifyAfterSeconds`: alerts fire only when the terminal is unfocused, or when focus state was never observed. Set `false` to fire regardless of focus. |

## `session.*`: session behavior

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `session.autoTitle` | boolean | `false` | Auto-title an untitled session using the configured tool/helper (weak/fast) model after the first turn completes. Off by default because it spends a small model call. Only ever sets a system title (a title you set yourself is never overwritten), and it runs at most once per session. Requires the tool LLM to be configured (`/config` → tools). |

```json
{
  "session": { "autoTitle": true }
}
```

## `update.*`: launch-time self-update

Binary installs (the `curl … | sh` installer) check for a newer release at
every TUI launch and, when one exists, install it through the same
checksum-verified download/verify/swap path as `/update apply`, then restart
onto the new binary with a receipt line naming both versions. When the check
cannot complete quickly (offline, slow network) the current version starts
with a single line reading `update check skipped: offline`. Every swap keeps the outgoing
file at `<path>.previous`; `/update rollback` restores it in one command.
Package-manager and from-source runs never self-update at launch.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `update.autoUpdateAtLaunch` | boolean | `true` | Check for and install a newer release at TUI launch. Set `false` to only update when you run `/update apply` yourself. |
| `update.launchCheckTimeoutMs` | number | `2500` | Budget for the launch-time version check. Clamped to `[250, 30000]`. A check that outlives it is skipped and the current version starts. |
| `update.applyTimeoutMs` | number | `45000` | Budget for the launch-time download, verify, and swap. Clamped to `[5000, 300000]`. An apply that outlives it is deferred to the next launch. |

```json
{
  "update": { "autoUpdateAtLaunch": false }
}
```
