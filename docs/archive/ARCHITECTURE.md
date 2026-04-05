# Architecture

This document describes the technical architecture of goodvibes-tui.

## Runtime Status

The legacy `EventBus` migration completed on 2026-04-04.

Current runtime architecture:

- shared runtime truth lives in the runtime store
- cross-domain signaling uses `RuntimeEventBus`
- shell and local synchronous coordination use direct controller/service calls
- the legacy `src/core/event-bus.ts` module has been deleted

## High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Terminal (TTY)                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ raw stdin / stdout
┌───────────────────────────▼─────────────────────────────────┐
│                      InputHandler                            │
│  KeyHandler ─ CommandRegistry ─ Autocomplete ─ InputHistory  │
└───────────────────────────┬─────────────────────────────────┘
                            │ direct controller calls + typed runtime/UI events
┌───────────────────────────▼─────────────────────────────────┐
│                       Orchestrator                           │
│    ConversationManager ─ ProviderRegistry ─ ToolRegistry     │
│    PermissionManager ─ HookDispatcher ─ AgentOrchestrator    │
└──────┬──────────────────────────────┬────────────────────────┘
       │                              │
       ▼ LLM Provider API             ▼ Tool Execution
┌──────────────┐               ┌──────────────────────────┐
│  Providers   │               │  Tools                   │
│  openai      │               │  read / write / edit     │
│  anthropic   │               │  exec / find / fetch     │
│  gemini      │               │  analyze / inspect       │
│  openrouter  │               │  agent / workflow        │
│  + 10 more   │               │  state / registry        │
└──────┬───────┘               └──────────────────────────┘
       │ streaming tokens
┌──────▼──────────────────────────────────────────────────────┐
│                       Compositor / Renderer                  │
│  UIFactory ─ PanelManager ─ Overlays ─ GitStatusProvider     │
└─────────────────────────────────────────────────────────────┘
```

## Core Modules

### Runtime Store And RuntimeEventBus

The runtime is coordinated through two explicit layers:

- the runtime store owns shared domain state such as conversation, permissions, tasks, agents, plugins, transport, and panels
- `RuntimeEventBus` carries typed cross-domain facts and lifecycle notifications

Local shell actions such as submit, cancel, session resume, and prompt UI are handled through direct controller/service calls rather than a global string-keyed bus.

### Orchestrator (`src/core/orchestrator.ts`)

The main conversation loop. On each turn:

1. Receives user input from the shell/controller path
2. Appends the user message to the ConversationManager
3. Calls the active LLM provider with the full conversation history and available tools
4. Streams tokens to the Compositor for live display
5. On tool call: runs the PermissionManager check, executes the tool, appends the result, and continues the LLM turn
6. On completion: triggers HookDispatcher post-turn hooks, checks auto-compact threshold, updates store state, and emits typed runtime facts

### ConversationManager (`src/core/conversation.ts`)

Manages the message history as a typed array. Provides:

- `append(message)` — add a message to history
- `undo()` / `redo()` — turn-level undo/redo
- `compact(provider, model)` — summarize history via the LLM
- `toJSON()` / `fromJSON()` — serialization for session persistence
- `rebuildHistory()` — reconstruct the API-ready message array
- `title` — mutable conversation title

### ProviderRegistry (`src/providers/registry.ts`)

Manages LLM provider instances and model selection. Built-in providers are lazily instantiated on first use.

- `setCurrentModel(id)` — switch the active model
- `getCurrentModel()` — return the active `ModelDefinition`
- `getSelectableModels()` — models shown in the picker
- `listModels()` — full model list including custom and discovered models
- `getProvider(name)` — get the `LLMProvider` instance for a provider

### ToolRegistry (`src/tools/registry.ts`)

Central registry for all tools available to the LLM. Tools are registered at startup via `registerAllTools()`. Each tool exposes:

- `definition` — JSON Schema for the tool call parameters
- `execute(args, context)` — the implementation

**Built-in tools:**

| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional line range |
| `write` | Write or overwrite a file |
| `edit` | Apply targeted find-and-replace patches |
| `exec` | Execute shell commands with approval |
| `find` | Glob/regex file and directory search |
| `fetch` | HTTP fetch for web content |
| `analyze` | Code analysis, AST inspection |
| `inspect` | Inspect runtime state and objects |
| `agent` | Spawn a background subagent |
| `workflow` | Execute multi-step workflow automation |
| `state` | Read session and runtime state |
| `registry` | Query the skill/tool registry |

### PermissionManager (`src/permissions/manager.ts`)

Intercepts tool calls and enforces the configured permission policy:

- `prompt` mode (default) — shows a permission prompt for writes, edits, exec, fetch, agent, and other sensitive operations
- `allow-all` mode — bypasses all prompts
- `custom` mode — per-tool `allow` / `prompt` / `deny` rules from config

Permission decisions are displayed via `PermissionPromptUI` as a blocking modal before the tool executes.

### AgentOrchestrator (`src/agents/orchestrator.ts`)

Manages background subagents spawned by the `agent` tool. Each agent:

1. Runs in the same process in an isolated async context
2. Has its own ConversationManager and tool context
3. Reports progress via typed runtime events and store-backed lifecycle state
4. Is tracked by AgentManager for lifecycle and state export/import

Agent recursion (agents spawning agents) is controlled by `danger.agentRecursion` and `danger.maxGlobalAgents` / `danger.maxRecursionDepth` config settings.

### Compositor / Renderer (`src/renderer/`)

The rendering layer converts the internal state into terminal output. Key components:

- **Compositor** — diffs the previous frame against the new grid and emits only the changed cells
- **UIFactory** — constructs the `Line[]` grid from conversation messages, tool output, and overlays
- **PanelManager** (`src/panels/panel-manager.ts`) — manages a sidebar panel system; built-in panels include the agent monitor and live process logs
- **Overlays** — modal dialogs (model picker, session picker, selection modal, help, shortcuts, context inspector, autocomplete)

### InputHandler (`src/input/handler.ts`)

Reads raw stdin and dispatches key events. Responsibilities:

- Parses ANSI escape sequences for function keys and mouse events
- Delegates to the `KeyHandler` for routing keys to actions
- Passes `/`-prefixed input to the `CommandRegistry`
- Manages the `InputHistory` ring buffer (Ctrl+Up / Ctrl+Down)
- Drives the `SelectionManager` for active modal interactions

### CommandRegistry (`src/input/command-registry.ts`)

Stores all registered slash commands and provides:

- `register(command)` / `unregister(name)` — command lifecycle
- `get(name)` — O(1) lookup by primary name or alias
- `fuzzyMatch(query)` — scored prefix/subsequence ranking for autocomplete
- `execute(name, args, context)` — look up and run a command

All built-in commands are registered at startup via `registerBuiltinCommands(registry)` in `src/input/commands.ts`.

### HookDispatcher (`src/hooks/dispatcher.ts`)

Runs hooks defined in `.goodvibes/tui/hooks.json` (or the file named by `tools.hooksFile` config). Hooks fire on lifecycle events such as:

- Pre/post message turn
- Tool call before/after
- Session save/load

### MCP Registry (`src/mcp/registry.ts`)

Manages connections to external Model Context Protocol (MCP) servers. MCP tools are available to the LLM alongside built-in tools.

---

## Data Flow: User Input to Response

```
1. User types message and presses Enter
   └─ InputHandler emits input:submit on EventBus

2. Orchestrator receives input:submit
   └─ Appends user message to ConversationManager

3. Orchestrator calls providerRegistry.getProvider(name).chat(request)
   └─ Request includes: messages, tools, model, systemPrompt, reasoningEffort

4. Provider streams tokens back
   └─ Compositor renders each chunk to the terminal grid

5. Provider emits a tool_call in the stream
   a. PermissionManager checks the tool against the active policy
   b. If prompt: show PermissionPromptUI, wait for user yes/no
   c. If allowed: ToolRegistry.execute(toolName, args)
   d. Tool result appended to ConversationManager as a tool message
   e. Continue the LLM turn with the updated history

6. Provider signals completion (finish_reason: stop)
   a. HookDispatcher fires post-turn hooks
   b. Auto-compact check: if usage > autoCompactThreshold, trigger /compact
   c. Notifications: bell + webhook if notifyOnComplete is set
   d. EventBus emits render:request
```

---

## Agent System

### Spawning

The LLM invokes the `agent` tool with a task description and optional constraints. The AgentOrchestrator creates a new agent instance with:

- An isolated copy of the ConversationManager
- The same ToolRegistry and PermissionManager
- A scoped EventBus that proxies to the parent bus

### Lifecycle

```
agent:spawn  →  agent runs in async loop  →  agent:complete  (or agent:error)
```

Agents can be viewed in the panel sidebar or the agent detail modal (`/panels`).

### Streaming

Agent token output is streamed to the parent conversation display in real time. Each agent's output is visually distinguished by an agent label in the conversation.

---

## Panel System

The panel sidebar provides persistent views that update without blocking the chat:

- **Agent Monitor** — lists active and completed agents with status
- **Live Tail** — streams the output of a background process

Panels are registered via `registerBuiltinPanels()` and managed by `PanelManager`. Custom panels can be added programmatically.

---

## Session Persistence

Sessions are stored as JSON at `~/.goodvibes/tui/sessions/<name>.json`. Each session file contains:

- The full message history
- Session metadata (title, model, provider, timestamp)
- Agent state records (for restoring background agent context)

The auto-save threshold is controlled by `behavior.saveHistory`. Sessions can be searched, forked, renamed, exported, and deleted via the `/session` command family.

---

## Intelligence Layer

- **LSP Integration** (`src/intelligence/lsp/`) — connects to language servers (TypeScript, Bash, Pyright, CSS/HTML/JSON) for editor-like features
- **Tree-sitter** (`src/intelligence/tree-sitter/`) — AST parsing for code analysis tools
- **Discovery / Scanner** (`src/discovery/`) — scans local Ollama and other discoverable endpoints for models
