# GoodVibes TUI: 4.8 to 10.0 Implementation Plan

> A coding agent TUI substrate modeled after Gemini CLI, Codex CLI, and Claude Code.
> Built with Bun + raw ANSI. No React/Ink. The TUI IS the orchestrator.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Phase 0: Security & Hygiene](#phase-0-security--hygiene)
3. [Phase 1: Architecture Redesign](#phase-1-architecture-redesign)
4. [Phase 2: Agent Core & Tool System](#phase-2-agent-core--tool-system)
5. [Phase 3: ACP Integration](#phase-3-acp-integration)
6. [Phase 4: Provider Abstraction](#phase-4-provider-abstraction)
7. [Phase 5: Structured Rendering](#phase-5-structured-rendering)
8. [Phase 6: Permission Model](#phase-6-permission-model)
9. [Phase 7: Error Handling & Resilience](#phase-7-error-handling--resilience)
10. [Phase 8: Testing](#phase-8-testing)
11. [Phase 9: UX Polish & Slash Commands](#phase-9-ux-polish--slash-commands)
12. [Dependency Graph](#dependency-graph)
13. [Complexity Summary](#complexity-summary)
14. [Sprint Plan](#sprint-plan)

---

## Architecture Overview

### The Substrate Model

The TUI is the **substrate** -- the runtime environment within which everything is orchestrated and communicated to the user. It is not a client, not a shell around something else. It IS the thing.

- The orchestrator runs INSIDE it
- Subagents are spawned FROM it (via ACP)
- Tool calls execute THROUGH it
- Results render WITHIN it
- The user interacts WITH it

Think of it like Claude Code: the main process IS the orchestrator AND the UI. It makes LLM calls, decides what to do, executes tools, and renders everything -- all in one process. When work is too complex or parallelizable, it spawns subagents via ACP that run as child processes and report back.

### Core Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    GoodVibes TUI Process                         │
│                                                                  │
│  ┌──────────┐   ┌───────────────┐   ┌──────────────┐            │
│  │  Input    │──>│  Orchestrator │──>│   Renderer   │──> stdout  │
│  │  Handler  │   │  (Agent Loop) │   │   Pipeline   │            │
│  └──────────┘   └───────┬───────┘   └──────▲───────┘            │
│                         │                  │                     │
│              ┌──────────┼──────────┐       │                     │
│              │          │          │       │                     │
│              ▼          ▼          ▼       │                     │
│        ┌──────────┐ ┌────────┐ ┌──────┐   │                     │
│        │ LLM Call │ │  Tool  │ │ ACP  │   │                     │
│        │ Provider │ │ System │ │ Mgr  │   │                     │
│        └──────────┘ └────────┘ └──┬───┘   │                     │
│                         │        │        │                     │
│                         │        │        │                     │
│                    ┌────┴────┐   │   ┌────┴──────┐              │
│                    │ In-proc │   │   │ Permission│              │
│                    │ Execute │   │   │  Manager  │              │
│                    └─────────┘   │   └───────────┘              │
│                                  │                               │
└──────────────────────────────────┼───────────────────────────────┘
                                   │ ACP (stdio)
                          ┌────────┴────────┐
                          │  Subagent 1..N  │
                          │  (child procs)  │
                          └─────────────────┘
```

### The Orchestrator Loop

This is the central control flow of the entire application:

```
1. User types a message
2. Orchestrator sends message + conversation history to LLM provider
3. LLM responds with text + tool calls (function calling)
4. For each tool call in the response:
   a. Check permissions (auto-approve reads, prompt for writes/exec)
   b. Execute tool (in-process for core tools, or delegate to subagent via ACP)
   c. Collect result
   d. Render tool call + result to screen
5. If tool calls were made, send results back to LLM (go to step 3)
6. If no tool calls, display final response text
7. Wait for next user message (go to step 1)
```

### Key Distinction from Previous Plan

The previous plan treated the TUI as an ACP *client* connecting to an *external* agent server. That was wrong. The correct model:

| Previous (Wrong) | Current (Correct) |
|---|---|
| TUI connects to external agent | TUI IS the agent/orchestrator |
| Agent owns tools, LLM, reasoning | TUI owns tools, LLM calls, agent loop |
| ACP for main agent connection | ACP for subagent delegation only |
| "Direct mode" = chat without tools | All modes have tools; providers differ |
| TUI renders what agent sends | TUI decides what to do and renders its own work |

### Target File Structure

```
src/
  main.ts                          # Entry: parse args, wire deps, start orchestrator
  config.ts                        # Config loading (CLI args, env, config file)
  types/
    index.ts                       # Re-exports
    grid.ts                        # Cell/Line types (extend with underline/italic)
    messages.ts                    # Conversation types, tool call types
    events.ts                      # Event bus types
    errors.ts                      # Typed error hierarchy
    tools.ts                       # Tool definition, call, and result types
  core/
    event-bus.ts                   # Typed pub/sub for decoupling
    orchestrator.ts                # The agent loop: input -> LLM -> tools -> render
    conversation.ts                # Conversation state + history for LLM context
  tools/
    registry.ts                    # Tool registry, discovery, schema generation
    types.ts                       # Tool interface, parameter schemas
    file-read.ts                   # Read file contents
    file-write.ts                  # Write/create files
    file-edit.ts                   # Find-and-replace edits
    shell-exec.ts                  # Execute shell commands
    grep.ts                        # Search file contents
    list-dir.ts                    # List directory contents
    glob.ts                        # Find files by pattern
  acp/
    manager.ts                     # Subagent lifecycle management
    connection.ts                  # ACP connection per subagent (spawn, stdio)
    protocol.ts                    # ACP message types and serialization
  providers/
    interface.ts                   # LLMProvider interface (with tool/function calling)
    registry.ts                    # Provider registry, config-driven selection
    openai.ts                      # OpenAI native (GPT models)
    openai-compat.ts               # OpenAI-compatible (InceptionLabs Mercury)
    anthropic.ts                   # Anthropic Messages API (Claude models)
    gemini.ts                      # Google Gemini API
    tool-formats.ts                # Per-provider function calling format converters
  permissions/
    manager.ts                     # Permission checks, session memory, auto-approve
    prompt.ts                      # Modal permission prompt UI
  input/
    tokenizer.ts                   # Raw stdin tokenizer (exists, move here)
    handler.ts                     # Input dispatch: commands, prompts, shortcuts
    command-registry.ts            # Slash command registry (name, desc, handler, aliases)
    commands.ts                    # Built-in slash command implementations
    autocomplete.ts                # Fuzzy-match autocomplete logic for command mode
    selection.ts                   # Text selection logic (extract from state.ts)
  renderer/
    buffer.ts                      # TerminalBuffer (exists, fix clone)
    compositor.ts                  # Layout engine (exists, decouple from state)
    diff.ts                        # ANSI diff engine (exists, fix resize)
    ui-factory.ts                  # UI fragments (exists, extend)
    markdown.ts                    # Markdown-to-cells renderer
    code-block.ts                  # Syntax-highlighted code blocks
    diff-view.ts                   # Unified diff rendering
    file-tree.ts                   # File tree rendering
    tool-call.ts                   # Tool call/result block rendering
    progress.ts                    # Spinners, progress bars, status indicators
    modal-menu.ts                  # Generic modal menu component (used by /model, etc.)
    autocomplete-menu.ts           # Autocomplete dropdown overlay for slash commands
    subagent-panel.ts              # Subagent activity display
  utils/
    clipboard.ts                   # (exists, add timeout)
    logger.ts                      # (exists)
    splash-lines.ts                # (exists)
    terminal-width.ts              # (exists)
    retry.ts                       # Exponential backoff
  test/
    setup.ts                       # Test harness, mocks
    core/
      orchestrator.test.ts
      conversation.test.ts
    tools/
      file-read.test.ts
      shell-exec.test.ts
      registry.test.ts
    input/
      tokenizer.test.ts
      command-registry.test.ts
      autocomplete.test.ts
    renderer/
      markdown.test.ts
      tool-call.test.ts
      diff-view.test.ts
    providers/
      openai.test.ts
      anthropic.test.ts
    acp/
      manager.test.ts
    integration/
      agent-loop.test.ts
      permission-flow.test.ts
```

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary architecture | TUI IS the orchestrator | Single process runs agent loop, tools, rendering |
| State management | Event bus + focused managers | StateManager god class must die |
| Tool execution | In-process, TUI implements core tools | Orchestrator needs file/shell/grep to function |
| Subagent delegation | ACP for spawning child agents | Parallelize complex work, same protocol |
| Provider abstraction | Multi-provider with function calling | Each provider has its own tool call format |
| Rendering | Keep cell-based pipeline | It works well, extend with structured renderers |
| Permission model | Modal prompts, category-based defaults | Reads auto-approve, writes/exec prompt user |
| Transport (subagents) | ACP over stdio | Standard protocol, spawn as child process |
| Testing | bun:test with mock LLM + mock tools | Fast, validates agent loop correctness |

---

## Phase 0: Security & Hygiene

**Priority**: IMMEDIATE
**Complexity**: S
**Dependencies**: None

### Changes

#### 0.1 Create `.gitignore`
- **File**: `.gitignore` (CREATE)
- **Content**: Standard Node ignores + `.env*`, `dist/`, `node_modules/`, `*.log`, `.goodvibes/state/`
- **Risk**: API key is currently one `git add .` from being committed

#### 0.2 Fix API Key Handling
- **File**: `src/config.ts` (CREATE)
- **Purpose**: Centralized config loading
  ```typescript
  // Load from: CLI args > env vars > .env file > config.json
  // Validate required fields, throw typed ConfigError if missing
  // Export frozen config object
  interface AppConfig {
    provider: string;          // default provider name
    model: string;             // default model
    apiKeys: Record<string, string>;  // provider -> API key
    autoApprove: boolean;      // --no-worries-just-vibes
    workingDir: string;        // cwd for tool execution
  }
  ```
- **File**: `src/core/state.ts` (MODIFY) -- replace `process.env.INCEPTION_API_KEY || ''` with config validation that throws a clear error if missing

#### 0.3 Remove Dead Code
- **File**: `src/splash.ts` (DELETE) -- duplicate of `splash-lines.ts`
- **File**: `src/main.ts` (MODIFY) -- remove unused imports

#### 0.4 Fix `expandPrompt` Infinite Loop Risk
- **File**: `src/core/state.ts` (MODIFY, lines 76-98)
- **Change**: The regex `exec` + `replace` pattern mutates the string while iterating. Replace with `String.replaceAll` or collect replacements first, apply after

#### 0.5 Fix `as any` Casts
- **File**: `src/core/inception.ts` (MODIFY, lines 24, 39-41) -- proper OpenAI message/usage types
- **File**: `src/core/state.ts` (MODIFY, line 198) -- type `style` as `Partial<Cell>`
- **File**: `src/main.ts` (MODIFY, line 44) -- type `interactionFragments` as `Line[][]`

---

## Phase 1: Architecture Redesign

**Priority**: HIGH (foundation for everything)
**Complexity**: XL
**Dependencies**: Phase 0

### Goal

Decompose the 302-line `StateManager` god class into focused, single-responsibility modules connected by an event bus. Establish the substrate architecture where the TUI process IS the orchestrator.

### Changes

#### 1.1 Event Bus
- **File**: `src/core/event-bus.ts` (CREATE)
- **Purpose**: Typed pub/sub to decouple modules
- **Events**:
  ```typescript
  interface EventMap {
    // Orchestrator lifecycle
    'turn:start': { prompt: string };
    'turn:llm-response': { content: string; toolCalls: ToolCall[] };
    'turn:tool-executing': { callId: string; tool: string; args: Record<string, unknown> };
    'turn:tool-result': { callId: string; result: ToolResult };
    'turn:complete': { response: string };
    'turn:error': { error: AppError };

    // Subagent events (via ACP)
    'subagent:spawned': { id: string; task: string };
    'subagent:update': { id: string; update: SubagentUpdate };
    'subagent:complete': { id: string; result: SubagentResult };
    'subagent:error': { id: string; error: AppError };

    // Permission flow
    'permission:request': { callId: string; tool: string; args: Record<string, unknown>;
                            resolve: (approved: boolean) => void };
    'permission:response': { callId: string; approved: boolean };

    // UI events
    'render:request': void;
    'input:submit': { text: string };
    'scroll:delta': { delta: number };
    'selection:start': SelectionPoint;
    'selection:extend': SelectionPoint;
    'selection:end': void;

    // Slash command events
    'command:mode-enter': void;                    // User typed `/` at line start
    'command:mode-exit': void;                     // User exited command mode
    'command:autocomplete': { query: string };     // Autocomplete filter updated
    'command:execute': { name: string; args: string[] };  // Command dispatched
    'command:model-changed': { provider: string; model: string };  // Model selection changed
  }
  ```

#### 1.2 Orchestrator Skeleton
- **File**: `src/core/orchestrator.ts` (CREATE)
- **Purpose**: The agent loop -- the brain of the TUI
- **This phase**: Skeleton only. The full agent loop is Phase 2. Here we establish:
  - Constructor that accepts provider registry, tool registry, permission manager, event bus
  - `handleUserInput(text: string)` entry point
  - Placeholder for LLM call + tool execution loop
  - Event emission for render updates
- **Extracted from**: `StateManager.sendMessage()` (the current LLM call logic)

#### 1.3 Conversation Manager
- **File**: `src/core/conversation.ts` (CREATE)
- **Extracted from**: `StateManager.messages`, `StateManager.refreshHistory`, `StateManager.textToLines`
- **Responsibilities**:
  - Store conversation history for LLM context (messages array with roles)
  - Store conversation display state (rendered blocks for the screen)
  - Manage the message format the LLM sees vs. what the user sees
  - Append-only with dirty tracking (fixes O(n*m) `refreshHistory` rebuild)
  - Provide `getMessagesForLLM()` -- returns the conversation in the provider's expected format
  - Provide `getDisplayBlocks()` -- returns renderable conversation blocks

#### 1.4 Input Manager
- **File**: `src/input/handler.ts` (CREATE)
- **Extracted from**: `main.ts` stdin handler (lines 97-163), `StateManager.prompt`, `StateManager.messageQueue`
- **Responsibilities**:
  - Own prompt text state (cursor position, text buffer)
  - Detect `/` at line start to enter command mode (emit `command:mode-enter`)
  - In command mode: route keypresses to autocomplete logic instead of prompt buffer
  - In normal mode: dispatch to orchestrator on Enter
  - Handle keyboard shortcuts (Ctrl+C, copy, paste)
  - Yield input to permission prompt when active
  - Yield input to modal menu when active (e.g., `/model` selector)

#### 1.5 Selection Manager
- **File**: `src/input/selection.ts` (CREATE)
- **Extracted from**: `StateManager` selection methods (startSelection, extendSelection, endSelection, clearSelection, hasSelection, getSelectedText, isCellSelected)

#### 1.6 Scroll Manager
- **Inline into**: Compositor or conversation manager
- **Extracted from**: `StateManager.scrollTop`, `scroll()`, `scrollToEnd()`, `getViewportHeight()`

#### 1.7 Decouple Compositor from Global State
- **File**: `src/renderer/compositor.ts` (MODIFY)
- **Change**: Remove import of `state` singleton. Receive all needed state as parameters to `composite()`

#### 1.8 Fix `TerminalBuffer.clone()` Shallow Copy
- **File**: `src/renderer/buffer.ts` (MODIFY, line 31)
- **Change**: Deep-clone Cell objects:
  ```typescript
  newBuf.cells = this.cells.map(line => line.map(cell => ({ ...cell })));
  ```

#### 1.9 Fix DiffEngine Cached State on Resize
- **File**: `src/renderer/diff.ts` (MODIFY)
- **Change**: Add `reset()` method called on terminal resize

#### 1.10 Slim Down `main.ts`
- **File**: `src/main.ts` (REWRITE)
- **Target**: ~60 lines. Load config, create event bus, wire modules, start orchestrator, initial render
- **CLI args**: `--model <name>`, `--provider <name>`, `--no-worries-just-vibes`

#### 1.11 Delete Singleton
- **File**: `src/core/state.ts` (DELETE after migration)
- The `export const state = new StateManager()` singleton prevents testability

---

## Phase 2: Agent Core & Tool System

**Priority**: CRITICAL (the TUI's raison d'etre)
**Complexity**: XL
**Dependencies**: Phase 1 (event bus, orchestrator skeleton), Phase 4 (provider with function calling)

### Goal

Implement the full orchestrator agent loop and the core tool system. After this phase, the TUI can receive user input, call an LLM with function calling enabled, parse tool calls from the response, execute them in-process, send results back, and display the final answer.

### The Agent Loop (Detail)

```typescript
class Orchestrator {
  async handleUserInput(text: string): Promise<void> {
    // 1. Add user message to conversation
    this.conversation.addUserMessage(text);
    this.eventBus.emit('turn:start', { prompt: text });

    // 2. Enter the tool-use loop
    let continueLoop = true;
    while (continueLoop) {
      // 3. Call LLM with conversation history + tool definitions
      const response = await this.provider.chat({
        messages: this.conversation.getMessagesForLLM(),
        tools: this.toolRegistry.getToolDefinitions(),
        model: this.config.model,
        signal: this.abortController.signal,
      });

      this.eventBus.emit('turn:llm-response', {
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // 4. If LLM returned tool calls, execute them
      if (response.toolCalls.length > 0) {
        const results = await this.executeToolCalls(response.toolCalls);
        // Add assistant message + tool results to conversation
        this.conversation.addAssistantMessage(response.content, response.toolCalls);
        this.conversation.addToolResults(results);
        // Loop back to step 3 with updated conversation
      } else {
        // 5. No tool calls -- final response
        this.conversation.addAssistantMessage(response.content);
        this.eventBus.emit('turn:complete', { response: response.content });
        continueLoop = false;
      }
    }
  }

  private async executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      this.eventBus.emit('turn:tool-executing', {
        callId: call.id, tool: call.name, args: call.arguments,
      });

      // Check permissions
      const approved = await this.permissionManager.check(call.name, call.arguments);
      if (!approved) {
        results.push({ callId: call.id, success: false, error: 'Permission denied' });
        continue;
      }

      // Execute tool
      const result = await this.toolRegistry.execute(call.name, call.arguments);
      this.eventBus.emit('turn:tool-result', { callId: call.id, result });
      results.push(result);
    }
    return results;
  }
}
```

### Changes

#### 2.1 Tool Types
- **File**: `src/types/tools.ts` (CREATE)
  ```typescript
  interface ToolDefinition {
    name: string;
    description: string;
    parameters: JSONSchema;  // JSON Schema for arguments
  }

  interface ToolCall {
    id: string;              // Unique call ID from LLM
    name: string;            // Tool name
    arguments: Record<string, unknown>;  // Parsed arguments
  }

  interface ToolResult {
    callId: string;
    success: boolean;
    output?: string;         // Tool output (file contents, command stdout, etc.)
    error?: string;          // Error message if failed
  }

  interface Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
  }
  ```

#### 2.2 Tool Registry
- **File**: `src/tools/registry.ts` (CREATE)
- **Purpose**: Register tools, generate definitions for LLM, dispatch execution
  ```typescript
  class ToolRegistry {
    register(tool: Tool): void;
    getToolDefinitions(): ToolDefinition[];  // For LLM function calling
    execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    has(name: string): boolean;
  }
  ```

#### 2.3 Core Tools

Each tool implements the `Tool` interface with a JSON Schema for its parameters and an `execute` method.

**File Read** -- `src/tools/file-read.ts` (CREATE)
- **Parameters**: `{ path: string, range?: { start: number, end: number } }`
- **Behavior**: Read file contents via `Bun.file(path).text()`. Optional line range.
- **Output**: File contents as string, with line numbers
- **Permission**: Auto-approve (read-only)

**File Write** -- `src/tools/file-write.ts` (CREATE)
- **Parameters**: `{ path: string, content: string }`
- **Behavior**: Write file via `Bun.write(path, content)`. Create parent dirs if needed.
- **Output**: Confirmation with bytes written
- **Permission**: Prompt user

**File Edit** -- `src/tools/file-edit.ts` (CREATE)
- **Parameters**: `{ path: string, find: string, replace: string }`
- **Behavior**: Read file, find exact string, replace, write back. Fail if `find` not found or not unique.
- **Output**: Diff of changes
- **Permission**: Prompt user

**Shell Exec** -- `src/tools/shell-exec.ts` (CREATE)
- **Parameters**: `{ command: string, cwd?: string, timeout?: number }`
- **Behavior**: Execute via `Bun.spawn`. Capture stdout/stderr. Default 30s timeout.
- **Output**: `{ stdout, stderr, exitCode }`
- **Permission**: Prompt user

**Grep** -- `src/tools/grep.ts` (CREATE)
- **Parameters**: `{ pattern: string, path?: string, glob?: string, maxResults?: number }`
- **Behavior**: Search file contents using regex. Uses `Bun.spawn(['grep', ...])` or manual file scan.
- **Output**: Matching lines with file paths and line numbers
- **Permission**: Auto-approve (read-only)

**List Directory** -- `src/tools/list-dir.ts` (CREATE)
- **Parameters**: `{ path: string, recursive?: boolean, maxDepth?: number }`
- **Behavior**: List directory contents via `readdir`. Respect `.gitignore` patterns.
- **Output**: File/directory listing with types and sizes
- **Permission**: Auto-approve (read-only)

**Glob** -- `src/tools/glob.ts` (CREATE)
- **Parameters**: `{ patterns: string[], cwd?: string }`
- **Behavior**: Find files matching glob patterns via `Bun.Glob`
- **Output**: Matching file paths
- **Permission**: Auto-approve (read-only)

#### 2.4 Complete the Orchestrator
- **File**: `src/core/orchestrator.ts` (MODIFY from Phase 1 skeleton)
- **Purpose**: Full agent loop implementation as shown above
- **Features**:
  - Tool-use loop (LLM call -> parse tool calls -> execute -> feed results back -> repeat)
  - Abort support (Ctrl+C cancels current turn via AbortController)
  - Turn tracking (which tools were called, what results came back)
  - Event emission at each step for rendering

#### 2.5 Conversation Manager (LLM Context)
- **File**: `src/core/conversation.ts` (MODIFY from Phase 1)
- **Add**: Tool-aware message management
  ```typescript
  // The conversation must track tool calls and results in the format
  // each LLM provider expects:
  addAssistantMessage(content: string, toolCalls?: ToolCall[]): void;
  addToolResults(results: ToolResult[]): void;
  getMessagesForLLM(): ProviderMessage[];  // Provider-specific format
  ```

---

## Phase 3: ACP Integration

**Priority**: HIGH (enables parallelism and delegation)
**Complexity**: L
**Dependencies**: Phase 1 (event bus), Phase 2 (tool system for context)

### Goal

Enable the orchestrator to spawn subagent child processes via ACP when work should be parallelized or delegated. The TUI acts as an ACP **server** (host) to its subagents, not a client to an external agent.

### How Subagents Work

The orchestrator decides when to delegate:
1. Orchestrator determines a task is parallelizable (e.g., "refactor these 5 files")
2. Orchestrator spawns N subagent child processes via ACP
3. Each subagent gets a task description, relevant context, and tool access
4. Subagents run their own agent loops (they have their own LLM calls)
5. Subagents report progress back to the orchestrator via ACP
6. Orchestrator collects results, renders activity, continues its own loop

### Changes

#### 3.1 ACP Manager
- **File**: `src/acp/manager.ts` (CREATE)
- **Purpose**: Subagent lifecycle management
  ```typescript
  class AcpManager {
    // Spawn a new subagent for a specific task
    async spawn(task: SubagentTask): Promise<string>;  // returns subagent ID

    // Monitor active subagents
    getActive(): SubagentInfo[];

    // Cancel a running subagent
    async cancel(id: string): Promise<void>;

    // Wait for all subagents to complete
    async waitAll(): Promise<SubagentResult[]>;
  }

  interface SubagentTask {
    description: string;     // What the subagent should do
    context: string;         // Relevant files, code snippets
    tools: string[];         // Which tools the subagent can use
    model?: string;          // LLM model for the subagent
    provider?: string;       // LLM provider for the subagent
  }
  ```

#### 3.2 ACP Connection
- **File**: `src/acp/connection.ts` (CREATE)
- **Purpose**: Per-subagent ACP connection management
- **Responsibilities**:
  - Spawn child process via `Bun.spawn`
  - Create `ndJsonStream` over stdio for ACP communication
  - Initialize `ClientSideConnection` as the HOST (we are the server to the subagent)
  - Handle subagent session updates, tool requests, permission delegation
  - Clean up on subagent exit

#### 3.3 ACP Protocol Types
- **File**: `src/acp/protocol.ts` (CREATE)
- **Purpose**: Type definitions for ACP messages
  ```typescript
  // Re-export from @agentclientprotocol/sdk
  export type {
    ClientSideConnection, Client, Agent,
    SessionNotification, SessionUpdate,
    PromptRequest, PromptResponse, StopReason,
    Stream
  } from '@agentclientprotocol/sdk';
  export { ndJsonStream, ClientSideConnection } from '@agentclientprotocol/sdk';

  // Local types
  interface SubagentInfo {
    id: string;
    task: string;
    status: 'running' | 'complete' | 'error' | 'cancelled';
    startedAt: number;
    progress?: string;  // Latest status message
  }

  interface SubagentResult {
    id: string;
    success: boolean;
    output: string;
    toolCallsMade: number;
    duration: number;
  }
  ```

#### 3.4 Orchestrator Integration
- **File**: `src/core/orchestrator.ts` (MODIFY)
- **Add**: Ability to delegate to subagents
  ```typescript
  // The orchestrator can use ACP delegation as a "meta-tool"
  // When the LLM decides work should be parallelized, it can call
  // a "delegate" tool that spawns subagents via ACP
  ```
- **Add**: Register a `delegate` tool in the tool registry that triggers ACP subagent spawning

---

## Phase 4: Provider Abstraction

**Priority**: HIGH (orchestrator needs function calling to work)
**Complexity**: L
**Dependencies**: Phase 0

### Goal

Multi-provider LLM support WITH function/tool calling. Every provider must support sending tool definitions and receiving tool calls in responses. This is what makes the orchestrator loop work.

### Supported Providers and Models

| Provider | Models | API Format | Function Calling |
|----------|--------|------------|------------------|
| OpenAI | gpt-5.4, gpt-5.3-chat-latest, gpt-5-mini, gpt-5-nano, gpt-oss-120b | OpenAI native | `tools` array in request, `tool_calls` in response |
| Google Gemini | gemini-3.1-pro-preview, gemini-3-flash, gemini-3.1-flash-lite-preview, gemini-2.5-pro | Gemini API | `functionDeclarations` in request, `functionCall` parts in response |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | Messages API | `tools` array in request, `tool_use` content blocks in response |
| InceptionLabs | mercury-2 | OpenAI-compatible | Same as OpenAI |

### Changes

#### 4.1 Provider Interface
- **File**: `src/providers/interface.ts` (CREATE)
  ```typescript
  interface LLMProvider {
    readonly name: string;
    readonly models: string[];

    chat(params: ChatRequest): Promise<ChatResponse>;
  }

  interface ChatRequest {
    messages: ProviderMessage[];     // Conversation history
    tools?: ToolDefinition[];        // Available tools for function calling
    model: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }

  interface ChatResponse {
    content: string;                 // Text response
    toolCalls: ToolCall[];           // Tool calls requested by the LLM
    usage: { inputTokens: number; outputTokens: number };
    stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
  }

  // Provider-agnostic message format (converted per-provider)
  type ProviderMessage =
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
    | { role: 'tool'; callId: string; content: string };
  ```

#### 4.2 Tool Format Converters
- **File**: `src/providers/tool-formats.ts` (CREATE)
- **Purpose**: Convert between our internal tool/message types and each provider's format
  ```typescript
  // OpenAI format
  function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[];
  function fromOpenAIToolCalls(choices: OpenAI.ChatCompletion.Choice[]): ToolCall[];
  function toOpenAIMessages(messages: ProviderMessage[]): OpenAI.ChatCompletionMessageParam[];

  // Anthropic format
  function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[];
  function fromAnthropicToolUse(content: Anthropic.ContentBlock[]): ToolCall[];
  function toAnthropicMessages(messages: ProviderMessage[]): Anthropic.MessageParam[];

  // Gemini format
  function toGeminiFunctionDeclarations(tools: ToolDefinition[]): GeminiFunctionDeclaration[];
  function fromGeminiFunctionCalls(parts: GeminiPart[]): ToolCall[];
  function toGeminiContents(messages: ProviderMessage[]): GeminiContent[];
  ```

#### 4.3 OpenAI Provider
- **File**: `src/providers/openai.ts` (CREATE)
- **Purpose**: Native OpenAI API with function calling
- **Uses**: `openai` npm package (already a dependency)
- **Handles**: `tool_calls` in response, `tool` role messages for results

#### 4.4 OpenAI-Compatible Provider
- **File**: `src/providers/openai-compat.ts` (CREATE, replaces `src/core/inception.ts`)
- **Purpose**: OpenAI-compatible endpoints (InceptionLabs Mercury)
- **Constructor**: accepts `baseURL`, `apiKey`, `defaultModel`
- **Properly typed**: Remove all `as any` casts

#### 4.5 Anthropic Provider
- **File**: `src/providers/anthropic.ts` (CREATE)
- **Purpose**: Native Anthropic Messages API for Claude models
- **Uses**: `fetch` directly (Messages API is simple enough)
- **Handles**: `tool_use` content blocks in response, `tool_result` content blocks for results
- **Format differences**:
  - System message is a top-level `system` parameter, not a message
  - Tool results are `tool_result` content blocks inside `user` messages
  - Response may contain interleaved `text` and `tool_use` blocks

#### 4.6 Gemini Provider
- **File**: `src/providers/gemini.ts` (CREATE)
- **Purpose**: Native Google Gemini API
- **Uses**: `fetch` directly
- **Handles**: `functionCall` parts in response, `functionResponse` parts for results
- **Format differences**:
  - Tools are `functionDeclarations` inside a `tools` array
  - Tool calls come as `functionCall` parts in the response
  - Tool results are `functionResponse` parts in subsequent messages

#### 4.7 Provider Registry
- **File**: `src/providers/registry.ts` (CREATE)
- **Purpose**: Config-driven provider selection
  ```typescript
  class ProviderRegistry {
    register(provider: LLMProvider): void;
    get(name: string): LLMProvider;
    getForModel(model: string): LLMProvider;  // Auto-detect from model name
    listModels(): { provider: string; model: string }[];
  }
  ```

#### 4.8 Delete Old Provider Files
- **Files**: `src/core/provider.ts` (DELETE), `src/core/inception.ts` (DELETE)
- Replaced by `src/providers/interface.ts` + provider implementations

---

## Phase 5: Structured Rendering

**Priority**: HIGH (the TUI's visual identity)
**Complexity**: XL
**Dependencies**: Phase 1 (event bus, conversation manager), Phase 2 (tool system events to render)

### Goal

Render the orchestrator's activity as structured blocks: markdown text with formatting, syntax-highlighted code blocks, diffs from file edits, tool call status blocks, command output, subagent activity panels. Each block type has its own renderer that produces `Line[]` for the cell-based pipeline.

### Content Block Types (Display Model)

```typescript
type ConversationBlock =
  | { type: 'user-message'; content: string }
  | { type: 'assistant-message'; content: string; isComplete: boolean }
  | { type: 'tool-call'; callId: string; tool: string; args: Record<string, unknown>;
      status: 'pending' | 'running' | 'complete' | 'error';
      result?: ToolResult }
  | { type: 'error'; error: AppError }
  | { type: 'system'; content: string }
  | { type: 'subagent'; id: string; task: string;
      status: 'running' | 'complete' | 'error';
      updates: SubagentUpdate[] };
```

### Changes

#### 5.1 Markdown Renderer
- **File**: `src/renderer/markdown.ts` (CREATE)
- **Purpose**: Parse markdown text into styled `Line[]`
- **Features**:
  - Headers (`#`, `##`, `###`) with bold + color
  - Bold (`**text**`), italic (`*text*`)
  - Inline code (`` `code` ``) with background color
  - Code blocks (` ``` `) delegate to code-block renderer
  - Lists (`-`, `*`, `1.`) with indentation
  - Links `[text](url)` with underline styling
- **Approach**: Line-by-line state machine. Handle common cases well.
- **Cell type extension needed**: Add `underline: boolean` and `italic: boolean` to `Cell` interface

#### 5.2 Code Block Renderer
- **File**: `src/renderer/code-block.ts` (CREATE)
- **Purpose**: Render code with syntax highlighting
- **Approach**: Keyword-based highlighting per language. Keywords + strings + comments + numbers covers 80% of visual value. Full tree-sitter is a future upgrade.
- **Features**:
  - Line numbers (dimmed, right-aligned)
  - Filename header bar (from tool call context)
  - Background color for code region
  - Language detection from fence tag

#### 5.3 Diff Renderer
- **File**: `src/renderer/diff-view.ts` (CREATE)
- **Purpose**: Render diffs from file-edit tool results
- **Features**:
  - `+` lines in green, `-` lines in red
  - `@@` hunk headers in cyan
  - Filename header
  - Line numbers (old + new)

#### 5.4 Tool Call Block Renderer
- **File**: `src/renderer/tool-call.ts` (CREATE)
- **Purpose**: Render tool call status and results
- **Features**:
  - Status header with icon based on tool name:
    - `file-read` -> eye icon, `file-write` -> pencil, `file-edit` -> diff icon
    - `shell-exec` -> terminal icon, `grep` -> magnifier, `list-dir` -> folder
  - Status badge: `[PENDING]` dim, `[RUNNING]` yellow, `[DONE]` green, `[FAILED]` red
  - Title from tool name + key argument (e.g., "Reading src/main.ts", "Running npm test")
  - Result rendering: delegate to appropriate renderer based on content type
  - Collapsible: tool calls can be collapsed after completion
  ```
  📖 Reading src/main.ts                              [DONE]
  ┌────────────────────────────────────────────────────────┐
  │  1 | import { EventBus } from './core/event-bus';      │
  │  2 | import { Orchestrator } from './core/orchestrator';│
  │  3 | ...                                               │
  └────────────────────────────────────────────────────────┘

  ✏️  Editing src/config.ts                             [DONE]
  ┌────────────────────────────────────────────────────────┐
  │ @@ -12,3 +12,5 @@                                     │
  │ - const old = 'value';                                │
  │ + const new = 'better';                               │
  │ + const extra = 'line';                               │
  └────────────────────────────────────────────────────────┘

  ⚡ Running npm test                                  [RUNNING]
  ┌────────────────────────────────────────────────────────┐
  │ > bun test                                            │
  │  ✓ 12 tests passed                                    │
  └────────────────────────────────────────────────────────┘
  ```

#### 5.5 File Tree Renderer
- **File**: `src/renderer/file-tree.ts` (CREATE)
- **Purpose**: Render directory listings from `list-dir` tool results
- **Features**:
  - Tree drawing characters (`├──`, `└──`, `│`)
  - Color coding by file type
  - Size info (dimmed)

#### 5.6 Subagent Activity Panel
- **File**: `src/renderer/subagent-panel.ts` (CREATE)
- **Purpose**: Show subagent activity in a dedicated panel
- **Features**:
  - List of active subagents with status
  - Progress updates from each subagent
  - Expandable/collapsible per subagent
  ```
  ┌─ Subagents ──────────────────────────────────────────┐
  │ ▶ [1/3] Refactoring src/auth/...        [RUNNING] ⠹  │
  │ ▶ [2/3] Updating src/api/routes.ts      [RUNNING] ⠸  │
  │ ✓ [3/3] Fixing src/utils/helpers.ts     [DONE]       │
  └──────────────────────────────────────────────────────┘
  ```

#### 5.7 Progress Indicators
- **File**: `src/renderer/progress.ts` (CREATE)
- **Purpose**: Rich status indicators
- **Features**:
  - Spinner with label (extract from StateManager)
  - Tool execution progress: `[2/5] Editing src/config.ts...`
  - Token usage bar in footer

#### 5.8 Extend Cell Type
- **File**: `src/types/grid.ts` (MODIFY)
- **Add**: `underline: boolean`, `italic: boolean`, `strikethrough: boolean` to `Cell`
- **Impact**: Update `createEmptyCell`, `DiffEngine.applyStyles`, all Cell creation sites

---

## Phase 6: Permission Model

**Priority**: HIGH (required for tool execution safety)
**Complexity**: M
**Dependencies**: Phase 1 (event bus), Phase 2 (tool system)

### Design

Permissions are category-based with sensible defaults:

| Category | Tools | Default | Rationale |
|----------|-------|---------|----------|
| Read | file-read, grep, list-dir, glob | Auto-approve | Read-only, no side effects |
| Write | file-write, file-edit | Prompt user | Modifies filesystem |
| Execute | shell-exec | Prompt user | Arbitrary command execution |
| Delegate | subagent spawn | Prompt user | Spawns new processes |

### The `--no-worries-just-vibes` Flag

CLI flag that auto-accepts ALL permissions without prompting. For users who trust the orchestrator completely.

### Changes

#### 6.1 Permission Manager
- **File**: `src/permissions/manager.ts` (CREATE)
  ```typescript
  class PermissionManager {
    private sessionApprovals: Map<string, boolean>;  // tool+pattern -> approved
    private autoApprove: boolean;  // --no-worries-just-vibes

    async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
      // 1. Check auto-approve flag
      if (this.autoApprove) return true;

      // 2. Check tool category defaults
      const category = this.getCategory(toolName);
      if (category === 'read') return true;  // Auto-approve reads

      // 3. Check session memory (user previously approved this pattern)
      const key = this.getApprovalKey(toolName, args);
      if (this.sessionApprovals.has(key)) return this.sessionApprovals.get(key)!;

      // 4. Prompt user via event bus
      return new Promise((resolve) => {
        this.eventBus.emit('permission:request', {
          callId: crypto.randomUUID(),
          tool: toolName,
          args,
          resolve: (approved: boolean) => {
            this.sessionApprovals.set(key, approved);
            resolve(approved);
          }
        });
      });
    }
  }
  ```

#### 6.2 Permission Prompt UI
- **File**: `src/permissions/prompt.ts` (CREATE)
- **Purpose**: Modal permission prompt rendered in the TUI
  ```
  ┌─ Permission Required ─────────────────────────┐
  │ Tool: shell-exec                               │
  │ Command: npm test                              │
  │ Working dir: /home/user/project                │
  │                                                │
  │  [Y] Allow once                                │
  │  [A] Allow always (this session)               │
  │  [N] Deny                                      │
  └────────────────────────────────────────────────┘
  ```
- **Integration**: Takes over input handling during prompt. Renders as overlay. Returns decision via callback.

---

## Phase 7: Error Handling & Resilience

**Priority**: MEDIUM
**Complexity**: M
**Dependencies**: Phase 0

### Changes

#### 7.1 Error Type Hierarchy
- **File**: `src/types/errors.ts` (CREATE)
  ```typescript
  class AppError extends Error {
    constructor(message: string, public code: string, public recoverable: boolean) {
      super(message);
    }
  }

  class ConfigError extends AppError { /* missing API key, bad config */ }
  class ProviderError extends AppError { /* API errors, rate limits, timeouts */ }
  class ToolError extends AppError { /* tool execution failures */ }
  class AcpError extends AppError { /* subagent connection/protocol errors */ }
  class PermissionError extends AppError { /* permission denied */ }
  class RenderError extends AppError { /* rendering failures */ }
  ```

#### 7.2 Retry Logic
- **File**: `src/utils/retry.ts` (CREATE)
- **Purpose**: Exponential backoff with jitter for LLM API calls
- **Applied to**: Provider `chat()` calls. Retry on 429, 500, 503. Do NOT retry on 400, 401, 403.
- **Config**: Max retries (default 3), initial delay (1s), max delay (30s)

#### 7.3 Tool Execution Error Handling
- **Integrated into**: `src/core/orchestrator.ts`
- **Behavior**:
  - Tool errors are caught and returned as `ToolResult { success: false, error: '...' }`
  - The LLM sees the error and can decide to retry, try a different approach, or report to user
  - Tool errors do NOT crash the orchestrator loop

#### 7.4 User-Facing Error Display
- **Integrated into**: Conversation rendering
- **Change**: Replace raw `Error: ${error.message}` with:
  - Friendly message explaining what went wrong
  - Suggested action (check API key, retry, etc.)
  - Technical details dimmed

#### 7.5 Fix `execSync` Clipboard Timeout
- **File**: `src/utils/clipboard.ts` (MODIFY)
- **Change**: Replace `execSync` with `Bun.spawn` + timeout

#### 7.6 Graceful Shutdown
- **File**: `src/main.ts` (MODIFY)
- **Change**: Handle SIGTERM, SIGINT. Clean up alt screen, mouse mode, raw mode. Cancel active turn. Kill spawned subagent processes.

---

## Phase 8: Testing

**Priority**: MEDIUM (validates everything else)
**Complexity**: L
**Dependencies**: Phase 1 (testable architecture), Phase 2 (agent loop)

### Strategy

- **Unit tests**: Pure logic (tokenizer, markdown parser, retry, tool implementations, permission policy)
- **Component tests**: Modules with mocked deps (orchestrator with mock provider, tools with mock filesystem)
- **Integration tests**: Full agent loop with mock LLM returning tool calls

### Changes

#### 8.1 Test Infrastructure
- **File**: `src/test/setup.ts` (CREATE)
- **Purpose**:
  - Mock LLM provider that returns canned responses with tool calls
  - Mock tool implementations for testing orchestrator loop
  - Mock event bus for verifying event sequences
  - Test filesystem helpers (temp dirs, fixture files)

#### 8.2 Unit Tests

| Test File | Tests |
|-----------|-------|
| `src/test/input/tokenizer.test.ts` | CSI-u parsing, bracketed paste, mouse events, edge cases |
| `src/test/renderer/markdown.test.ts` | Headers, bold, code blocks, lists, inline code |
| `src/test/renderer/tool-call.test.ts` | Tool call rendering, status transitions, content delegation |
| `src/test/renderer/diff-view.test.ts` | Diff rendering, added/removed lines, hunk headers |
| `src/test/tools/file-read.test.ts` | File reading, line ranges, missing files, binary detection |
| `src/test/tools/shell-exec.test.ts` | Command execution, timeout, stderr capture |
| `src/test/tools/registry.test.ts` | Tool registration, definition generation, dispatch |
| `src/test/providers/openai.test.ts` | Message formatting, tool call parsing, response mapping |
| `src/test/providers/anthropic.test.ts` | Message formatting, tool_use blocks, system message handling |

#### 8.3 Component Tests

| Test File | Tests |
|-----------|-------|
| `src/test/core/orchestrator.test.ts` | Full agent loop: user input -> LLM call -> tool calls -> results -> LLM again -> final response |
| `src/test/core/conversation.test.ts` | Message management, tool call tracking, LLM format conversion |

#### 8.4 Integration Tests

| Test File | Tests |
|-----------|-------|
| `src/test/integration/agent-loop.test.ts` | End-to-end: user sends "create a file", mock LLM returns file-write tool call, tool executes, LLM sees result, responds with confirmation |
| `src/test/integration/permission-flow.test.ts` | Tool call -> permission prompt -> user approves -> tool executes -> result displayed |

#### 8.5 Delete Ad-Hoc Test Scripts
- **Files**: `test-input.ts` (DELETE), `test-render.ts` (DELETE) -- replaced by real tests

#### 8.6 Coverage Target
- Core orchestrator loop: >90% branch coverage
- Tool implementations: >85% line coverage
- Provider format converters: >95% line coverage
- Input tokenizer: >90% line coverage
- Overall: >80%

---

## Phase 9: UX Polish

**Priority**: LOW (nice-to-have, makes the product feel complete)
**Complexity**: M
**Dependencies**: Phase 5 (rendering)

### Changes

#### 9.1 Slash Commands
- **File**: `src/input/commands.ts` (CREATE)
- **Commands**:
  - `/help` -- show available commands and shortcuts
  - `/clear` -- clear conversation history display
  - `/model <name>` -- switch LLM model
  - `/provider <name>` -- switch provider
  - `/compact` -- summarize conversation to free context
  - `/tools` -- list available tools
  - `/quit` or `:q` -- exit

#### 9.2 Configuration File
- **File**: `src/config.ts` (MODIFY from Phase 0)
- **Format**: JSON
- **Location**: `~/.config/goodvibes/config.json` or `./goodvibes.config.json`
  ```json
  {
    "provider": "openai",
    "model": "gpt-5.4",
    "apiKeys": {
      "openai": "sk-...",
      "anthropic": "sk-ant-...",
      "gemini": "AIza...",
      "inceptionlabs": "..."
    },
    "permissions": "ask",
    "theme": "vaporwave"
  }
  ```

#### 9.3 Keyboard Shortcuts
- **File**: `src/input/handler.ts` (MODIFY)
- **Shortcuts**:
  - `Ctrl+L` -- clear screen (re-render)
  - `Ctrl+U` -- clear prompt line
  - `Ctrl+A` / `Ctrl+E` -- beginning/end of prompt
  - `Ctrl+C` -- cancel current turn (abort LLM call + tool execution)
  - `Escape` -- dismiss permission prompt
  - `PageUp` / `PageDown` -- scroll by page

#### 9.4 Token Budget Display
- **File**: `src/renderer/ui-factory.ts` (MODIFY footer)
- **Change**: Show context window usage:
  ```
  Tokens: [████████░░░░░░░░] 52,340 / 128,000 (41%)  │  Model: gpt-5.4  │  Tools: 7
  ```

#### 9.5 Welcome Screen Enhancement
- **File**: `src/utils/splash-lines.ts` (MODIFY)
- **Change**: Show:
  - Working directory
  - Active model/provider
  - Available tools count
  - Quick help: key shortcuts

#### 9.6 Context Management
- **Purpose**: Manage conversation length to stay within token budget
- **Approach**: Token counting (estimate: 4 chars = 1 token) + sliding window
- **Summarization**: `/compact` command sends old messages to LLM with summarization prompt, replaces with summary
- **Auto-compact**: Trigger when token usage exceeds 80% of model's context window

#### 9.7 Conversation Persistence
- **Purpose**: Save/resume conversations across sessions
- **Format**: JSON file in `.goodvibes/conversations/`
- **Features**: Auto-save on exit, resume with `--resume` flag

---

## Dependency Graph

```
Phase 0 (Security & Hygiene)
  |
  +---> Phase 1 (Architecture Redesign)
  |       |
  |       +---> Phase 2 (Agent Core & Tool System) <-- needs Phase 4
  |       |       |
  |       |       +---> Phase 3 (ACP Integration)
  |       |       |       |
  |       |       |       +---> Phase 5 (Rendering) -- subagent panels
  |       |       |
  |       |       +---> Phase 5 (Structured Rendering) <-- needs tool events
  |       |       |       |
  |       |       |       +---> Phase 9 (UX Polish)
  |       |       |
  |       |       +---> Phase 6 (Permission Model)
  |       |       |
  |       |       +---> Phase 8 (Testing)
  |       |
  |       +---> Phase 4 (Provider Abstraction)
  |               |
  |               +---> Phase 2 (Agent Core needs providers)
  |
  +---> Phase 7 (Error Handling) <-- can start early, independent
```

### Parallelism Opportunities

| Can run in parallel | Notes |
|--------------------|-------|
| Phase 1 + Phase 7 | Architecture redesign and error types are independent |
| Phase 4 + Phase 1 | Provider abstraction only needs Phase 0 |
| Phase 3 + Phase 5 | ACP integration and rendering are independent once Phase 2 exists |
| Phase 6 + Phase 5 | Permissions and rendering are independent |
| Phase 8 + Phase 9 | Tests and UX polish are independent |

### Critical Path

```
Phase 0 -> Phase 1 -> Phase 4 -> Phase 2 -> Phase 5 -> Phase 8
                                    |
                                    +---> Phase 6
                                    +---> Phase 3
```

The fastest path to a working agent: fix security, redesign state, implement providers with function calling, build the orchestrator + tool system, add rendering, test.

### Circular Dependency: Phase 2 <-> Phase 4

Phase 2 (Agent Core) needs Phase 4 (Providers) because the orchestrator loop calls `provider.chat()` with tool definitions. Phase 4 needs the tool types from Phase 2 to format function calling correctly.

**Resolution**: Build in this order:
1. Phase 4.1 (provider interface + tool types) -- defines the contract
2. Phase 2.1 (tool types) -- defines tool schemas
3. Phase 4.2-4.7 (provider implementations) -- implement the contract
4. Phase 2.2-2.5 (tool registry + orchestrator) -- use the providers

In practice, Phase 2 and Phase 4 are developed together as a single sprint.

---

## Complexity Summary

| Phase | Complexity | Est. Files | Est. LOC |
|-------|-----------|------------|----------|
| 0 - Security & Hygiene | S | 4 modify, 1 create, 1 delete | ~100 |
| 1 - Architecture Redesign | XL | 5 create, 4 modify, 1 delete | ~500 |
| 2 - Agent Core & Tool System | XL | 9 create, 1 modify | ~900 |
| 3 - ACP Integration | L | 3 create, 1 modify | ~400 |
| 4 - Provider Abstraction | L | 7 create, 2 delete | ~600 |
| 5 - Structured Rendering | XL | 8 create, 2 modify | ~900 |
| 6 - Permission Model | M | 2 create | ~250 |
| 7 - Error Handling & Resilience | M | 3 create, 2 modify | ~200 |
| 8 - Testing | L | 12 create, 2 delete | ~1000 |
| 9 - UX Polish | M | 3 create, 3 modify | ~500 |
| **Total** | | **~55 files** | **~5350 LOC** |

---

## Sprint Plan

### Sprint 1: Foundation (Phases 0 + 1 + 7)
- Fix all security and hygiene issues
- Decompose StateManager into event-bus + focused managers
- Create error type hierarchy
- Create orchestrator skeleton (no agent loop yet)
- App should still work identically after this sprint (no new features)
- **Deliverable**: Clean architecture, same functionality

### Sprint 2: Orchestrator Core (Phases 4 + 2)
- Implement provider interface with function calling support
- Build OpenAI + Anthropic + Gemini + InceptionLabs providers
- Implement tool type system and registry
- Build core tools (file-read, file-write, file-edit, shell-exec, grep, list-dir, glob)
- Complete the orchestrator agent loop
- **Deliverable**: TUI can receive user input, call LLM with tools, execute tool calls, display results

### Sprint 3: Rendering + Permissions (Phases 5 + 6)
- Markdown renderer, code blocks, diff views
- Tool call block renderer (status, content, results)
- Permission manager with modal prompts
- `--no-worries-just-vibes` flag
- Progress indicators
- **Deliverable**: Professional-looking output with permission flow working

### Sprint 4: ACP + Polish (Phases 3 + 9)
- ACP manager for subagent spawning and lifecycle
- Subagent activity panel rendering
- Slash commands, keyboard shortcuts
- Config file support
- Context management and summarization
- Welcome screen with model/tool info
- **Deliverable**: Full-featured coding agent TUI with delegation capability

### Sprint 5: Quality (Phase 8)
- Test infrastructure with mock LLM and mock tools
- Unit tests for tools, tokenizer, renderers, providers
- Component tests for orchestrator loop
- Integration tests for end-to-end agent flows
- Delete ad-hoc test scripts
- **Deliverable**: 10/10 coding agent TUI substrate
