# Slash Command Reference

All commands are invoked by typing `/` followed by the command name. Tab-completion and fuzzy matching are supported. Run `/help` or press `?` to open the interactive command browser.

## Model and Provider

### `/model` (alias: `/m`)

Select or display the current LLM model.

```
/model                  # open the interactive model picker
/model gemini-2.5-pro   # switch to a specific model
/model gpt-5.4
```

### `/provider` (alias: `/p`)

Switch provider or manage custom providers.

```
/provider                           # open the interactive provider picker
/provider openai                    # switch to the openai provider
/provider add <name> <baseURL> [apiKey]
/provider remove <name>
```

**Examples:**
```
/provider add my-ollama http://localhost:11434/v1
/provider add my-server http://192.168.0.10:8001/v1 sk-mykey
/provider remove my-ollama
```

When adding a custom provider, goodvibes-tui probes `<baseURL>/models` to auto-discover available models and writes a config file to `~/.goodvibes/tui/providers/<name>.json`. Alias: `/provider rm` for remove.

### `/effort` (alias: `/e`)

Show or set the reasoning effort level for models that support it.

```
/effort                 # open effort picker
/effort instant         # fastest, minimal reasoning
/effort low
/effort medium          # default
/effort high            # thorough reasoning
```

Applies to Mercury-2, Gemini Pro, GPT-5, and Claude models. Models that do not support reasoning effort will display a notice.

---

## Conversation

### `/clear` (alias: `/cls`)

Clear the conversation display without resetting the LLM context window.

```
/clear
```

### `/reset`

Full reset: clears both the display and the LLM conversation context. Reloads the system prompt from file if configured.

```
/reset
```

### `/compact`

Summarize the current conversation to free context window space. The LLM generates a summary that replaces the message history.

```
/compact
```

### `/undo` (alias: `/u`)

Undo the last conversation turn, or revert the last file write/edit operation.

```
/undo           # remove last conversation turn
/undo file      # revert last file write or edit
```

### `/redo`

Restore an undone turn, or re-apply a reverted file operation.

```
/redo
/redo file
```

### `/retry` (alias: `/r`)

Re-send the last user message, optionally with modified text.

```
/retry
/retry fix the bug in main.ts instead
```

### `/fork` (alias: `/branch-save`)

Snapshot the current conversation as a named branch.

```
/fork my-branch
```

### `/branch` (alias: `/br`)

List conversation branches or switch to a named branch.

```
/branch
/branch my-branch
```

### `/merge`

Append messages from a named branch into the current conversation.

```
/merge my-branch
```

### `/title`

Show or set the conversation title.

```
/title                  # show current title
/title My Feature Work  # set title
```

### `/export`

Export the conversation to a file.

```
/export                          # save to ./conversation-<timestamp>.md
/export ./output/my-session.md   # custom path
/export text ./session.txt       # plain text format
```

Formats: `markdown` (default), `text`.

---

## Sessions

### `/save`

Save the current session to `~/.goodvibes/tui/sessions/`.

```
/save
/save my-feature-session
```

### `/load`

Load a saved session by name.

```
/load my-feature-session
```

### `/sessions`

Open the interactive session browser. Supports loading and deleting sessions.

```
/sessions
```

### `/session` (alias: `/sess`)

Session management subcommands.

```
/session               # show current session info
/session list          # list all sessions
/session rename <name> # rename the current session
/session resume <id>   # load and resume a session by ID
/session fork [name]   # fork current session to a new ID
/session save [name]   # force-save the current session
/session info [id]     # show details for a session
/session export <id> [format]  # export a session to file
/session search <query>        # search across all sessions
/session delete <id>           # delete a session
```

---

## Templates

### `/template` (alias: `/tmpl`)

Manage and use prompt templates. Templates are stored globally or per-project.

```
/template              # browse templates
/template list         # list all templates
/template save <name>  # save last message as a template
/template use <name>   # execute a template
/template edit <name>  # view template content
/template delete <name>
```

Templates support variable substitution. Pass args after the template name:

```
/template use refactor src/main.ts
```

---

## Configuration

### `/config` (alias: `/cfg`)

Show or set configuration values. Settings are saved to `~/.goodvibes/tui/settings.json`.

```
/config                          # open the interactive config browser
/config display                  # show the display category
/config display.theme            # show one setting
/config display.theme vaporwave  # set a value
/config reset display.theme      # reset to default
/config reset                    # reset all settings
/config diff                     # show settings that differ from defaults
/config profile save <name>      # save current settings as a profile
/config profile load <name>      # apply a saved profile
/config profile list             # list all profiles
/config profile delete <name>
```

In the interactive config browser, press **Space** to toggle a boolean or cycle an enum value.

### `/debug`

Toggle debug mode. In debug mode, additional technical output is shown.

```
/debug
```

### `/lines`

Toggle line numbers on or off in code blocks.

```
/lines
```

### `/expand`

Expand collapsed blocks.

```
/expand all
/expand thinking
/expand tool
/expand code
```

### `/collapse`

Collapse expanded blocks.

```
/collapse all
/collapse thinking
/collapse tool
/collapse code
```

### `/bookmarks` (alias: `/bm`)

Open the bookmark browser to view and navigate to bookmarked blocks in the conversation.

```
/bookmarks
```

### `/context` (alias: `/ctx`)

Inspect context window usage with a token breakdown per message.

```
/context
```

### `/next-error` (alias: `/ne`)

Jump to the next error message in the conversation.

```
/next-error
```

### `/prev-error` (alias: `/pe`)

Jump to the previous error message in the conversation.

```
/prev-error
```

### `/diff` (alias: `/d`)

Show a unified diff of session file changes. Uses `git diff HEAD` if in a git repo.

```
/diff
```

---

## Tools and Permissions

### `/tools` (alias: `/t`)

List all available tools. Opens an interactive picker when the selection modal is available.

```
/tools
```

### `/permissions` (alias: `/perms`)

Show or set permission mode and per-tool settings.

```
/permissions
/permissions allow-all          # auto-approve all tool calls
/permissions prompt             # prompt for each tool call (default)
/permissions custom             # use per-tool custom rules
/permissions tool exec allow    # allow shell execution without prompting
/permissions tool write prompt  # prompt before file writes
```

### `/secrets`

Manage encrypted API key secrets stored in `~/.goodvibes/tui/secrets.enc`.

```
/secrets set <key> <value>   # store a secret
/secrets get <key>           # resolve a secret (env var, then store)
/secrets list                # list stored key names
/secrets delete <key>        # remove a secret
```

**Example:**
```
/secrets set OPENAI_API_KEY sk-mykey
```

### `/services` (alias: `/svc`)

Manage API service configurations.

```
/services
```

### `/settings` (alias: `/cfg-ui`)

Open the interactive config/settings browser modal.

```
/settings
```

### `/danger`

Configure dangerous advanced settings. Shown in red in the command list.

```
/danger agentRecursion true
/danger maxGlobalAgents 6
/danger daemon true
/danger httpListener true
```

### `/plugin`

Manage plugins.

```
/plugin                    # show installed plugins and their status
/plugin list               # list installed plugins
/plugin enable <name>      # enable a plugin
/plugin disable <name>     # disable a plugin
/plugin reload             # reload all enabled plugins
```

Plugins are installed by placing a folder with `manifest.json` and `index.ts` in `~/.goodvibes/tui/plugins/`.

---

## Agent and Workflow

### `/panel` (aliases: `/panels`)

Open, close, or list panels.

```
/panel              # open the panel sidebar
/panel list         # list available panels
/panel open <id>    # open a panel by ID
/panel close <id>   # close a panel
/panel toggle       # toggle the panel sidebar
/panel focus        # focus the panel sidebar
/panel split        # split the current panel
```

### `/profiles` (alias: `/profile`)

Browse and load config profiles.

```
/profiles
/profiles load <name>
```

### `/scan`

Scan localhost and LAN for local LLM servers.

```
/scan
```

### `/plan`

Manage execution plans for multi-step tasks.

```
/plan
/plan list
/plan run
/plan clear
```

### `/schedule` (alias: `/sched`)

Manage scheduled agent tasks (cron-like).

```
/schedule                          # list scheduled tasks
/schedule add <cron> <prompt>      # add a new task
/schedule remove <id>              # remove a task
/schedule run <id>                 # run a task immediately
```

### `/image` (alias: `/img`)

Attach an image file to the next message.

```
/image <path-to-image>
```

### `/pin`

Pin a model to your favorites. Pinned models appear at the top of the model picker.

```
/pin <model-id>      # pin a model by ID
/pin gemini-3-flash  # example
```

### `/unpin`

Remove a model from your favorites.

```
/unpin <model-id>
```

### `/refresh-models`

Force a re-fetch of the model catalog from models.dev and benchmark data from ZeroEval, bypassing the 24h TTL cache.

```
/refresh-models
```

Displays a summary of changes: new models added, models removed, and models with changed context windows or pricing.

### `/notify`

Manage webhook notification URLs (ntfy.sh format).

```
/notify                     # list configured webhooks
/notify add <url>           # add a notification URL
/notify remove <url>        # remove a notification URL
/notify test                # send a test notification
```

### `/mcp`

List connected MCP servers and their tools.

```
/mcp
```

### `/share`

Export the current session to a shareable format.

```
/share          # export as HTML (default)
/share html     # export as HTML
/share json     # export as JSON
/share md       # export as Markdown
```

---

## Navigation and Help

### `/help` (aliases: `/h`, `?`)

Open the interactive help browser with all commands grouped by category. Supports fuzzy search.

```
/help
```

### `/commands` (alias: `/cmds`)

Open the scrollable command list overlay.

```
/commands
```

### `/shortcuts` (aliases: `/keys`, `/keybinds`)

Open the keyboard shortcuts reference overlay.

```
/shortcuts
```

### `/keybindings` (alias: `/kb`)

List current keyboard bindings and their configuration file path.

```
/keybindings
```

### `/quit` (aliases: `/q`, `:q`)

Exit the application cleanly.

```
/quit
```

---

## Command Autocomplete

Type `/` and start typing to activate fuzzy-match autocomplete. The autocomplete overlay ranks by:

1. Exact match (score 100)
2. Prefix match (score 80)
3. Subsequence match (score 40 - query length)

Press **Tab** or **Right arrow** to accept the top suggestion. Press **Esc** to dismiss.
