# goodvibes-tui

A terminal UI coding agent substrate built with Bun. Multi-provider LLM support, 12 built-in tools, a cell-based renderer, an agent system, a hook system, and MCP integration.

Version: **0.9.0**

<!-- screenshot -->

---

## What is this

goodvibes-tui is a coding agent TUI in the same space as Claude Code, Gemini CLI, and Codex — but designed as a substrate you control. You run it locally, configure it however you want, and it operates entirely from your terminal.

The interface is built around a cell-based renderer that writes directly to the alternate screen buffer using raw ANSI escape sequences — no framework, no virtual DOM. Every message, tool call, diff, and code block is a typed cell that can be collapsed, bookmarked, copied, or applied inline.

The agent system runs subagents in-process, each with its own conversation history, scoped tool registry, and optional git worktree. An inter-agent message bus allows agents to communicate. The hook system fires lifecycle events on every tool call, git operation, LLM exchange, and more — and routes them to shell commands, HTTP endpoints, prompt-based handlers, or TypeScript modules.

---

## Features

### Multi-Provider LLM Support
- Anthropic, OpenAI, Google Gemini, and InceptionLabs (diffusion LLM)
- Hot-swap models mid-conversation with `/model` or the interactive model picker
- Per-provider reasoning effort control (instant / low / medium / high)
- Streaming responses with token speed display

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

### 12 Built-In Tools
Read, write, edit, find, exec, fetch, analyze, inspect, agent, state, workflow, registry.

### Agent System
- In-process subagents with isolated conversation history
- Named archetypes (engineer, reviewer, tester, researcher, general)
- Custom archetypes via `.goodvibes/agents/*.md` with YAML frontmatter
- Git worktree isolation per agent
- Inter-agent message bus with TTL auto-cleanup
- Agent detail modal and background process tracking

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

| Model | Provider | Context | Tools | Reasoning | Multimodal | Selectable |
|-------|----------|---------|-------|-----------|------------|------------|
| Mercury 2 | InceptionLabs | 32k | Yes | Yes | No | Yes |
| Mercury Edit | InceptionLabs | 32k | No | No | No | No (internal) |
| GPT-5.4 | OpenAI | 128k | Yes | Yes | Yes | Yes |
| GPT-5.3 Chat (latest) | OpenAI | 128k | Yes | Yes | Yes | Yes |
| GPT-5 Mini | OpenAI | 128k | Yes | No | Yes | Yes |
| GPT-5 Nano | OpenAI | 32k | Yes | No | No | Yes |
| GPT OSS 120B | OpenAI | 128k | Yes | No | No | Yes |
| Gemini 3.1 Pro (preview) | Gemini | 1M | Yes | Yes | Yes | Yes |
| Gemini 3 Flash | Gemini | 1M | Yes | No | Yes | Yes |
| Gemini 3.1 Flash Lite (preview) | Gemini | 128k | Yes | No | No | Yes |
| Gemini 2.5 Pro | Gemini | 1M | Yes | Yes | Yes | Yes |
| Claude Opus 4.6 | Anthropic | 1M | Yes | Yes | Yes | Yes |
| Claude Sonnet 4.6 | Anthropic | 1M | Yes | Yes | Yes | Yes |
| Claude Haiku 4.5 | Anthropic | 200k | Yes | No | Yes | Yes |

Mercury 2 supports configurable reasoning effort levels: `instant`, `low`, `medium`, `high`.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later

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
    "inceptionlabs": "il-..."
  }
}
```

Or set environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `INCEPTIONLABS_API_KEY`.

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
| `provider.model` | `mercury-2` | Active model ID |
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

| Tool | Description |
|------|-------------|
| `read` | Read files with multiple extract modes: content, outline, symbols, AST, or line ranges. Supports images, PDFs, and Jupyter notebooks. Batched reads in a single call. |
| `write` | Write files to disk. Supports batch writes, overwrite modes, and auto-heal on validation failure. |
| `edit` | Apply targeted edits to existing files using exact, fuzzy, regex, or AST matching. Atomic transaction support with rollback. |
| `find` | Search the codebase with glob patterns, regex content search, or symbol extraction. Supports multiple queries per call. |
| `exec` | Run shell commands. Sequential or parallel execution, progress tracking, background processes, retry, and fail-fast. |
| `fetch` | HTTP fetch with batch URL support. Extract modes: raw, text, JSON, markdown, structured (CSS selectors), tables, PDF. Service registry auth. |
| `analyze` | Multi-mode code analysis: impact (blast radius), dependencies, dead code, security, coverage, breaking changes, semantic diff, upgrade compatibility. |
| `inspect` | Project-level inspection: API spec generation and validation, database schema, frontend component state, render triggers, layout hierarchy, accessibility, responsive breakpoints, and more. |
| `agent` | Spawn and manage in-process subagents. Modes: spawn, status, cancel, list, get, budget, plan, wait, message. |
| `state` | Session-scoped key-value store with analytics, telemetry, hook management, output mode switching, context inspection, and memory operations. |
| `workflow` | Workflow state machines, automation triggers, and scheduled tasks. Start, transition, cancel, and monitor workflow instances. |
| `registry` | Search and introspect the tool registry. Fuzzy search by name, path, or description. Retrieve tool schemas and dependency info. |

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

## Architecture

```
src/
├── main.ts              — Entry point: terminal setup, event loop, alt-screen lifecycle
├── core/
│   └── orchestrator.ts  — Main conversation loop, tool dispatch, streaming
├── providers/
│   ├── registry.ts      — MODEL_REGISTRY, ProviderRegistry
│   ├── anthropic.ts     — Anthropic SDK adapter
│   ├── openai.ts        — OpenAI SDK adapter
│   ├── openai-compat.ts — OpenAI-compatible endpoint adapter (InceptionLabs)
│   └── gemini.ts        — Google Gemini adapter
├── tools/               — 12 built-in tools (read/write/edit/find/exec/fetch/analyze/inspect/agent/state/workflow/registry)
├── agents/
│   ├── orchestrator.ts  — In-process agent runner with turn loop
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
└── git/                 — GitService wrapping simple-git
```

### Key Design Decisions

- **Bun runtime** — native TypeScript execution, fast startup, built-in test runner
- **Raw ANSI renderer** — no framework dependency in the rendering path, direct control over every byte sent to the terminal
- **In-process agents** — agents share the same process and memory, avoiding IPC overhead while maintaining isolation through scoped registries and namespaced state
- **Tree-sitter for code intelligence** — TypeScript, JavaScript, Python, JSON, and CSS grammars for structural analysis, outline extraction, and AST-level edits
- **SQL.js for analytics** — WASM SQLite for in-process tool call telemetry without a database server

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
