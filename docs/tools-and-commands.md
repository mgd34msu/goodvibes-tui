# Tools and Commands

## Built-in tools

GoodVibes ships a broad built-in tool set. Current tool families include:

- file and code operations: `read`, `write`, `edit`, `find`
- execution and inspection: `exec`, `analyze`, `inspect`
- network and research: `fetch`, `web_search`
- orchestration: `agent`, `workflow`, `task`, `team`, `worklist`
- runtime/control surfaces: `state`, `registry`, `control`, `channel`, `remote`
- external integration surfaces: `mcp`
- structured query/eval surfaces: `repl`, `query`, `packet`

The tool registry is part of the main runtime and is shared across the TUI, agents, automation, and daemon-backed flows.

## High-value tool families

### File and code work

- `read` for token-efficient file reading, outlines, symbols, AST views, and paginated batch reads
- `write` for atomic writes, overwrite modes, and auto-heal pipelines
- `edit` for structural code edits with validation and rollback
- `find` for files, content, symbols, references, and structural search

### Execution and analysis

- `exec` for shell execution, background processes, retries, and process tracking
- `analyze` for impact, dependencies, dead code, upgrade, semantic diff, and security checks
- `inspect` for project/frontend/runtime inspection

### Research and retrieval

- `fetch` for HTTP retrieval and extraction
- `web_search` for provider-backed search and evidence shaping
- `packet` for compact knowledge/context packets
- `query` and `repl` for bounded query/eval work

### Coordination and product control

- `agent` for in-process agent work
- `workflow` for WRFC and related execution flows
- `remote` for distributed runtime control
- `channel` for channel-aware runtime and delivery surfaces
- `control` and `state` for product/runtime introspection

## Tool reference

Deeper detail on the built-in tool families introduced above.

### REPL and eval runtimes

The `repl` tool provides bounded, live evaluation backed by the sandbox/session layer:

- JavaScript and TypeScript evaluate inside the sandbox exec path
- Python runs in an ephemeral virtualenv
- SQL evaluates against an ephemeral in-memory SQLite database
- GraphQL provides bounded GraphQL expression analysis/normalization through the REPL path, not a live GraphQL server

REPL history persists to `.goodvibes/tui/repl-history.json`.

### read

Read files with token-efficient extraction modes.

- Extract modes: `content` (full text), `outline` (signatures only), `symbols` (exported names only, the most compact mode), `ast` (structural), `lines` (specific ranges)
- Tree-sitter powered outline and symbol extraction with regex fallback
- Token-budget pagination for large batch reads — request many files, get pages that fit within a budget
- Built-in image, PDF, and Jupyter notebook reading
- Per-file caching with optimistic concurrency control (OCC) conflict detection — tracks what you've read and warns if it changed externally

### write

Write files with atomic operations, backup modes, and auto-heal.

- Atomic writes via temp file + rename — no partial writes on crash
- Overwrite modes: `fail_if_exists`, `overwrite`, `backup` (copies the original to `.goodvibes/.backups/`)
- Auto-heal pipeline: if a written file has syntax errors and `tools.autoHeal` is enabled, runs formatter -> linter -> LLM fix automatically
- Base64 content support for files with special characters
- Batch writes in a single call with per-file mode control

### edit

Structural code editing with AST matching, scope hints, and transactional rollback.

- Match modes: `exact`, `fuzzy` (whitespace-insensitive), `regex` (with capture groups), `ast` (tree-sitter structural), `ast_pattern` (ast-grep with metavariables like `$VAR` and `$$$ARGS`)
- Scope hints: `in_function`, `in_class`, `near_line` — disambiguate matches without adding more context
- Occurrence selection: `first`, `last`, `all`, or a specific Nth occurrence, with an ambiguity guard by default
- Atomic transactions: all edits succeed or all roll back; also supports `partial` and `none` modes
- Pre/post validation: run `typecheck`, `lint`, `test`, or `build` before and after edits, with auto-rollback on failure
- Auto-heal on validation failure (same pipeline as `write`)

### find

Multi-mode search across files, content, symbols, references, and structural AST patterns.

- Search modes: `files` (glob), `content` (regex grep), `symbols` (exported declarations), `references` (find all references via LSP with grep fallback), `structural` (AST pattern matching via ast-grep)
- Structural search uses ast-grep to find code patterns like `console.log($$$ARGS)` across TypeScript, JavaScript, CSS, and HTML
- Scope expansion: expand content matches to their enclosing `function` or `class` using tree-sitter
- Multiple queries per call, executed in parallel
- Progressive output: `count_only` -> `files_only` -> `locations` -> `matches` -> `context`

### exec

Shell execution with background processes, retry, progress tracking, and file operations.

- Background execution with process tracking — spawn, poll status, read output, kill
- Retry with exponential backoff on transient failures
- `until` pattern: watch stdout for a regex match, then stop or promote to background
- Pre-command file operations: copy, move, delete files before running commands
- Progress file streaming for long-running commands (auto-enabled above 30s)
- Fail-fast mode: stop sequential execution on first failure, report remaining commands as skipped

### fetch

HTTP client with extraction modes, service registry auth, and batch operations.

- Extraction modes include `raw`, `text`, `json`, `markdown`, `readable` (strips nav/sidebar/footer), `code_blocks`, `links`, `tables`, `metadata` (og-tags), `structured` (CSS selectors), and `pdf`
- Named service registry: configure API credentials once in `.goodvibes/tui/services.json`, reference by name in fetch calls
- Inline auth: `bearer`, `basic`, `api-key` per request
- Batch parallel fetches in a single tool call

### web_search

Higher-level provider-backed search built on top of the lower-level fetch/runtime stack. `fetch` is the HTTP/extraction primitive; `web_search` is the search/evidence surface built on top of it — reach for `fetch` when you already have a URL, and `web_search` when you need ranked results and evidence shaping first. See [Providers and routing](providers-and-routing.md) for the current search provider list.

### analyze

A code analysis suite spanning impact analysis through upgrade compatibility.

- `impact`: trace exported symbols across the project to find what breaks when you change a file
- `dependencies`: build the import graph, detect circular dependencies, list external packages
- `dead_code`: find exported symbols with zero references outside their own file
- `security`: scan for hardcoded secrets, world-writable files, and missing `.env` keys
- `breaking`: compare git refs and detect removed/changed export signatures
- `semantic_diff`: LLM-powered diff summary with risk assessment (low/medium/high)
- `upgrade`: check the npm registry for outdated packages and flag breaking version bumps
- Also: `coverage` (lcov/istanbul parse), `bundle` (stats.json), `surface` (public API), `preview` (dry-run edit), `diff` (git ref diff), `permissions` (dangerous pattern scan), `env_audit` (`.env` key comparison), `test_find` (locate test files for source files)

### inspect

A project and frontend inspection tool.

- `project`: detect project type, package manager, test framework, entry points, monorepo status
- `api` + `api_spec` + `api_validate` + `api_sync`: discover API routes across Next.js (App + Pages Router), Express, Fastify, and Hono; generate OpenAPI 3.0 specs; validate specs against code; detect frontend/backend drift by scanning `fetch()` calls
- `database`: parse Prisma schemas into structured model/field/relation data
- `components`: extract the React component tree with props, hooks, and child components
- `scaffold`: generate a module skeleton (types, implementation, tests, barrel export) with dry-run
- Frontend analysis: `layout` (CSS/Tailwind layout hierarchy), `accessibility` (a11y issue detection), `component_state` (useState/useReducer/useContext tracing), `render_triggers` (what causes re-renders), `hooks` (dependency array auditing with missing-dep detection), `overflow`/`sizing`/`stacking` (CSS issue detection), `responsive` (Tailwind breakpoint analysis), `events` (handler analysis), `tailwind` (class conflict detection), `client_boundary` (Next.js directive analysis), `error_boundary` (coverage analysis)

### agent

In-process subagent management. See [Agent system](#agent-system) below for archetypes, custom archetypes, and worktree isolation.

- Spawn agents from named archetypes or custom archetypes in `.goodvibes/agents/*.md`
- Full lifecycle: `spawn`, `status`, `cancel`, `list`, `get` (detailed view with recent messages), `wait` (block until completion with timeout)
- Inter-agent messaging via `message` mode
- Token budget estimation via `budget` mode
- Execution plan introspection via `plan` mode
- Batch spawning via `batch-spawn` mode
- WRFC chain introspection via `wrfc-chains` and `wrfc-history` modes
- Cohort tracking via `cohort-status` and `cohort-report` modes

### state

Session state, persistent memory, telemetry, hooks, and output modes, all in one tool.

- KV state: session-scoped key-value store with atomic persistence
- Durable memory posture: inspect the reviewed knowledge substrate and related runtime state (the full durable-memory workflow lives under `/recall` and the knowledge panels)
- Hook management: list, enable, disable, add, and remove hooks at runtime
- Output mode switching: switch between `default`, `vibecoding`, and `justvibes` verbosity presets
- Analytics: record tool calls, query by filter, export as JSON/CSV, dashboard view — backed by WASM SQLite
- Context and budget reporting for token usage awareness

### workflow

Workflow state machines, automation triggers, and scheduled tasks. See [Automation and scheduling](#automation-and-scheduling) below for the underlying contract model.

- Named workflow definitions: `wrfc` (work-review-fix cycle), `fix_loop`, `test_then_fix`, `review_only`
- State machine with validated transitions — prevents invalid state changes
- Automation triggers: fire shell commands when specific hook events occur, with optional JS conditions
- Cron scheduler: full 5-field cron expressions with IANA timezone support, missed-run detection, per-task run history, and enable/disable control; persists to `.goodvibes/tui/schedules.json`
- Full lifecycle: start, transition, cancel, list active instances

### task / team / worklist

Structured execution and coordination beyond a single conversation turn.

- `task`: create, inspect, block, cancel, depend, and hand off tasks across sessions
- `team`: define teams, members, lanes, and role assignments
- `worklist`: manage durable worklists with ownership and priority

### packet / query

Durable planning and operator-communication artifacts.

- `packet`: create, revise, publish, and list implementation packets / execution packets
- `query`: track operator queries, answers, escalation targets, and closure state

### mcp / remote / control

Product-control tools that expose runtime breadth directly. See [MCP integration](#mcp-integration) below for the connection and config model.

- `mcp`: inspect MCP servers, tools, schema freshness, security posture, auth posture, and quarantine controls
- `remote`: inspect and manage distributed peers, node-host contracts, work queues, artifacts, and review flows
- `control`: inspect packaged command families, panel/control-room families, built-in subscription providers, and sandbox presets

### channel

The `channel` tool exposes the omnichannel runtime directly to the model and operator flows.

- list accounts per surface and inspect individual account/setup state
- run account lifecycle actions such as setup, inspect, retest, connect, disconnect, login, and logout
- query shared channel directories and resolve targets across supported surfaces
- inspect channel capabilities, tools, agent-tools, and operator actions
- run channel-owned tools/actions and perform authorization checks through the same surface registry used by the daemon and reply pipeline

### registry

Discover and introspect skills, agents, and tools.

- Fuzzy search across skills (`.goodvibes/skills/*.md`), agents (`.goodvibes/agents/*.md`), and built-in tools
- Task-based recommendations: describe what you want to do, get ranked suggestions
- Dependency chain resolution for skills
- Full content retrieval for any registry item

## Slash-command families

Representative slash-command families include:

- `/model`
- `/settings`
- `/config`
- `/recall`
- `/knowledge`
- `/remote`
- `/sandbox`
- `/plugin`
- `/marketplace`
- `/share`
- `/workflow`
- `/schedule`
- `/voice`
- `/tts`
- `/cloudflare`
- `/mcp`
- `/incident`
- `/replay`
- `/eval`
- `/session`
- `/work-plan`
- `/search`
- `/imagine`
- `/codebase`
- `/workstream`
- `/checkpoint`
- `/editor`

`/editor` (alias `/ed`) opens the current composer draft in your `$VISUAL`/`$EDITOR`, suspends the TUI while the editor runs, and loads the edited text back into the composer when you save and quit. Set `$EDITOR` (e.g. `export EDITOR=nvim`) for it to work.

Composer capture markers: a line beginning with `#` saves the rest as a session-memory note and does NOT send a turn — a quick "jot this down" — and a confirmation names what was saved and where. (`## ...` markdown headings are left alone and sent normally.) The existing `!# <text>` still pins to session memory and also sends the text as a prompt.

`/schedule add when "<natural language>" <prompt...>` accepts natural-language times parsed locally — for example `every weekday at 9am`, `daily at 6pm`, `every 30 minutes`, `every monday at 08:00`, or `in 2 hours`. The command always echoes back the concrete interpretation (the resulting cron/interval/one-shot schedule) before the job is saved, so you can see exactly what was understood.

`/search <query> [--limit <n>]` runs a provider-backed web search directly (bypassing the agent-tool JSON wrapper) and renders ranked results, an instant answer, and the source label into the transcript; it degrades honestly using the web-search service's own status note. `/imagine <prompt>` is the first production caller of the media-provider registry's image generation — on success it persists the artifact (inline bytes stored directly; a remote-URL-only result is stored as a small JSON pointer record rather than eagerly fetched), and prints the registry's own per-provider status (naming the exact env var) when no image-capable provider is configured. (`/image` is a different, pre-existing command — it attaches a local image file to the next message for multimodal analysis.)

`/session` is the single front-door for all session work. Two domains:
- Lifecycle: `list`, `rename`, `resume`, `fork`, `save`, `info`, `export <id|.> [format]`, `search <query>`, `delete <id>`, `events [kind]`, `groups [kind]`, `hotspots`
- Orchestration (cross-session task DAG with cycle detection): `link-task <taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]`, `handoff <taskId> --to <sid>`, `graph [--session <sid>] [--format text|json]`, `cancel <taskId> [--scope task|subtree|session]`

Alias: `/sess`. Run `/session` with no arguments to see current session info.

`/model` opens the fullscreen provider/model workspace. The left rail chooses the target route (`Main Chat`, `Helper Model`, `Tool LLM`, or `TTS LLM`), and the main table filters large model catalogs by search, price tier, capability, availability, benchmark sort, and grouping. `/provider` opens the same workspace in provider-first mode so users can choose a provider and then a model for the active target.

`/plan` now inspects or seeds the TUI-owned project-planning state. The primary planning UX is natural conversation in the TUI; daemon and companion surfaces only get passive SDK storage/evaluation routes. Use `/plan panel` to open the Planning panel, `/plan approve` to record explicit execution approval, or `/plan <goal>` to seed the current workspace planning artifact.

`/paste` (`/clip`) explicitly reads the system clipboard and inserts supported text or image data into the prompt. Use this when terminal paste does not deliver image clipboard contents to the TUI; the command uses the clipboard helper path instead of relying on the terminal paste stream.

`/mcp` opens the fullscreen MCP workspace. `/mcp add <name> <command> [args...] [--scope project|global]` writes a project server to `.goodvibes/mcp.json` or a global server to `~/.config/mcp/mcp.json`, then reloads the live MCP runtime without restarting. Use `/mcp remove <server> [--scope project|global]`, `/mcp reload`, `/mcp config`, and `/mcp tools [server]` for the same operations from the command line. See [MCP integration](#mcp-integration) below for the config file shape and connection model.

## Keyboard shortcuts

Most shortcuts are customizable via `~/.goodvibes/tui/keybindings.json`. Use `/keybindings` to view current bindings.

Five keys are fixed and are not in the rebindable table: `F2` (toggle the Fleet panel), `Shift+Tab` (cycle the session permission mode), `Esc` (exit the current mode), `?` (help/command picker on an empty prompt), and `@` (file picker). Everything else below resolves through the keybindings table and can be reassigned.

### Input and editing

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Tab` | Toggle block collapse / path completion |
| `Ctrl+U` | Kill from cursor to start of line (push to kill ring) |
| `Alt+U` | Clear entire prompt (no kill-ring push) |
| `Ctrl+W` | Kill word backward (push to kill ring) |
| `Alt+K` | Kill from cursor to end of line (push to kill ring) |
| `Alt+D` | Kill word forward (push to kill ring) |
| `Ctrl+Shift+Y` | Yank from kill ring |
| `Alt+Y` | Yank-pop (rotate kill ring, replace last yank); only valid immediately after a yank |
| `Alt+B` | Move word backward |
| `Alt+F` | Move word forward |
| `Ctrl+Z` | Undo prompt edit |
| `Ctrl+Shift+Z` | Redo prompt edit |
| `Ctrl+V` | Paste (image or text) |
| `@` | Open file picker (insert file path) |
| `?` | Open help/command picker (empty prompt) |
| `r` / `m` | After a turn error: retry the turn / open the model picker (any other key dismisses) |

`Ctrl+W` uses whitespace-delimited word boundaries (readline/unix-word-rubout semantics), while `Alt+D`, `Alt+B`, and `Alt+F` use Unicode word boundaries (letters, digits, underscore).

`Ctrl+K` is the command palette, not kill-to-end-of-line: the readline kill that historically owned `Ctrl+K` is bound to `Alt+K` instead, so the capability is kept rather than lost. `Ctrl+U` and `Alt+U` are likewise split — `Ctrl+U` kills to the start of the line and pushes the text onto the kill ring (readline convention), while `Alt+U` clears the whole buffer regardless of cursor position and pushes nothing.

### Navigation

| Key | Action |
|-----|--------|
| `Arrow Up / Down` | Scroll conversation / recall input history |
| `PageUp / PageDown` | Scroll by page |
| `Ctrl+R` | Reverse input history search |
| `Ctrl+E` | Move to end of line / next error |
| `Ctrl+A` | Move to start of line / apply nearest diff |
| `Mouse wheel` | Scroll |
| `Click drag` | Select text |
| `Middle click` | Paste |
| `n` / `N` | Next / previous match in locked search mode; wraps with a `(wrap)` marker |
| `Escape` | Exit current mode (search, command, modal) |

### Blocks and content

| Key | Action |
|-----|--------|
| `Ctrl+Y` | Copy nearest block to clipboard |
| `Ctrl+S` | Save nearest block to file |
| `Ctrl+B` | Bookmark nearest block |
| `Ctrl+F` | Open conversation search overlay |
| `Ctrl+L` | Clear screen |
| `Ctrl+Shift+C` | Copy selection |

### Panels

| Key | Action |
|-----|--------|
| `Ctrl+P` | Toggle panel sidebar |
| `F2` | Toggle the Fleet panel — the live unified process tree (open and focus, bring to front, or close) |
| `Ctrl+]` / `Ctrl+PageDown` | Next panel tab |
| `Ctrl+PageUp` | Previous panel tab |
| `Alt+1`…`Alt+9` | Jump to panel tab 1–9 (shown as `⌥N` on the tab bar) |
| `Ctrl+X` | Close the focused panel |
| `Ctrl+Shift+X` | Close all panels |
| `Ctrl+O` | Toggle the Fleet panel (same behavior as `F2`) |
| `Ctrl+G` | Toggle focus between split panes |

### Selection modals

Every picker built on the selection modal — the recovery offer, session picker, profile picker, config rows — shares one key vocabulary:

| Key | Action |
|-----|--------|
| `Enter` | Run the selected row's primary action |
| `Space` | Toggle the selected row when it has a toggle action |
| `Left` / `Right` | Decrement / increment an adjustable row without leaving the modal |
| `Shift+Left` / `Shift+Right` | The same adjustment with the row's step multiplied by 10 (a row with no explicit step moves by 10) |
| `Esc` | Close the modal, in one press, whatever the search state |
| `Backspace` | Clear the in-progress search query one character at a time |

In a searchable modal, `/` focuses the filter, and any keystroke that no row hotkey claims also arms the filter and starts the query with that character.

### System

| Key | Action |
|-----|--------|
| `Ctrl+C` | Clear input / cancel generation / exit (double-press to quit) |
| `Ctrl+K` | Open the command palette (search and run any command) |
| `Shift+Tab` | Cycle the session permission mode: normal → accept-edits → plan → auto |
| `Alt+C` | Cancel the running tool call (the turn continues) |
| `Alt+A` | Toggle keep-awake (the "sleep disabled" chip) |
| `Alt+M` | List or hide the memories a turn used (provenance chip drill-in) |

A single `Ctrl+C` on an empty composer arms a roughly one-second "press again to exit" confirmation; the footer shows this as `Ctrl+C x2 quit`.

## Agent system

Agents are in-process subagents with isolated conversation history, a scoped tool registry, and an optional git worktree. They run asynchronously and report back through the agent message bus. Use the `agent` tool (see [Tool reference](#tool-reference) above) to spawn and manage them.

### Built-in archetypes

Eight archetypes ship built in. A markdown file in `.goodvibes/agents/` with the same `name` overrides the built-in entry.

| Archetype | Tools | Description |
|-----------|-------|-------------|
| `orchestrator` | read, find, analyze, inspect, registry | WRFC coordination and decomposition agent |
| `planner` | read, find, analyze, inspect | Read-only goal-decomposition agent (no write/edit/exec/delegate) |
| `engineer` | read, write, edit, find, exec, analyze, inspect, fetch, registry | Full-stack implementation agent |
| `reviewer` | read, find, analyze, inspect, fetch, registry | Code review and quality assessment |
| `tester` | read, write, find, exec, analyze, inspect | Test writing and execution |
| `researcher` | read, find, analyze, inspect, fetch, registry | Codebase exploration and analysis |
| `integrator` | read, write, edit, find, exec, analyze, inspect, fetch, registry | Cross-deliverable integration agent |
| `general` | read, write, edit, find, exec, analyze, inspect, fetch, registry | General purpose agent |

### Custom archetypes

Drop a Markdown file into `.goodvibes/agents/` with YAML frontmatter:

```markdown
---
name: documenter
description: API documentation writer
tools: [read, find, write]
model: claude-haiku-4-5
---

You are a technical documentation specialist. Focus on clarity and completeness.
```

The markdown body becomes the agent's system prompt.

### Spawning an agent

Ask for it in conversation (`spawn an engineer agent to refactor src/utils.ts`), or call the `agent` tool directly using its spawn mode, specifying an archetype and task.

### Git worktree isolation

When an agent is spawned, it can be given its own git worktree. On completion, changes are merged back. On cancellation or error, the worktree is cleaned up.

## Hook system

Hooks fire on lifecycle events throughout a session. They are configured in `.goodvibes/hooks.json` (or a custom file set in `tools.hooksFile`).

### Event path format

```
Phase:Category:Specific
```

- Phases: `Pre`, `Post`, `Fail`, `Change`, `Lifecycle`
- Categories: `tool`, `file`, `git`, `agent`, `compact`, `llm`, `mcp`, `config`, `budget`, `session`, `workflow`
- Wildcards are supported: `Pre:tool:*` matches all pre-tool events

### Hook types

| Type | Description |
|------|-------------|
| `command` | Run a shell command. Event data is passed via stdin as JSON. |
| `prompt` | Send a prompt to an LLM. `$ARGUMENTS` is replaced with the event JSON. |
| `agent` | Spawn a subagent to handle the event. |
| `http` | POST the event payload to a URL. |
| `ts` | Execute a TypeScript module that exports a default handler function. |

### Example hooks.json

```json
{
  "hooks": {
    "Post:tool:write": [
      {
        "type": "command",
        "command": "echo 'File written: $FILE' >> .goodvibes/write-log.txt",
        "async": true,
        "description": "Log all file writes"
      }
    ],
    "Pre:tool:exec": [
      {
        "type": "prompt",
        "prompt": "Review this command for safety: $ARGUMENTS",
        "model": "claude-haiku-4-5",
        "description": "Safety check before exec"
      }
    ]
  }
}
```

### Hook chains

Chains trigger an action only after a sequence of events occurs, with optional time windows and conditions:

```json
{
  "chains": [
    {
      "name": "notify-after-agent-completes",
      "steps": [
        { "match": "Lifecycle:agent:spawned" },
        { "match": "Lifecycle:agent:completed", "within": "5m" }
      ],
      "action": {
        "type": "command",
        "command": "notify-send 'Agent finished'"
      }
    }
  ]
}
```

Hook properties: `match`, `type`, `command`/`prompt`/`url`/`path`, `async`, `once`, `timeout`, `enabled`, `name`.

## Automation and scheduling

Beyond individual hook definitions, GoodVibes treats hook points, workflow runs, and scheduled tasks as a managed contract rather than plain fire-and-forget shell calls.

- Hook-point contracts carry execution authority, mutation/injection permissions, timeout policy, and failure policy metadata — a hook point declares what it is allowed to do, not just what triggers it
- Managed hooks support scaffold, chain, enable/disable, inspect, import/export, and simulation flows through `/hooks` and the `state` tool's hook management modes
- Workflow state machines (`wrfc`, `fix_loop`, `test_then_fix`, `review_only`) drive validated transitions for multi-step review/fix cycles — see [Tool reference: workflow](#workflow) above
- Cron-like scheduled agent tasks support timezone-aware schedules, missed-run tracking, run history, and manual trigger support, managed via `/schedule`

Project planning and the persistent `/work-plan` checklist are a related but separate surface — see [Project planning](#project-planning) below and [Project planning](project-planning.md).

## MCP integration

Connect to any MCP-compatible server from inside the running TUI. Project-scoped servers live in `.goodvibes/mcp.json`; global servers live in `~/.config/mcp/mcp.json`. You can also edit either file directly:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  ]
}
```

MCP tools appear in the tool registry as `mcp:<server-name>:<tool-name>`. Tool schemas load progressively: names and descriptions at startup, full parameter schemas on first use. Connections auto-restart on crash.

MCP tool calls respect the `permissions.tools.mcp` setting (default: `prompt`).

Beyond the connection mechanics, the current MCP product loops also cover:

- trust posture and quarantine review for newly added or unverified servers
- auth-review and reconnect flows for servers whose credentials or connections have degraded
- sandbox-backed execution when isolation is configured for a server
- routing into dedicated MCP and Health workspaces for operator review

See the `/mcp` command usage above in Slash-command families for the command-line surface, and the `mcp` / `remote` / `control` entry in [Tool reference](#tool-reference) for model-facing inspection.

## Plugin system and ecosystem

Extend goodvibes-tui with custom plugins, and optionally distribute or install plugins, skills, hook-packs, and policy-packs through a curated ecosystem catalog.

### Plugin folder layout

Place plugin folders in `~/.goodvibes/tui/plugins/`. Each plugin has a `manifest.json` and an entry file (default `index.ts`):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin"
}
```

### Plugin API

Plugins receive a sandboxed API:

- `registerCommand()` — add custom slash commands
- `registerProvider()` / `registerProviderInstance()` — add OpenAI-compatible or fully custom LLM providers
- `registerTool()` — add custom tools available to the LLM
- `registerGatewayMethod()` — add control-plane/API methods
- `registerChannelPlugin()` / `registerDeliveryStrategy()` — extend omnichannel surfaces
- `registerMemoryEmbeddingProvider()` — extend sqlite-vec-backed memory indexing
- `registerVoiceProvider()` / `registerMediaProvider()` / `registerWebSearchProvider()` — extend voice, media, and search families
- `onEvent()` — subscribe to typed runtime events
- `getConfig()` — read plugin-specific settings
- `log()` — emit structured plugin logs

Manage installed plugins via `/plugin enable|disable|reload|list`.

### Trust, quarantine, and discovery

- local plugin discovery across configured search directories
- plugin inspect/review output with trust tier, quarantine posture, capability counts, and signature fingerprint visibility
- `/plugin list|inspect|review|browse|catalog-review|publish-local|install|update|uninstall`

### Curated ecosystem catalogs

Beyond direct local plugins, a local-first curated distribution channel covers plugins, skills, hook-packs, and policy-packs:

- curated ecosystem catalogs with publish-local, unpublish, catalog review, install, update, uninstall, and installed-receipt flows
- local-first curated plugin distribution via `.goodvibes/tui/ecosystem/*.json`
- recommendations tied to installed state, denials, and missing capabilities
- `/marketplace` browses the curated plugin, skill, hook-pack, and policy-pack surfaces

## Operator surfaces

> **note.** Most operator read/navigate surfaces are now reached as
> **config-modal surfaces** via `ctx.openModal` (or their panel-id modal
> redirect), not standalone panels: providers/health, services, subscription,
> remote, sandbox, settings-sync and marketplace, plugins, skills, hooks,
> policy, security, knowledge, memory, docs→keybindings, qr-code→pairing,
> work-plan, project-planning→planning. The runtime-ops consoles
> (cockpit, orchestration, tasks, worktrees, approvals, communication, …)
> redirect to the **Fleet** panel. The command front-doors below are unchanged.

Many commands also have matching panels and control rooms. High-signal examples:

- provider accounts and health (`/health` pillars include `setup`, `services`, `sandbox`, `accounts`, `auth`, `settings`, `remote`, `continuity`, `worktrees`, `maintenance`, and `term` for terminal-capability posture)
- knowledge and memory review
- remote peers and work queues
- channels and deliveries
- MCP trust and reconnect posture
- approvals, policy, security, and diagnostics
- tasks, orchestration, worktrees, and agents
- WRFC chain state and constraint satisfaction
- project planning readiness, decisions, project language, task graph, verification gates, and agent handoff metadata
- persistent work-plan task tracking for ongoing local implementation work

## Evaluation, replay, diagnostics, and incidents

GoodVibes includes a post-execution and operator-repair stack:

- `/eval` runs built-in evaluation suites, compares baselines, and applies regression gates
- `/replay` loads and steps deterministic replay runs
- `/incident` opens, exports, and captures forensics bundles
- Health and diagnostics surfaces expose repair actions, transport issues, task failure state, and replay hooks
- the state inspector subsystem tracks transitions, time-travel snapshots, and selector hotspots
- telemetry exporters can write to local ledgers, console sinks, or OTLP bridges
- retention and pruning policy keeps checkpoint/snapshot growth bounded
- idempotency keys prevent duplicate tool execution across replay, reconnect, and retry scenarios
- operational playbooks describe symptoms, checks, and resolution steps for runtime failure classes

Adjacent reliability subsystems: notifications; performance budgets and panel-health monitoring; retention and pruning; idempotency protection; and the machine-readable recovery playbooks used by the diagnostics surface.

## Project planning

Project planning is TUI-owned. When a normal chat turn clearly asks for an implementation plan, dependency graph, verification strategy, or agent handoff, the TUI opens the Planning panel, stores state in the SDK `ProjectPlanningService`, evaluates readiness, and asks one focused planning question before execution.

Planning artifacts are stored in a project knowledge space named `project:<projectId>`, where the project id is derived from the workspace path. The SDK supplies passive daemon routes and operator methods, but daemon/non-TUI surfaces do not enter planning loops.

See [Project planning](project-planning.md) for the panel layout, `/plan` behavior, and route/method list.

`/work-plan` is the separate persistent checklist surface. Use it when the work already has concrete tasks and you want durable status tracking rather than another planning interview.

## Context maintenance

GoodVibes automatically compacts the conversation context when token usage reaches the configured threshold. The default threshold is 80% (`behavior.autoCompactThreshold`). You can adjust this in Settings → Behavior; the valid range is 10–100.

When auto-compaction fires, a before/after notice appears in the transcript. The current context fill level is shown in the shell footer when usage exceeds 50%.

Use `/compact` to compact manually at any time.

## Knowledge Ask

`/knowledge ask <query>` asks the SDK knowledge/wiki layer for a source-backed semantic answer. Use `--space <knowledgeSpaceId>` to target a specific space such as a Home Assistant graph, `--limit <n>` to bound evidence, and `--mode concise|standard|detailed` to select answer detail.

The TUI displays the SDK-returned answer text, sources, facts, linked objects, gaps, confidence, and synthesized state directly. It does not turn search results into local snippets.

## WRFC constraint visibility

The WRFC panel surfaces constraint state at every level of a running chain:

- Each chain renders a constraint badge (`c:N/M`) colored by aggregate satisfaction status (green = all satisfied, grey = unverified, red = unsatisfied; yellow when some constraints are verified and some are still pending).
- Expanding a chain shows each constraint with a status marker: `[SAT]` (satisfied), `[UNS CRIT]` / `[UNS MAJOR]` / `[UNS MINOR]` (unsatisfied, severity-tagged), or `[UNV]` (unverified). Inherited constraints are marked with a trailing ` *`.
- Fix-attempt process-modal rows append `[Nc]` to indicate the number of constraints the fix is targeting.
- The selected-chain summary line shows satisfied/total/inherited counts.
- Controller-flagged synthetic issues (raised by the workflow controller rather than a reviewer) render above reviewer issues under a `[CRITICAL]` "Controller flags" header.
- The agent-detail modal surfaces the `systemPromptAddendum` field from the agent record when it contains a WRFC engineer addendum, so the full constraint injection is visible without leaving the TUI.
- When constraints are loaded, the system-message router emits a `WORKFLOW_CONSTRAINTS_ENUMERATED` operator-visible message. This is routed through the standard `ui.wrfcMessages` setting (`panel`, `conversation`, or `both`).

The `/wrfc` command opens the chain-status view directly. Constraint counts are also visible in the orchestration panel and in `/wrfc` output without opening the full panel.

Each chain row and the selected-chain summary also show elapsed time (active chains, since `createdAt`) or total duration (terminal chains, `createdAt` to `completedAt`). Press `a` on a selected chain to jump straight to its owner agent in the Inspector panel. When an expanded chain's detail exceeds the panel's per-chain line cap, the truncated tail is replaced with a `+N more` indicator instead of being silently dropped.

The panel's empty state points at the actual chain producer, `/teamwork create-mode <mode> <title>` (modes with `reviewMode: wrfc` — see `/teamwork modes`), rather than a `/wrfc run` command that does not exist.

## Live TTS commands

`/tts <prompt>` submits a normal chat turn and adds live spoken output for that one turn. Text still renders normally in the transcript. Assistant deltas are chunked at sentence or phrase boundaries and streamed through the configured TTS provider.

`/tts stop` cancels active playback and pending TTS requests without deleting the text response.

`/config tts` opens the TTS category in the fullscreen configuration workspace. It manages the defaults used by spoken-output clients:

- `tts.provider`
- `tts.voice`
- `tts.llmProvider`
- `tts.llmModel`

Use the `tts.provider` row to choose a provider with streaming TTS support, the `tts.voice` row to choose a voice, and the `tts.llmProvider` / `tts.llmModel` rows to choose an optional `/tts` response model override through the fullscreen provider/model workspace. Without that override, `/tts` uses the current chat provider/model. Live local playback requires `mpv` or `ffplay` on `PATH`.

## Cloudflare batch commands

Cloudflare integration is optional and keeps local immediate daemon behavior by default. Select `Use Cloudflare for batch or remote daemon work` in onboarding to configure it visually, or use `/cloudflare` for runtime actions.

High-signal commands:

- `/cloudflare status`
- `/cloudflare requirements`
- `/cloudflare create-token --account <account-id> --bootstrap-env <ENV_NAME>`
- `/cloudflare discover`
- `/cloudflare validate`
- `/cloudflare provision --batch-mode explicit`
- `/cloudflare verify`
- `/cloudflare disable`

The TUI calls SDK daemon routes only. It does not call Cloudflare APIs directly. See [Cloudflare batch and control plane](cloudflare-batch.md) for token setup, supported components, and provisioning behavior.

## Workflow-oriented commands

Some command families are especially important when you are running GoodVibes as an operational console rather than just a chat surface:

- `/workflow` for WRFC and related execution chains
- `/schedule` for cron-like and interval-based automation
- `/hooks` for managed hook inspection and simulation
- `/remote` for dispatching and recovering distributed work
- `/sandbox` for isolation review and QEMU/bootstrap flows

For QEMU guest bootstrapping details, including the generated image script and guest runtime package list, see [QEMU sandbox bootstrapping](qemu-sandbox.md).

## CLI session lifecycle flags

Three flags control which session is active when the TUI opens:

- `--continue` — resumes the most recently active session for the current working directory (reads the last-session pointer file; does nothing when no pointer exists).
- `--resume [id]`, `-r [id]` — resumes a specific session by id. When the id is omitted, resolves via the same last-session pointer as `--continue`.
- `--fork [id]` — forks a session into a new branch. Bare `--fork` forks the session already active when the TUI starts; `--fork <id>` resumes the named session first, then forks it.

Only one of `--continue`, `--resume`, and `--fork` may be used in a single invocation. Combining them is an error.

When a session is resumed, the TUI prints `Resumed session: <id>` with message count and model to the transcript. When a session is forked, it prints `Session forked:` with the new id, fork name, source title, and message count.

A session that crashed before saving is offered back through the startup recovery modal instead of any of these flags — see [the startup recovery modal](getting-started.md#the-startup-recovery-modal).

See [CLI flags reference](cli-flags.md) for full syntax, inline-value forms, and examples.

## Related docs

- [Getting started](getting-started.md)
- [CLI flags reference](cli-flags.md)
- [/share — session export](share-command.md)
- [Deployment and services](deployment-and-services.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
- [Project planning](project-planning.md)
