# Configuration Reference

goodvibes-tui uses a layered configuration system. Settings are stored in JSON files and can also be changed at runtime via `/config`.

## Config File Locations

| Priority | Path | Description |
|----------|------|-------------|
| 1 (lowest) | Built-in defaults | Hardcoded in `src/config/schema.ts` |
| 2 | `~/.goodvibes/tui/settings.json` | Global user settings |
| 3 | `.goodvibes/tui/settings.json` | Project-local settings (in cwd) |
| 4 (highest) | CLI overrides / runtime | Applied programmatically at startup |

Project-local settings take precedence over global settings. API keys are **never** stored in config files — use environment variables or the encrypted secrets store.

## Viewing and Editing Settings

Interactive browser:
```
/config
```

Show a specific category:
```
/config display
/config behavior
/config permissions
```

Show or set a specific key:
```
/config display.theme
/config display.theme dracula
```

See what has changed from defaults:
```
/config diff
```

Reset a setting or all settings:
```
/config reset display.theme
/config reset
```

## Display Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `display.stream` | boolean | `true` | Stream LLM tokens as they arrive |
| `display.lineNumbers` | boolean | `false` | Show line numbers in code blocks |
| `display.collapseThreshold` | number | `30` | Line count threshold for collapsing tool output (1–1000) |
| `display.theme` | string | `vaporwave` | Color theme name |
| `display.showThinking` | boolean | `false` | Show reasoning/thinking content above responses |
| `display.showReasoningSummary` | boolean | `false` | Show reasoning summary (Mercury-2) above responses |
| `display.showTokenSpeed` | boolean | `false` | Show streaming tokens/sec counter during generation |
| `display.showToolPreview` | boolean | `false` | Show partial tool call preview while streaming |

## Provider Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider.model` | string | `openrouter/free` | Default LLM model ID |
| `provider.provider` | string | `openrouter` | Default provider name |
| `provider.reasoningEffort` | enum | `medium` | Reasoning effort level: `instant`, `low`, `medium`, `high` |
| `provider.systemPromptFile` | string | `""` | Path to a file containing the system prompt (empty = none) |

The `provider.model` and `provider.provider` values are also changeable at runtime via `/model` and `/provider`.

## Behavior Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `behavior.autoApprove` | boolean | `false` | Auto-approve all tool permission requests without prompting |
| `behavior.autoCompactThreshold` | number | `80` | Auto-compact when context usage exceeds this percentage (10–100) |
| `behavior.saveHistory` | boolean | `true` | Persist conversation history to disk between sessions |
| `behavior.notifyOnComplete` | boolean | `true` | Emit terminal bell and desktop notification when a long turn completes |
| `behavior.autoSwitchOnProviderFail` | boolean | `false` | Show alternative model suggestion when current provider fails |

## Permission Settings

### Permission Mode

| Key | Type | Default | Options | Description |
|-----|------|---------|---------|-------------|
| `permissions.mode` | enum | `prompt` | `prompt`, `allow-all`, `custom` | Global permission approval mode |

- `prompt` — ask before each sensitive tool call (default, recommended)
- `allow-all` — approve everything automatically (use with care)
- `custom` — use per-tool rules defined in `permissions.tools.*`

### Per-Tool Permissions

Applied when `permissions.mode` is `custom`. Each value is `allow`, `prompt`, or `deny`.

| Key | Default | Description |
|-----|---------|-------------|
| `permissions.tools.read` | `allow` | File read operations |
| `permissions.tools.write` | `prompt` | File write operations |
| `permissions.tools.edit` | `prompt` | File edit/patch operations |
| `permissions.tools.exec` | `prompt` | Shell command execution |
| `permissions.tools.find` | `allow` | File and directory search |
| `permissions.tools.fetch` | `prompt` | Outbound HTTP fetch |
| `permissions.tools.analyze` | `allow` | Code and project analysis |
| `permissions.tools.inspect` | `allow` | Runtime state inspection |
| `permissions.tools.agent` | `prompt` | Spawning subagents |
| `permissions.tools.state` | `allow` | Session/runtime state reads |
| `permissions.tools.workflow` | `prompt` | Multi-step workflow automation |
| `permissions.tools.registry` | `allow` | Tool/skill registry queries |
| `permissions.tools.delegate` | `prompt` | Unregistered/unknown tools |
| `permissions.tools.mcp` | `prompt` | MCP server tool calls |

Set via `/config`:
```
/config permissions.mode custom
/config permissions.tools.exec allow
/config permissions.tools.write allow
```

Or use `/permissions`:
```
/permissions custom
/permissions tool exec allow
```

## Danger Settings

These settings enable advanced features that can have significant side effects. They are highlighted in red in the `/config` browser.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `danger.agentRecursion` | boolean | `false` | Allow agents to spawn subagents. Can cause runaway recursion. |
| `danger.maxGlobalAgents` | number | `12` | Total concurrent agents allowed across all levels (1–20) |
| `danger.maxRecursionDepth` | number | `0` | Max agent recursion depth: 0 = disabled, 1 = one level (max allowed) |
| `danger.daemon` | boolean | `false` | Enable daemon mode (run as a background service) |
| `danger.httpListener` | boolean | `false` | Enable HTTP webhook listener for receiving external events |

Change via `/danger` or `/config`:
```
/danger agentRecursion true
/config danger.maxGlobalAgents 6
```

## Tools Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `tools.llmProvider` | string | `""` | Provider for tool LLM calls (empty = use current provider) |
| `tools.llmModel` | string | `""` | Model for tool LLM calls (empty = fastest available) |
| `tools.autoHeal` | boolean | `false` | Automatically fix syntax errors on write/edit operations |
| `tools.defaultTokenBudget` | number | `5000` | Default token budget for read operations (100–100000) |
| `tools.hooksFile` | string | `hooks.json` | Hook configuration file name (relative to `.goodvibes/tui/`) |

## WRFC Settings

WRFC (Write-Review-Fix-Commit) controls the automated code review and commit cycle used by the precision engine.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `wrfc.scoreThreshold` | number | `9.9` | Minimum review score to pass (0–10) |
| `wrfc.maxFixAttempts` | number | `5` | Maximum gate retry depth before aborting (1–20) |
| `wrfc.autoCommit` | boolean | `true` | Auto-commit when review and quality gates pass |

Quality gates (typecheck, lint, build) are configured in the `wrfc.gates` array in the settings file directly (not via dot-path API):

```json
{
  "wrfc": {
    "gates": [
      { "name": "typecheck", "command": "npx tsc --noEmit", "enabled": true },
      { "name": "lint", "command": "npx eslint . --max-warnings 0", "enabled": true },
      { "name": "build", "command": "npm run build", "enabled": false }
    ]
  }
}
```

## Notifications Settings

Webhook URLs for completion notifications are stored in the settings file as an array (not configurable via dot-path API):

```json
{
  "notifications": {
    "webhookUrls": [
      "https://hooks.slack.com/services/...",
      "https://ntfy.sh/my-topic"
    ]
  }
}
```

## Profiles

Profiles let you save and restore named sets of display, provider, and behavior settings.

```
/config profile save coding       # save current settings
/config profile load coding       # apply a profile
/config profile list              # list saved profiles
/config profile delete coding     # remove a profile
```

Profiles are stored in `~/.goodvibes/tui/profiles/`.

## Keybindings Customization

List all current bindings:
```
/keybindings
```

The config file path is printed by `/keybindings`. To customize, create a JSON file at the shown path with the action as the key:

```json
{
  "input:submit": { "key": "enter" },
  "input:interrupt": { "key": "c", "ctrl": true },
  "scroll:up": { "key": "up" },
  "scroll:down": { "key": "down" }
}
```

Combo fields: `key` (required), `ctrl`, `alt`, `shift`, `meta` (all optional booleans).

## Custom Provider Configuration

Custom provider files live in `~/.goodvibes/tui/providers/*.json`. See [PROVIDERS.md](./PROVIDERS.md) for the full schema.

Example for a local Ollama server:

```json
{
  "name": "local-ollama",
  "displayName": "Local Ollama",
  "type": "openai-compat",
  "baseURL": "http://localhost:11434/v1",
  "apiKey": "",
  "models": [
    {
      "id": "llama3:8b",
      "displayName": "Llama 3 8B",
      "contextWindow": 8192,
      "capabilities": {
        "toolCalling": true,
        "codeEditing": true,
        "reasoning": false,
        "multimodal": false
      }
    }
  ]
}
```

## Secrets Store

API keys can be stored encrypted on disk instead of in environment variables:

```
/secrets set OPENAI_API_KEY sk-...
/secrets list
/secrets delete OPENAI_API_KEY
```

Secrets are stored at `~/.goodvibes/tui/secrets.enc` using AES-256-GCM encryption. The encryption key is derived from your machine hostname and OS username — secrets encrypted on one machine cannot be decrypted on another.

**Resolution order:** environment variable → encrypted secrets store → not found.

## System Prompt

To use a custom system prompt from a file:

```
/config provider.systemPromptFile /path/to/system-prompt.txt
```

The file is reloaded on `/reset`. Set to an empty string to disable:

```
/config provider.systemPromptFile ""
```
