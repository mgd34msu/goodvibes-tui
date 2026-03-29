# goodvibes-tui

A terminal AI coding agent with automated write-review-fix-check pipelines, multi-provider LLM support, and a vaporwave aesthetic.

Version: **0.9.11**

<!-- screenshot -->

---

## What is this

goodvibes-tui is a coding agent TUI in the same space as Claude Code, Gemini CLI, and Codex — but you run it locally, configure it however you want, and it operates entirely from your terminal.

The interface is built around a cell-based renderer that writes directly to the alternate screen buffer using raw ANSI escape sequences — no framework, no virtual DOM. Every message, tool call, diff, and code block is a typed cell that can be collapsed, bookmarked, copied, or applied inline.

The agent system runs subagents in-process, each with its own conversation history, scoped tool registry, and optional git worktree. An inter-agent message bus allows agents to communicate. The hook system fires lifecycle events on every tool call, git operation, LLM exchange, and more — and routes them to shell commands, HTTP endpoints, prompt-based handlers, or TypeScript modules.

---

## Features

### Multi-Provider LLM Support
- Native provider adapters: Anthropic, OpenAI, Google Gemini, and InceptionLabs (diffusion LLM)
- **15+ auto-registerable providers** — Groq, Cerebras, Mistral, Ollama Cloud, NVIDIA NIM, HuggingFace, LLM7, OpenRouter, AIHubMix, and more
- **Dynamic catalog** — 4,102 models from 105 providers sourced from models.dev with 24h TTL cache; set an env var and the provider auto-configures
- **Custom providers**: add any OpenAI-compatible API via JSON config in `~/.goodvibes/tui/providers/`
- Hot-reload: provider configs are watched and reloaded automatically on change
- Hot-swap models mid-conversation with `/model` or the interactive model picker
- Per-provider reasoning effort control (instant / low / medium / high)
- Streaming responses with token speed display
- Interactive `/add-provider` skill for guided setup

### Dynamic Model Catalog
- Models sourced from models.dev (4,102 models, 105 providers) with 24h TTL cache
- Benchmark integration from ZeroEval (275 models, 22 scoring dimensions)
- Auto-provider registration — set an env var, the provider appears automatically
- Catalog-driven SyntheticProvider with tier-isolated failover (free/paid/subscription tiers never mix)
- `best-free` synthetic model — always resolves to the highest-benchmarked free model with a configured key
- Change notifications when catalog refreshes, filtered to your favorites and top-benchmarked models

### Model Picker
- Pricing tier filter: Free / Paid / Subscription / All
- Family grouping: GPT, Claude, Gemini, Llama, Qwen, GLM, MiniMax, DeepSeek, and more
- Capability filters: Reasoning, Tool Use, Structured Output, Multimodal, Open Weights
- Available-only toggle (default on) — hides models without a configured key
- Benchmark sort: SWE-bench, GPQA, composite score
- Quality tier badges [S/A/B/C] displayed next to model names
- Pinned/favorite models shown at top with star indicator
- Synthetic model grouping: "Top Models" (A/S-tier benchmark) and "All Synthetic"
- Provider count per synthetic model (e.g., "4 providers")
- Provider search mode with Configured/Popular/All grouping

### Favorites & Usage Tracking
- `/pin` and `/unpin` to star models as favorites
- Usage history tracking (model, timestamp, count) persists across sessions
- Favorites surface at the top of the model picker automatically

### Cell-Based TUI Renderer
- Raw ANSI escape sequences — no Ink, no React
- Alternate screen buffer, mouse support, bracketed paste
- Markdown rendering with syntax highlighting
- Inline diff viewer with one-keystroke apply (`Ctrl+A`)
- Collapsible blocks — tool calls, thinking traces, code blocks
- Bookmarks, block copy (`Ctrl+Y`), block save to file (`Ctrl+S`)
- Conversation search overlay (`Ctrl+F`)
- File picker overlay with fuzzy search and Tab completion
- Git status in header (branch, dirty indicator, ahead/behind)
- Background process indicator and live-tail modal

### Sidebar Panels
- 20+ built-in panels: File Explorer, Git, Diff, Symbol Outline, Agent Inspector, Cost Tracker, Debug, Context Visualizer, WRFC Chain Viewer, Plan Dashboard, Provider Health, Session Browser, and more
- Split-pane layout with top/bottom panes and resizable divider
- Panel picker overlay with category grouping and search
- Toggle with `/panel` or keyboard shortcut

### Session & Profile Management
- JSONL session files with auto-save on every turn and crash recovery
- `/save`, `/load`, `/sessions` for named session management
- Session search across all saved conversations
- Named config profiles via `/profiles` — save and load display/provider/behavior settings
- Session browser panel with resume support

### Export
- Export conversations as Markdown, JSON, or self-contained HTML
- Sensitive data redaction (API keys, file paths, tokens)
- Token usage summaries and cost tracking in exports

### Local LLM Auto-Discovery
- Network scanner probes localhost and local subnets for LLM servers
- Detects Ollama, LM Studio, vLLM, llama.cpp, LocalAI, TGI, Jan, GPT4All, KoboldCPP, Aphrodite
- Auto-registers discovered servers with dynamic context window and output limit detection
- Persists discovered providers across sessions; reconciles on background re-scan

### 12 Built-In Tools
Read, write, edit, find, exec, fetch, analyze, inspect, agent, state, workflow, registry.
Language intelligence powered by bundled LSP servers (TypeScript, Python, Bash, CSS, HTML, JSON) and tree-sitter grammars — no manual setup required. Rust and Go LSP servers auto-download on first use.

### Agent System
- In-process subagents with isolated conversation history
- Named archetypes (engineer, reviewer, tester, researcher, general)
- Custom archetypes via `.goodvibes/agents/*.md` with YAML frontmatter
- Git worktree isolation per agent
- Inter-agent message bus with TTL auto-cleanup
- Agent detail modal and background process tracking

### Automated WRFC Review Chains
- **Work → Review → Fix → Check** — every agent spawns an automated quality chain
- 10-dimension reviewer with scored rubric (Correctness, Type Safety, Error Handling, Security, Performance, Code Quality, Testing, Documentation, Completeness, Integration)
- Configurable minimum score threshold (default 9.9/10)
- Automated fix cycles: fixer agent receives full issue list with point values
- Quality gates after review: typecheck, lint, test, build (configurable)
- Gate failures spawn new chains automatically
- Auto-commit on chain completion via git worktree merge
- `skipWrfc` flag for utility agents that don't need review

### Hook System
- 5 lifecycle phases: Pre, Post, Fail, Change, Lifecycle
- 5 hook types: command, prompt, agent, http, ts
- 12 event categories: tool, file, git, agent, compact, llm, mcp, config, budget, session, workflow
- Multi-event chains with temporal matching, debounce, and conditions
- Async hooks that run without blocking the main conversation

### MCP Integration
- Connect to any MCP server via `.goodvibes/mcp.json`
- JSON-RPC 2.0 over stdio, auto-restart on crash
- Progressive schema loading — names at startup, full schemas on first use
- Tools appear in the main tool registry as `mcp:<server>:<tool>`

### Permissions & Security
- Three modes: `prompt`, `allow-all`, `custom`
- Per-tool permission overrides (`allow`, `prompt`, `deny`)
- Encrypted secret storage (AES-256-GCM) via `/secrets`
- Spawn tokens with HMAC + 1-hour TTL
- HTTP listener with bearer auth, rate limiting, and localhost enforcement

### Configuration
- Live config editing via `/config` or `/settings` modal
- Named profiles for saving and loading config sets
- Prompt templates system with save, browse, and execute
- Session persistence with save/load/list

---

## Supported Providers & Models

Models are sourced dynamically from [models.dev](https://models.dev) — the catalog contains 4,000+ models from 105+ providers. Set an API key and the models appear automatically.

Example models (sourced dynamically from models.dev):

| Model | Provider | Context | Tools | Reasoning | Multimodal |
|-------|----------|---------|-------|-----------|------------|
| Mercury 2 | InceptionLabs | 32k | Yes | Yes | No |
| GPT-5.3 Chat (latest) | OpenAI | 128k | Yes | Yes | Yes |
| Gemini 3.1 Pro (preview) | Gemini | 1M | Yes | Yes | Yes |
| Claude Opus 4.6 | Anthropic | 1M | Yes | Yes | Yes |
| Claude Sonnet 4.6 | Anthropic | 1M | Yes | Yes | Yes |
| Gemini 2.5 Pro | Gemini | 1M | Yes | Yes | Yes |

Mercury 2 supports configurable reasoning effort levels: `instant`, `low`, `medium`, `high`.

### Custom Providers

Any OpenAI-compatible API can be added by dropping a JSON file in `~/.goodvibes/tui/providers/`:

```json
{
  "name": "openrouter",
  "displayName": "OpenRouter",
  "type": "openai-compat",
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "models": [
    {
      "id": "anthropic/claude-sonnet-4-6",
      "displayName": "Claude Sonnet 4.6 (via OpenRouter)",
      "description": "Anthropic Claude Sonnet 4.6 via OpenRouter",
      "contextWindow": 200000,
      "capabilities": {
        "toolCalling": true,
        "codeEditing": true,
        "reasoning": true,
        "multimodal": true
      }
    }
  ]
}
```

Provider configs are hot-reloaded on file change. Use the `/add-provider` skill for interactive guided setup with smart defaults for popular providers.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- **Optional**: [Go](https://go.dev) for Go LSP support (gopls auto-installs via `go install`)
- **Optional**: For Rust development, `rust-analyzer` is auto-downloaded from GitHub releases (no Rust toolchain required)

### Install

```sh
git clone <repo-url> goodvibes-tui
cd goodvibes-tui
bun install
```

### Configure API Keys

API keys can be set in `.goodvibes/config.json`, via environment variables, or stored encrypted using the `/secrets` command.

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "gemini": "AIza...",
    "groq": "gsk_...",
    "mistral": "..."
  }
}
```

Or set environment variables:

| Provider | Environment Variable | Type |
|----------|---------------------|------|
| Anthropic | `ANTHROPIC_API_KEY` | Paid |
| OpenAI | `OPENAI_API_KEY` | Paid |
| Google Gemini | `GEMINI_API_KEY` | Paid |
| InceptionLabs | `INCEPTION_API_KEY` | Paid |
| Mistral | `MISTRAL_API_KEY` | Paid |
| OpenRouter | `OPENROUTER_API_KEY` | Free tier available |
| Groq | `GROQ_API_KEY` | Free (LPU inference) |
| Cerebras | `CEREBRAS_API_KEY` | Free (wafer-scale inference) |
| AIHubMix | `AIHUBMIX_API_KEY` | Free tier (rate-limited) |
| HuggingFace | `HF_API_KEY` | Free tier (rate-limited) |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | Free |
| NVIDIA NIM | `NVIDIA_API_KEY` | 1000 free credits |
| LLM7 | `LLM7_API_KEY` | Free |

### Synthetic Failover Provider

The `synthetic` provider groups models available from multiple backends. When one provider hits a rate limit, requests automatically failover to the next — no user intervention needed. To enable failover, set API keys for multiple free providers:

```sh
# Recommended minimum for failover
export GROQ_API_KEY="..."
export HF_API_KEY="..."
export NVIDIA_API_KEY="..."
export OLLAMA_CLOUD_API_KEY="..."
export OPENROUTER_API_KEY="..."
export AIHUBMIX_API_KEY="..."
```

Then select any model from the `synthetic` provider (e.g., `gpt-oss-120b`, `kimi-k2.5`, `qwen-3.5-397b`). See [Synthetic Provider & Intelligent Failover](#synthetic-provider--intelligent-failover) for full details on failover behavior.

### Run

```sh
bun run dev
```

### Build a standalone binary

```sh
bun run build
# outputs dist/goodvibes
```

---

## Synthetic Provider & Intelligent Failover

### What are synthetic models?

Synthetic models are models available from multiple providers, automatically grouped by the system under a single selectable entry. When you pick a synthetic model, the system routes your request to the best available backend — you never need to think about which provider is serving it.

- Models with different naming across providers (e.g., `GPT-4o` vs `gpt 4o`) are automatically merged into one entry
- Each synthetic model shows how many providers are available for failover in the model picker

### Transparent failover

Failover happens automatically, with no user action required:

- **Rate limit (429)** — immediately retries the next provider in the pool
- **Server error (500) or network error** — retries the next provider after a 5-second cooldown
- **Client error (400 Bad Request)** — does NOT trigger failover; the error indicates a problem with the request itself, not the provider
- **All providers temporarily exhausted with short cooldowns (≤120s)** — the system automatically waits for the shortest cooldown to expire and retries

Failover is silent by default. The model name in the status bar does not change when switching backends for the same synthetic model.

### Cross-model failover (free models only)

When every provider for a free synthetic model is exhausted and cooldowns are too long to wait:

- The system automatically falls back to the next-best free model, ranked by benchmark score
- The user is notified inline (non-blocking) about the model change
- This cascading continues until a working free model is found
- Free/paid/subscription tiers never mix — cross-model failover only happens within the free tier

### Paid and subscription model exhaustion

Paid and subscription models do **not** auto-failover to a different model. The user made a deliberate, cost-conscious choice.

When a paid or subscription model is exhausted, the system shows a clear message with recovery options:

- Wait for the cooldown to expire and retry
- Switch to a different model with `/model`
- Switch to a free synthetic model

### Model picker grouping

- Synthetic models are split into **Top Models** (S-tier or A-tier by benchmark) and **All Synthetic**
- Each entry shows the number of providers available (e.g., `4 providers`)
- Quality tier badges [S/A/B/C] are displayed next to model names based on composite benchmark score

---

## Configuration

Configuration is stored in `.goodvibes/config.json` in the current working directory. You can view and edit all settings live using `/config` or the `/settings` modal.

### Key Settings

| Key | Default | Description |
|-----|---------|-------------|
| `display.stream` | `true` | Stream responses token by token |
| `display.lineNumbers` | `false` | Show line numbers in code blocks |
| `display.collapseThreshold` | `30` | Lines before a block auto-collapses |
| `display.theme` | `vaporwave` | Color theme |
| `display.showThinking` | `false` | Show model thinking traces |
| `display.showTokenSpeed` | `false` | Show tokens/sec in status bar |
| `provider.model` | `openrouter/free` | Active model ID |
| `provider.reasoningEffort` | `medium` | Reasoning depth for supported models |
| `provider.systemPromptFile` | `` | Path to a custom system prompt file |
| `behavior.autoApprove` | `false` | Auto-approve all tool permission prompts |
| `behavior.autoCompactThreshold` | `80` | Context % before auto-compact triggers |
| `behavior.saveHistory` | `true` | Persist conversation history |
| `permissions.mode` | `prompt` | Permission mode: `prompt`, `allow-all`, `custom` |
| `danger.agentRecursion` | `false` | Allow agents to spawn subagents |
| `danger.maxGlobalAgents` | `8` | Max simultaneous agents |
| `danger.daemon` | `false` | Enable daemon mode (POST /task) |
| `danger.httpListener` | `false` | Enable HTTP webhook listener |
| `tools.autoHeal` | `false` | Auto-fix syntax errors on write/edit |
| `tools.hooksFile` | `hooks.json` | Hook configuration file name |

### Permission Modes

- **`prompt`** (default) — ask before write, edit, exec, fetch, agent, workflow, and MCP calls
- **`allow-all`** — never prompt, allow everything
- **`custom`** — per-tool overrides using `permissions.tools.<name>` keys

Per-tool values: `allow`, `prompt`, `deny`.

---

## Tools

goodvibes-tui ships 12 built-in tools that go well beyond the read/write/exec primitives found in Claude Code, Gemini CLI, and Codex. Each tool is designed for agentic workloads: batch operations, token-efficient extraction, structural code understanding, and composable automation — not just wrapping shell commands.

### read

Read files with token-efficient extraction modes. Not just cat-to-context.

- 5 extract modes: `content` (full text), `outline` (signatures only, significant token savings), `symbols` (exported names, even greater savings), `ast` (structural), `lines` (specific ranges)
- Tree-sitter powered outline and symbol extraction with regex fallback
- Token-budget pagination for large batch reads — request N files, get pages that fit within a budget
- Built-in image, PDF, and Jupyter notebook reading
- Per-file caching with optimistic concurrency control (OCC) conflict detection — tracks what you've read and warns if it changed externally

### write

Write files with atomic operations, backup modes, and auto-heal.

- Atomic writes via temp file + rename — no partial writes on crash
- Three overwrite modes: `fail_if_exists`, `overwrite`, `backup` (copies original to `.goodvibes/.backups/`)
- Auto-heal pipeline: if a written file has syntax errors and `tools.autoHeal` is enabled, runs formatter → linter → LLM fix automatically
- Base64 content support for files with special characters
- Batch writes in a single call with per-file mode control

### edit

Structural code editing with AST matching, scope hints, and transactional rollback.

- 5 match modes: `exact`, `fuzzy` (whitespace-insensitive), `regex` (with capture groups), `ast` (tree-sitter structural), `ast_pattern` (ast-grep with metavariables like `$VAR` and `$$$ARGS`)
- Scope hints: `in_function`, `in_class`, `near_line` — disambiguate matches without increasing context
- Occurrence selection: `first`, `last`, `all`, or specific Nth occurrence — with ambiguity guard by default
- Atomic transactions: all edits succeed or all roll back. Also supports `partial` and `none` modes
- Pre/post validation: run `typecheck`, `lint`, `test`, or `build` before and after edits — auto-rollback on failure
- Auto-heal on validation failure (same pipeline as write)

### find

Multi-mode search: files, content, symbols, references, and structural AST patterns.

- 5 search modes in one tool: `files` (glob), `content` (regex grep), `symbols` (exported declarations), `references` (find all references via LSP with grep fallback), `structural` (AST pattern matching via ast-grep)
- Structural search uses ast-grep to find code patterns like `console.log($$$ARGS)` across TypeScript, JavaScript, CSS, and HTML
- Scope expansion: expand content matches to their enclosing `function` or `class` using tree-sitter
- Multiple queries per call executed in parallel
- Progressive output: `count_only` → `files_only` → `locations` → `matches` → `context`

### exec

Shell execution with background processes, retry, progress tracking, and file operations.

- Background execution with process tracking — spawn, poll status, read output, kill
- Retry with exponential backoff on transient failures
- `until` pattern: watch stdout for a regex match, then stop or promote to background
- Pre-command file operations: copy, move, delete files before running commands
- Progress file streaming for long-running commands (auto-enabled above 30s)
- Fail-fast mode: stop sequential execution on first failure, report remaining as skipped

### fetch

HTTP client with extraction modes, service registry auth, and batch operations.

- 11 extraction modes: `raw`, `text`, `json`, `markdown`, `readable` (strips nav/sidebar/footer), `code_blocks`, `links`, `tables`, `metadata` (og-tags), `structured` (CSS selectors), `pdf`
- Named service registry: configure API credentials once in `.goodvibes/tui/services.json`, reference by name in fetch calls
- Inline auth: `bearer`, `basic`, `api-key` per-request
- Batch parallel fetches in a single tool call

### analyze

14-mode code analysis suite — from impact analysis to upgrade compatibility.

- `impact`: trace exported symbols across the project to find what breaks when you change a file
- `dependencies`: build import graph, detect circular dependencies, list external packages
- `dead_code`: find exported symbols with zero references outside their own file
- `security`: scan for hardcoded secrets, world-writable files, and missing .env keys
- `breaking`: compare git refs and detect removed/changed export signatures
- `semantic_diff`: LLM-powered diff summary with risk assessment (low/medium/high)
- `upgrade`: check npm registry for outdated packages and flag breaking version bumps
- Also: `coverage` (lcov/istanbul parse), `bundle` (stats.json), `surface` (public API), `preview` (dry-run edit), `diff` (git ref diff), `permissions` (dangerous pattern scan), `env_audit` (.env key comparison), `test_find` (locate test files for source files)

### inspect

21-mode project and frontend inspection tool.

- `project`: detect project type, package manager, test framework, entry points, monorepo status
- `api` + `api_spec` + `api_validate` + `api_sync`: discover API routes across Next.js (App + Pages Router), Express, Fastify, and Hono → generate OpenAPI 3.0 specs → validate specs against code → detect frontend/backend drift by scanning fetch() calls
- `database`: parse Prisma schemas into structured model/field/relation data
- `components`: extract React component tree with props, hooks, and child components
- `scaffold`: generate module skeleton (types, implementation, tests, barrel export) with dry-run
- Frontend analysis: `layout` (CSS/Tailwind layout hierarchy), `accessibility` (a11y issue detection), `component_state` (useState/useReducer/useContext tracing), `render_triggers` (what causes re-renders), `hooks` (dependency array auditing with missing-dep detection), `overflow`/`sizing`/`stacking` (CSS issue detection), `responsive` (Tailwind breakpoint analysis), `events` (handler analysis), `tailwind` (class conflict detection), `client_boundary` (Next.js directive analysis), `error_boundary` (coverage analysis)

### agent

In-process subagent system with 10 management modes.

- Spawn agents from named archetypes (`engineer`, `reviewer`, `tester`, `researcher`, `general`) or custom archetypes from `.goodvibes/agents/*.md`
- Full lifecycle management: `spawn`, `status`, `cancel`, `list`, `get` (detailed view with recent messages), `wait` (block until completion with timeout)
- Inter-agent messaging via `message` mode
- Token budget estimation via `budget` mode
- Execution plan introspection via `plan` mode
- Git worktree isolation: each agent can work in its own branch, merged back on completion

### state

Session state, persistent memory, telemetry, hooks, and output modes — all in one tool.

- KV state: session-scoped key-value store with atomic persistence
- Persistent memory: read/write `.goodvibes/memory/` files that survive across sessions
- Hook management: list, enable, disable, add, and remove hooks at runtime
- Output mode switching: switch between `default`, `vibecoding`, and `justvibes` verbosity presets
- Analytics: record tool calls, query by filter, export as JSON/CSV, dashboard view — backed by WASM SQLite
- Context and budget reporting for token usage awareness

### workflow

Workflow state machines, automation triggers, and scheduled tasks.

- Named workflow definitions: `wrfc` (work-review-fix cycle), `fix_loop`, `test_then_fix`, `review_only`
- State machine with validated transitions — prevents invalid state changes
- Automation triggers: fire shell commands when specific hook events occur, with optional JS conditions
- Scheduled tasks: run commands on recurring intervals (`30s`, `5m`, `1h`) with automatic process tracking
- Full lifecycle: start, transition, cancel, list active instances

### registry

Discover and introspect skills, agents, and tools.

- Fuzzy search across skills (`.goodvibes/skills/*.md`), agents (`.goodvibes/agents/*.md`), and built-in tools
- Task-based recommendations: describe what you want to do, get ranked suggestions
- Dependency chain resolution for skills
- Full content retrieval for any registry item

---

## Slash Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/model [id]` | `/m` | Select or display the current LLM model |
| `/provider [name]` | `/p` | Switch provider |
| `/effort [level]` | `/e` | Show or set reasoning effort level |
| `/config [key] [value]` | `/cfg` | Show or set config values |
| `/debug` | — | Toggle debug mode |
| `/lines` | — | Toggle line numbers on/off |
| `/expand [type]` | — | Expand blocks by type (all/thinking/tool/code) |
| `/collapse [type]` | — | Collapse blocks by type |
| `/bookmarks` | `/bm` | List bookmarked blocks |
| `/settings` | `/cfg-ui` | Open the config/settings browser modal |
| `/clear` | `/cls` | Clear the conversation display (keeps LLM context) |
| `/reset` | — | Full reset: clear display and conversation context |
| `/compact` | — | Summarize conversation to free context window |
| `/export [file]` | — | Export conversation as markdown |
| `/title [text]` | — | Show or set the conversation title |
| `/save [name]` | — | Save current session |
| `/load <name>` | — | Load a saved session |
| `/sessions` | — | List saved sessions |
| `/undo` | `/u` | Remove the last user+assistant turn |
| `/redo` | — | Restore the last undone turn |
| `/retry [text]` | `/r` | Re-send the last user message |
| `/template` | `/tmpl` | Manage and use prompt templates |
| `/tools` | `/t` | List available tools |
| `/permissions` | `/perms` | Show or set permission mode and per-tool settings |
| `/secrets` | — | Manage encrypted API key secrets (set/get/list/delete) |
| `/services` | `/svc` | Manage API service configurations |
| `/context` | `/ctx` | Inspect context window usage (token breakdown per message) |
| `/next-error` | `/ne` | Jump to the next error message in the conversation |
| `/prev-error` | `/pe` | Jump to the previous error message in the conversation |
| `/profiles` | `/profile` | Browse and load config profiles |
| `/pin [id]` | — | Pin a model as favorite |
| `/unpin [id]` | — | Remove a model from favorites |
| `/git` | — | Open git panel (initializes repo if needed) |
| `/scan` | — | Scan for local LLM servers |
| `/add-provider` | — | Interactive guided provider setup |
| `/plan [task]` | — | Create an execution plan for a multi-step task |
| `/panel` | — | Toggle sidebar panel visibility |
| `/plugin [action]` | — | Manage plugins (enable/disable/reload/list) |
| `/share [format]` | — | Export conversation (md/json/html) |
| `/branch [name]` | — | Fork, list, switch, or merge conversation branches |
| `/agents` | — | List active and completed agents |
| `/wrfc` | — | Show WRFC chain status |
| `/help` | `/h`, `/?` | Show available commands and keyboard shortcuts |
| `/quit` | `/q`, `/:q` | Exit the application |

---

## Keyboard Shortcuts

### Input & Editing

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Tab` | Toggle block collapse / path completion |
| `Ctrl+U` | Clear the prompt line |
| `Ctrl+Z` | Undo prompt edit |
| `Ctrl+Shift+Z` | Redo prompt edit |
| `Ctrl+V` | Paste (image or text) |

### Navigation

| Key | Action |
|-----|--------|
| `Arrow Up / Down` | Scroll conversation / recall input history |
| `PageUp / PageDown` | Scroll by page |
| `Mouse wheel` | Scroll |
| `Click drag` | Select text |
| `Middle click` | Paste |

### Blocks & Content

| Key | Action |
|-----|--------|
| `Ctrl+A` | Apply nearest diff to disk |
| `Ctrl+Y` | Copy nearest block to clipboard |
| `Ctrl+S` | Save nearest block to file |
| `Ctrl+B` | Bookmark nearest block |
| `Ctrl+F` | Open conversation search overlay |
| `Ctrl+L` | Clear screen |
| `Ctrl+Shift+C` | Copy selection |

### System

| Key | Action |
|-----|--------|
| `Ctrl+C` (twice) | Exit |

---

## Agent System

Agents are in-process subagents with isolated conversation history, a scoped tool registry, and optional git worktree. They run asynchronously and report back through the agent message bus.

### Built-In Archetypes

| Archetype | Tools | Description |
|-----------|-------|-------------|
| `engineer` | read, write, edit, find, exec, analyze | Full-stack implementation agent |
| `reviewer` | read, find, analyze | Code review and quality assessment |
| `tester` | read, write, find, exec | Test writing and execution |
| `researcher` | read, find, analyze, inspect | Codebase exploration and analysis |
| `general` | read, write, edit, find, exec | General purpose agent |

### Custom Archetypes

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

### Spawning an Agent

Use the `agent` tool from within a conversation:

```
spawn an engineer agent to refactor src/utils.ts
```

Or use the tool directly with the `agent` tool's spawn mode, specifying an archetype and task.

### Git Worktree Isolation

When an agent is spawned, it can be given its own git worktree. On completion, changes are merged back. On cancellation or error, the worktree is cleaned up.

---

## Hook System

Hooks fire on lifecycle events throughout a session. They are configured in `.goodvibes/hooks.json` (or a custom file set in `tools.hooksFile`).

### Event Path Format

```
Phase:Category:Specific
```

- **Phases**: `Pre`, `Post`, `Fail`, `Change`, `Lifecycle`
- **Categories**: `tool`, `file`, `git`, `agent`, `compact`, `llm`, `mcp`, `config`, `budget`, `session`, `workflow`
- Wildcards are supported: `Pre:tool:*` matches all pre-tool events

### Hook Types

| Type | Description |
|------|-------------|
| `command` | Run a shell command. Event data passed via stdin as JSON. |
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

### Hook Chains

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

---

## MCP Integration

Connect to any MCP-compatible server by adding it to `.goodvibes/mcp.json`:

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

MCP tools appear in the tool registry as `mcp:<server-name>:<tool-name>`. Tool schemas are loaded progressively — names and descriptions at startup, full parameter schemas on first use. Connections are auto-restarted on crash.

MCP tool calls respect the `permissions.tools.mcp` setting (default: `prompt`).

---

## Plugin System

Extend goodvibes-tui with custom plugins. Place plugin folders in `~/.goodvibes/tui/plugins/`:

Each plugin has a `manifest.json` and an entry file (default: `index.ts`):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin"
}
```

Plugins receive a sandboxed API with:
- `registerCommand()` — add custom slash commands
- `registerProvider()` — add OpenAI-compatible LLM providers
- `registerTool()` — add custom tools available to the LLM
- `onEvent()` — subscribe to EventBus events
- `getConfig()` — read plugin-specific settings

Manage via `/plugin enable|disable|reload|list`.

---

## Architecture

```
src/
├── main.ts              — Entry point: terminal setup, event loop, alt-screen lifecycle
├── core/
│   └── orchestrator.ts  — Main conversation loop, tool dispatch, streaming
├── providers/
│   ├── registry.ts      — ProviderRegistry, model selection, custom model merging
│   ├── synthetic.ts     — SyntheticProvider: cross-provider failover with tier isolation
│   ├── model-catalog.ts — Dynamic catalog from models.dev (4000+ models)
│   ├── model-benchmarks.ts — ZeroEval benchmark integration
│   ├── auto-register.ts — Env-var-based provider auto-registration
│   ├── favorites.ts     — Model pinning and usage tracking
│   ├── model-limits.ts  — OpenRouter-sourced token limits cache
│   ├── anthropic-compat.ts — Anthropic Messages API adapter (for proxies)
│   ├── tool-formats.ts  — OpenAI/Anthropic/Gemini wire format converters
│   ├── custom-loader.ts — Hot-reloadable custom provider loader
│   ├── anthropic.ts     — Anthropic SDK adapter
│   ├── openai.ts        — OpenAI SDK adapter
│   ├── openai-compat.ts — OpenAI-compatible endpoint adapter
│   └── gemini.ts        — Google Gemini adapter
├── tools/               — 12 built-in tools (read/write/edit/find/exec/fetch/analyze/inspect/agent/state/workflow/registry)
├── agents/
│   ├── orchestrator.ts  — In-process agent runner with turn loop
│   ├── wrfc-controller.ts — Automated WRFC chain state machine
│   ├── wrfc-types.ts    — WRFC chain, gate, and event types
│   ├── completion-report.ts — Structured agent output report types + parser
│   ├── archetypes.ts    — Archetype loader from .goodvibes/agents/*.md
│   ├── message-bus.ts   — Inter-agent messaging with TTL
│   ├── session.ts       — Agent session isolation
│   └── worktree.ts      — Git worktree lifecycle management
├── hooks/
│   ├── types.ts         — HookPhase, HookCategory, HookDefinition, HookChain
│   ├── dispatcher.ts    — Event firing and hook matching
│   ├── chain-engine.ts  — Multi-step chain evaluation
│   └── runners/         — command, prompt, agent, http, ts runners
├── mcp/
│   ├── client.ts        — JSON-RPC 2.0 stdio client
│   ├── config.ts        — .goodvibes/mcp.json reader
│   └── registry.ts      — McpRegistry: connect, list tools, call tools
├── renderer/            — Cell-based TUI: buffer, compositor, overlays, modals
├── input/
│   ├── commands.ts      — All slash command registrations
│   └── handler.ts       — Raw stdin input processing
├── config/
│   ├── schema.ts        — GoodVibesConfig type, ConfigKey, defaults
│   ├── index.ts         — Config loader and live-edit manager
│   └── secrets.ts       — AES-256-GCM encrypted secret storage
├── state/               — KV store, project index, file cache, mode manager, telemetry
├── permissions/         — Permission manager with per-tool enforcement
├── security/            — Spawn tokens (HMAC + TTL)
├── daemon/              — HTTP daemon server and webhook listener
├── git/                 — GitService wrapping simple-git
├── acp/                 — Agent Client Protocol (subagent child processes)
├── discovery/           — Local LLM scanner + MCP server auto-discovery
├── panels/              — 20+ sidebar panels (agent inspector, cost tracker, git, etc.)
├── integrations/        — Discord, Slack, GitHub webhook integrations
├── export/              — Markdown, JSON, HTML session export with redaction
├── plugins/             — Plugin system (manifest, loader, sandboxed API)
├── profiles/            — Named config profile save/load
├── sessions/            — JSONL session persistence and search
├── scheduler/           — Cron-based recurring task scheduler
├── bookmarks/           — Block bookmark manager
└── intelligence/        — Tree-sitter + LSP language intelligence
    ├── tree-sitter/     — WASM-based parsing and symbol extraction
    └── lsp/             — Language server protocol clients
```

### Key Design Decisions

- **Bun runtime** — native TypeScript execution, fast startup, built-in test runner
- **Raw ANSI renderer** — no framework dependency in the rendering path, direct control over every byte sent to the terminal
- **In-process agents** — agents share the same process and memory, avoiding IPC overhead while maintaining isolation through scoped registries and namespaced state
- **Tree-sitter for code intelligence** — TypeScript, JavaScript, Python, JSON, and CSS grammars for structural analysis, outline extraction, and AST-level edits
- **Bundled language servers** — TypeScript, Python, Bash, CSS, HTML, and JSON language servers ship as npm dependencies and work out of the box. Rust (`rust-analyzer`) and Go (`gopls`) are downloaded automatically on first use with SHA256 integrity verification. No manual LSP setup required.
- **SQL.js for analytics** — WASM SQLite for in-process tool call telemetry without a database server
- **Agent Client Protocol** — subagents communicate via @agentclientprotocol/sdk over stdio ndJsonStream
- **Plugin system** — manifest.json + sandboxed API surface with lifecycle hooks (init/activate/deactivate)
- **Crash recovery** — periodic JSONL snapshots with recovery prompt on next startup

---

## Development

### Run in dev mode

```sh
bun run dev
```

### Run tests

```sh
bun test
```

### Build standalone binary

```sh
bun run build
# outputs dist/goodvibes
```

### Project structure conventions

- Tool implementations live in `src/tools/<name>/index.ts`
- Tool parameter schemas live in `src/tools/<name>/schema.ts`
- Tests mirror the source tree under `src/test/`
- Runtime data (sessions, conversations, hooks, memory) lives in `.goodvibes/` in the working directory
- Agent archetypes go in `.goodvibes/agents/*.md`
- MCP server config goes in `.goodvibes/mcp.json`
- Hook config goes in `.goodvibes/hooks.json` (or the file set in `tools.hooksFile`)

---

## License

TBD
