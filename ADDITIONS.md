# GoodVibes TUI: Base Additions Spec

> Spec for the next round of additions to the goodvibes-tui substrate.
> Organized into 6 phases (A-F), grouped into 4 sprints.

---

## Phase A: Config System Overhaul

**What it does:** Replaces the current frozen singleton `AppConfig` with a layered, mutable config system. Config is persistent (JSON file at `~/.config/goodvibes/config.json`), categorized, and fully controllable via slash commands.

**Why:** The current `config.ts` exports a `Object.freeze()`d singleton built once at startup. Runtime changes (e.g., `/model`) bypass it and only mutate `runtime` state. There's no way to persist display preferences, reasoning effort, streaming toggle, or any new setting. Every future feature that needs a user preference will need this foundation.

### Current State

- `AppConfig` interface: `provider`, `model`, `apiKeys`, `autoApprove`, `workingDir`, `systemPrompt?`
- Built once via `buildConfig()`, frozen, exported as singleton
- `saveConfigKey()` in `commands.ts` does flat key writes to `~/.config/goodvibes/config.json`
- `CommandContext.runtime` holds mutable state: `model`, `provider`, `debugMode`, `systemPrompt`

### Design

#### Config Schema

Replace the flat `AppConfig` with a categorized, typed schema:

```typescript
export interface GoodVibesConfig {
  display: {
    stream: boolean;           // Show tokens as they arrive (default: true)
    lineNumbers: boolean;      // Show line numbers on output (default: false)
    collapseThreshold: number; // Auto-collapse blocks over N lines (default: 30)
    theme: string;             // Color theme name (default: 'vaporwave')
  };
  provider: {
    reasoningEffort: 'instant' | 'low' | 'medium' | 'high'; // default: 'medium'
    model: string;             // Active model (default: 'mercury-2')
    provider: string;          // Active provider (default: 'inceptionlabs')
    systemPromptFile: string;  // Path to system prompt file (default: '')
  };
  behavior: {
    autoApprove: boolean;      // --no-worries-just-vibes (default: false)
    autoCompactThreshold: number; // Auto-compact at N% context usage (default: 80)
    saveHistory: boolean;      // Persist input history across sessions (default: true)
  };
}
```

#### Config Manager Class

New file: `src/config/manager.ts`

```typescript
export class ConfigManager {
  private config: GoodVibesConfig;       // Runtime state
  private configPath: string;            // ~/.config/goodvibes/config.json
  private schema: ConfigSchema;          // Metadata: key, type, default, description

  constructor(overrides?: Partial<GoodVibesConfig>);

  get<K extends ConfigKey>(key: K): ConfigValue<K>;
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void;
  getAll(): Readonly<GoodVibesConfig>;
  getCategory(category: 'display' | 'provider' | 'behavior'): object;
  getSchema(): ConfigSchema;
  save(): void;            // Persist to disk
  load(): void;            // Load from disk, merge with defaults
  reset(key?: ConfigKey): void;  // Reset to default
}
```

Key behaviors:
- `load()` reads `~/.config/goodvibes/config.json`, deep-merges with defaults, validates types
- `set()` updates runtime state AND auto-saves to disk
- CLI args and env vars still override file values (applied after `load()`)
- `apiKeys` remain separate -- loaded from env vars only, never persisted to config file

#### Config Schema Metadata

New file: `src/config/schema.ts`

Each setting has metadata for validation, help text, and the `/config` display:

```typescript
export interface ConfigSetting {
  key: string;           // Dot-path: 'display.stream'
  type: 'boolean' | 'number' | 'string' | 'enum';
  default: unknown;
  description: string;
  enumValues?: string[]; // For type 'enum'
  validate?: (value: unknown) => boolean;
}
```

#### Migration

New file: `src/config/index.ts` -- barrel export

- Replace `src/config.ts` entirely
- Old flat config file keys auto-migrated to new nested format on first load
- `AppConfig` interface kept as compatibility alias, backed by `ConfigManager`
- All `CommandContext` refs updated to use `ConfigManager` instead of frozen config

### Enhanced /config Command

| Invocation | Behavior |
|---|---|
| `/config` | Show all settings, grouped by category |
| `/config display` | Show all display settings |
| `/config display.stream` | Show one setting with description and current value |
| `/config display.stream false` | Set value, auto-save, confirm |
| `/config reset display.stream` | Reset to default |
| `/config reset` | Reset all to defaults (with confirmation) |

### Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `src/config/schema.ts` | Create | Config schema definitions and metadata |
| `src/config/manager.ts` | Create | ConfigManager class |
| `src/config/index.ts` | Create | Barrel export |
| `src/config.ts` | Delete | Replaced by `src/config/` module |
| `src/input/commands.ts` | Modify | Enhanced /config handler |
| `src/input/command-registry.ts` | Modify | Add ConfigManager to CommandContext |
| `src/main.ts` | Modify | Initialize ConfigManager, pass to context |
| `src/core/orchestrator.ts` | Modify | Use ConfigManager for model/provider |

### Dependencies

None -- this is the foundation for all other phases.

---

## Phase B: Streaming Display

**What it does:** Pipes LLM response deltas to the conversation display in real-time, showing tokens as they arrive instead of waiting for the full response.

**Why:** The current flow is: orchestrator calls `provider.chat()` which returns a complete `ChatResponse`, then the conversation manager renders the full block. Users see a spinner, then the entire response appears at once. Streaming is the standard UX expectation for LLM interactions.

### Current State

- `LLMProvider.chat()` returns `Promise<ChatResponse>` -- a single complete response
- The OpenAI and OpenAI-compat providers already use streaming internally (SSE) but buffer the full response before returning
- `ConversationManager.appendMessages()` renders complete blocks
- `EventBus` has `turn:llm-response` fired once with the full response

### Design

#### Provider Interface Extension

Extend `ChatRequest` and add a streaming callback:

```typescript
export interface ChatRequest {
  // ... existing fields
  onDelta?: (delta: StreamDelta) => void;  // Called per-chunk during streaming
}

export interface StreamDelta {
  content?: string;           // Text content delta
  toolCalls?: PartialToolCall[];  // Incremental tool call data
  reasoning?: string;         // Reasoning/thinking delta
}
```

When `onDelta` is provided and `config.display.stream` is `true`, providers call it per-chunk. The existing `chat()` return value remains unchanged -- it still returns the complete `ChatResponse` when done.

#### New Event: `turn:stream-delta`

Add to `EventMap`:

```typescript
'turn:stream-delta': { content: string; accumulated: string };
'turn:stream-start': void;
'turn:stream-end': void;
```

#### Streaming Conversation Block

New block type in the conversation display that updates in-place:

- When streaming starts: create an "assistant-streaming" block with empty content
- On each delta: append content to the block, trigger re-render of just that block
- On stream end: convert to a normal "assistant" block

The compositor already supports partial re-renders -- the streaming block only needs to update the lines from its start position to the current end.

#### Orchestrator Changes

In `runTurn()`:

```typescript
// Before (current)
const response = await provider.chat({ ... });

// After
const response = await provider.chat({
  ...request,
  onDelta: this.config.get('display.stream')
    ? (delta) => this.eventBus.emit('turn:stream-delta', { ... })
    : undefined,
});
```

#### Toggle

- Config key: `display.stream` (boolean, default: `true`)
- Slash command: none needed (use `/config display.stream false` to disable)
- When disabled: current behavior (full response then display)

### Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `src/providers/interface.ts` | Modify | Add `onDelta` to ChatRequest, `StreamDelta` type |
| `src/providers/openai.ts` | Modify | Call onDelta per SSE chunk |
| `src/providers/openai-compat.ts` | Modify | Call onDelta per SSE chunk |
| `src/providers/anthropic.ts` | Modify | Call onDelta per SSE chunk |
| `src/providers/gemini.ts` | Modify | Call onDelta per SSE chunk |
| `src/core/event-bus.ts` | Modify | Add stream events to EventMap |
| `src/core/orchestrator.ts` | Modify | Wire onDelta to event bus |
| `src/core/conversation.ts` | Modify | Add streaming block type and update logic |
| `src/renderer/compositor.ts` | Modify | Handle partial re-render for streaming block |

### Dependencies

- **Phase A (Config):** Reads `display.stream` to decide whether to enable streaming callbacks.

---

## Phase C: Input Enhancements

**What it does:** Adds input history recall, standard editing keybinds, and image paste detection.

**Why:** The input system handles cursor movement, word wrapping, and multiline input, but lacks the standard terminal editing shortcuts and history recall that users expect from a CLI tool.

### Current State

- `src/input/handler.ts` handles raw key events, cursor position, text buffer
- Supports: Ctrl+C, Ctrl+L, Ctrl+U, Ctrl+Shift+C, arrow keys, PageUp/PageDown, mouse events
- No input history (up arrow does nothing in the input buffer)
- No Ctrl+W, Ctrl+A, Ctrl+E, Ctrl+K
- No image paste detection

### Feature C1: Input History

**What:** Up/Down arrow in an empty single-line input recalls previous messages.

**Technical approach:**
- New class `InputHistory` in `src/input/history.ts` (not to be confused with `src/core/history.ts` which is the grid line history)
- Stores an array of previous user inputs (strings)
- Session-based by default; optionally persisted to `~/.config/goodvibes/input-history.json`
- Config key: `behavior.saveHistory` (boolean, default: `true`)
- Max entries: 500 (hardcoded, not configurable initially)

**Behavior:**
- Up arrow when input is empty or at position 0 in history: recall previous message
- Down arrow: recall next message, or clear if at end
- Editing a recalled message creates a new entry (does not modify history)
- Only single-line inputs are recalled (multiline inputs stored but not recalled via arrow)

**Files:** `src/input/history.ts` (create), `src/input/handler.ts` (modify)

### Feature C2: Standard Keybinds

**What:** Standard readline-compatible editing shortcuts.

| Keybind | Action | Description |
|---|---|---|
| Ctrl+W | Delete word backward | Delete from cursor to previous word boundary |
| Ctrl+A | Move to line start | Cursor to beginning of current line |
| Ctrl+E | Move to line end | Cursor to end of current line |
| Ctrl+K | Kill to end of line | Delete from cursor to end of current line |

**Technical approach:**
- All in `src/input/handler.ts`, extending the existing key event switch
- Word boundaries: split on whitespace and punctuation, same as existing word-jump logic
- Ctrl+K stores deleted text for potential yank (future, not in this phase)

**Files:** `src/input/handler.ts` (modify)

### Feature C3: Image Paste Detection

**What:** Detect image data in paste input, show `[IMAGE]` placeholder, include as multimodal content.

**Technical approach:**
- Terminal paste detection is already handled via bracketed paste mode
- Detect base64 image data (PNG/JPEG magic bytes) in pasted content
- When detected: store raw image data, show `[IMAGE: filename or clipboard]` in input buffer
- On submit: convert to multimodal message format (`{ type: 'image', data: base64 }`)
- Requires `ProviderMessage` type extension to support image content parts
- Only works for providers that support vision (OpenAI, Anthropic, Gemini -- not Mercury-2)

**Files:** `src/input/handler.ts` (modify), `src/providers/interface.ts` (modify -- multimodal message type)

### Dependencies

- **Phase A (Config):** History persistence reads `behavior.saveHistory`.
- **No dependency on Phase B.**

---

## Phase D: Reasoning Effort Control

**What it does:** Adds a `/effort` slash command to control reasoning depth across all providers, with provider-specific parameter mapping.

**Why:** Mercury-2 already has `reasoningEffort` in `ChatRequest`, but it's hardcoded. Other providers have equivalent parameters (Claude's extended thinking, Gemini's thinking budget). Users need a unified control.

### Current State

- `ChatRequest.reasoningEffort` exists: `'instant' | 'low' | 'medium' | 'high'`
- Only Mercury-2 (InceptionLabs) uses it
- No UI control for it
- No provider mapping for Claude/Gemini thinking budgets

### Design

#### Slash Command: `/effort`

```
/effort                    Show current effort level
/effort instant            Set to instant (cheapest, fastest)
/effort low                Set to low
/effort medium             Set to medium (default)
/effort high               Set to high (most thorough)
```

#### Provider Parameter Mapping

| Effort Level | Mercury-2 | Claude (Opus/Sonnet 4.6) | Gemini 2.5+ | GPT-5 |
|---|---|---|---|---|
| instant | `reasoning_effort: 'instant'` | `thinking.budget_tokens: 0` | `thinking_config.thinking_budget: 0` | No-op |
| low | `reasoning_effort: 'low'` | `thinking.budget_tokens: 2048` | `thinking_config.thinking_budget: 2048` | No-op |
| medium | `reasoning_effort: 'medium'` | `thinking.budget_tokens: 8192` | `thinking_config.thinking_budget: 8192` | No-op |
| high | `reasoning_effort: 'high'` | `thinking.budget_tokens: 32768` | `thinking_config.thinking_budget: 32768` | No-op |

#### Provider Interface Extension

Extend `ChatRequest` to generalize reasoning control:

```typescript
export interface ChatRequest {
  // ... existing fields
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';  // Already exists
  // Each provider maps this to its native parameter internally
}
```

No new fields needed on `ChatRequest` -- each provider's `chat()` implementation reads `reasoningEffort` and maps it to the appropriate native parameter.

#### Config & Runtime

- Config key: `provider.reasoningEffort` (enum, default: `'medium'`)
- Runtime state: `runtime.reasoningEffort` added to `CommandContext.runtime`
- Shown in the header/footer status bar (future: Phase E)

### Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `src/input/commands.ts` | Modify | Add /effort command |
| `src/input/command-registry.ts` | Modify | Add reasoningEffort to runtime state |
| `src/providers/anthropic.ts` | Modify | Map reasoningEffort to thinking.budget_tokens |
| `src/providers/gemini.ts` | Modify | Map reasoningEffort to thinking_config |
| `src/providers/openai.ts` | Modify | Map reasoningEffort if GPT-5 supports it |
| `src/providers/openai-compat.ts` | Modify | Pass reasoningEffort through |
| `src/core/orchestrator.ts` | Modify | Pass runtime.reasoningEffort to chat request |

### Dependencies

- **Phase A (Config):** Persists `provider.reasoningEffort`.

---

## Phase E: Output Enhancements

**What it does:** Adds line numbers, collapsible blocks, code block copy, and diff apply to the output display.

### Feature E1: Line Numbers

**What:** Optional dimmed line number gutter on assistant output blocks.

**Technical approach:**
- Config key: `display.lineNumbers` (boolean, default: `false`)
- When enabled: prepend a 4-char dimmed gutter (`  1 |`, `  2 |`, etc.) to each output line
- Applied at the conversation block rendering stage, not the compositor
- Numbering resets per block (each assistant response starts at 1)
- Slash command: `/lines` toggles `display.lineNumbers`

**Files:** `src/core/conversation.ts` (modify), `src/input/commands.ts` (modify -- add /lines command)

### Feature E2: Collapsible Blocks

**What:** Tool results and long code blocks auto-collapse when they exceed a threshold.

**Technical approach:**
- Config key: `display.collapseThreshold` (number, default: `30`)
- Blocks exceeding the threshold render as: header line + `[+N lines collapsed -- Tab to expand]`
- Tab key on a collapsed block toggles expansion
- Collapse state tracked per-block in the conversation manager
- New field on display blocks: `collapsed: boolean`
- Tool result blocks auto-collapse by default; code blocks only collapse if over threshold

**Files:** `src/core/conversation.ts` (modify), `src/input/handler.ts` (modify -- Tab toggle), `src/renderer/tool-call.ts` (modify)

### Feature E3: Copy Block

**What:** Keybind to copy an entire code block or tool result to the system clipboard.

**Technical approach:**
- Keybind: Ctrl+Y (yank) when cursor is positioned within a block
- Uses existing `src/utils/clipboard.ts` for clipboard access
- Block targeting: track which block is currently "focused" based on scroll position
- Visual feedback: brief flash/highlight on the copied block

**Files:** `src/input/handler.ts` (modify), `src/utils/clipboard.ts` (modify if needed)

### Feature E4: Diff Apply

**What:** Inline action to apply a displayed diff to the actual file.

**Technical approach:**
- When a diff block is rendered, show an `[Apply]` action indicator
- Keybind: Ctrl+A when a diff block is focused
- Extracts file path and hunks from the diff block
- Runs through the permission system (uses existing `file-edit` tool permissions)
- Applies via the existing `file-edit` tool infrastructure
- Shows success/failure inline

**Files:** `src/renderer/diff-view.ts` (modify), `src/input/handler.ts` (modify), `src/tools/file-edit.ts` (reuse)

### Dependencies

- **Phase A (Config):** Line numbers and collapse threshold read from config.
- **No dependency on B, C, or D.**

---

## Phase F: Quality of Life

**What it does:** Token budget warnings, conversation export, auto-titles, welcome screen improvements, system prompt from file, and better error display.

### Feature F1: Token Budget Warnings

**What:** Warn at 80% context usage and auto-suggest `/compact`.

**Technical approach:**
- Config key: `behavior.autoCompactThreshold` (number, default: `80`)
- After each turn, calculate context usage percentage: `estimateTotalTokens() / maxContextTokens * 100`
- At threshold: show a system message: `Context usage at N%. Consider running /compact.`
- Context limits per model stored in provider registry metadata
- New event: `'context:warning'` with `{ usage: number; threshold: number }`

**Files:** `src/core/orchestrator.ts` (modify), `src/core/conversation.ts` (modify), `src/providers/registry.ts` (modify -- add context limits)

### Feature F2: Conversation Export

**What:** `/export` command saves the conversation as a markdown file.

**Slash command:** `/export [filename]`

**Technical approach:**
- Default filename: `goodvibes-export-{timestamp}.md` in current working directory
- Format: markdown with `## User`, `## Assistant`, `## Tool: {name}` headers
- Code blocks preserved with language tags
- Tool call args shown as JSON code blocks
- Uses `ConversationManager.toJSON()` as the data source, formatted to markdown

**Files:** `src/input/commands.ts` (modify -- add /export command)

### Feature F3: Auto-Generated Title

**What:** Conversation title auto-generated from the first user message, shown in the header.

**Technical approach:**
- After the first user message, extract a title: first 50 chars, truncated at word boundary
- Stored in `ConversationManager` as `title: string`
- Displayed in the header bar next to the model name
- Slash command: `/title [text]` to manually override
- Reset on `/reset`

**Files:** `src/core/conversation.ts` (modify), `src/input/commands.ts` (modify -- add /title), `src/renderer/compositor.ts` (modify -- show title)

### Feature F4: Welcome Screen After Reset

**What:** Re-show the splash/welcome screen after `/clear` and `/reset`.

**Technical approach:**
- `ConversationManager.clearDisplay()` and `resetAll()` already exist
- After clearing, call `addSplashScreen()` to re-render the welcome
- Currently only called once at startup in `main.ts`

**Files:** `src/input/commands.ts` (modify -- update /clear and /reset handlers)

### Feature F5: System Prompt from File

**What:** Load system prompt from a file path, with CLI arg and auto-detection.

**Technical approach:**
- CLI arg: `--system-prompt-file <path>` (already partially exists as `--system-prompt`)
- Auto-detect: check for `.goodvibes/system-prompt.md` in working directory on startup
- Config key: `provider.systemPromptFile` (string, default: `''`)
- Priority: CLI arg > config file > auto-detected file > empty
- File contents loaded once at startup, stored in runtime state
- File changes detected on `/reset` (re-read the file)

**Files:** `src/config/manager.ts` (modify), `src/main.ts` (modify -- auto-detect), `src/core/orchestrator.ts` (modify -- pass to provider)

### Feature F6: Error Display Improvements

**What:** Better error messages with retry countdown, rate limit info, and auth failure guidance.

**Technical approach:**
- Currently errors are caught in orchestrator and shown as plain text
- New: parse error responses for known patterns:
  - Rate limit (429): show retry-after countdown, auto-retry
  - Auth failure (401/403): show guidance ("Check your API key for {provider}")
  - Timeout: show "Request timed out. Retrying in N seconds..."
  - Network: show "Connection failed. Check your network."
- Uses existing `src/utils/retry.ts` infrastructure for auto-retry
- New error display block type with colored severity indicator

**Files:** `src/core/orchestrator.ts` (modify), `src/types/errors.ts` (modify), `src/utils/retry.ts` (modify if needed)

### Dependencies

- **Phase A (Config):** Auto-compact threshold, system prompt file path from config.
- **Phase B (Streaming):** Token counting happens per-turn, works with or without streaming.

---

## Slash Command Registry (All Phases)

### New Commands

| Command | Phase | Description |
|---|---|---|
| `/effort [level]` | D | Set reasoning effort |
| `/lines` | E | Toggle line numbers |
| `/export [file]` | F | Export conversation as markdown |
| `/title [text]` | F | Set/show conversation title |

### Enhanced Commands

| Command | Phase | Enhancement |
|---|---|---|
| `/config` | A | Category browsing, dot-path keys, reset subcommand |
| `/help` | A | Grouped by category |
| `/clear` | F | Re-shows welcome screen |
| `/reset` | F | Re-shows welcome screen, re-reads system prompt file |

### Command Categories for /help

| Category | Commands |
|---|---|
| Model & Provider | `/model`, `/provider`, `/effort` |
| Config & Display | `/config`, `/lines`, `/debug` |
| Conversation | `/clear`, `/reset`, `/compact`, `/export`, `/title` |
| Tools & System | `/tools`, `/help`, `/quit` |

---

## Execution Plan

### Sprint 1: Config System Foundation (Phase A)

**Goal:** Replace frozen config singleton with mutable, persistent, categorized config.

**Files:**
| File | Action | Complexity |
|---|---|---|
| `src/config/schema.ts` | Create | Medium -- define all settings with metadata |
| `src/config/manager.ts` | Create | High -- ConfigManager class with load/save/get/set |
| `src/config/index.ts` | Create | Low -- barrel export |
| `src/config.ts` | Delete | Low -- replaced by module |
| `src/input/commands.ts` | Modify | Medium -- enhanced /config, grouped /help |
| `src/input/command-registry.ts` | Modify | Low -- add ConfigManager to CommandContext |
| `src/main.ts` | Modify | Medium -- initialize ConfigManager, wire to context |
| `src/core/orchestrator.ts` | Modify | Low -- use ConfigManager |
| Tests | Create/Modify | Medium -- ConfigManager unit tests |

**Estimated effort:** 3-4 days
**Risk:** Medium -- touches many files that import `config.ts`, but changes are mechanical.

### Sprint 2: Streaming + Input (Phases B + C)

**Goal:** Real-time token display and input quality-of-life.

**Streaming (B):**
| File | Action | Complexity |
|---|---|---|
| `src/providers/interface.ts` | Modify | Low -- add StreamDelta type, onDelta field |
| `src/providers/openai.ts` | Modify | Medium -- wire SSE chunks to onDelta |
| `src/providers/openai-compat.ts` | Modify | Medium -- wire SSE chunks to onDelta |
| `src/providers/anthropic.ts` | Modify | Medium -- wire SSE chunks to onDelta |
| `src/providers/gemini.ts` | Modify | Medium -- wire chunks to onDelta |
| `src/core/event-bus.ts` | Modify | Low -- add stream events |
| `src/core/orchestrator.ts` | Modify | Medium -- pass onDelta, handle stream lifecycle |
| `src/core/conversation.ts` | Modify | High -- streaming block type, incremental update |
| `src/renderer/compositor.ts` | Modify | High -- partial re-render for streaming |

**Input (C):**
| File | Action | Complexity |
|---|---|---|
| `src/input/input-history.ts` | Create | Medium -- InputHistory class with persistence |
| `src/input/handler.ts` | Modify | Medium -- history recall, new keybinds |
| `src/providers/interface.ts` | Modify | Low -- multimodal message types for images |

**Estimated effort:** 5-7 days
**Risk:** High for streaming -- the compositor partial re-render is the hardest part. Input enhancements are lower risk.

### Sprint 3: Reasoning + Output (Phases D + E)

**Goal:** Reasoning effort control and output display enhancements.

**Reasoning (D):**
| File | Action | Complexity |
|---|---|---|
| `src/input/commands.ts` | Modify | Low -- add /effort command |
| `src/input/command-registry.ts` | Modify | Low -- add reasoningEffort to runtime |
| `src/providers/anthropic.ts` | Modify | Medium -- map to extended thinking |
| `src/providers/gemini.ts` | Modify | Medium -- map to thinking config |
| `src/core/orchestrator.ts` | Modify | Low -- pass reasoningEffort |

**Output (E):**
| File | Action | Complexity |
|---|---|---|
| `src/core/conversation.ts` | Modify | Medium -- line numbers, collapse state |
| `src/input/commands.ts` | Modify | Low -- add /lines command |
| `src/input/handler.ts` | Modify | Medium -- Tab toggle, Ctrl+Y copy, Ctrl+A apply |
| `src/renderer/diff-view.ts` | Modify | Medium -- apply action |
| `src/renderer/tool-call.ts` | Modify | Medium -- collapsible rendering |

**Estimated effort:** 4-5 days
**Risk:** Low-Medium. Provider reasoning mapping may need iteration based on API changes.

### Sprint 4: Quality of Life (Phase F)

**Goal:** Polish features that improve daily usability.

| File | Action | Complexity |
|---|---|---|
| `src/core/orchestrator.ts` | Modify | Medium -- token warnings, error display, system prompt |
| `src/input/commands.ts` | Modify | Medium -- /export, /title, welcome after reset |
| `src/core/conversation.ts` | Modify | Medium -- title generation, export format |
| `src/renderer/compositor.ts` | Modify | Low -- show title in header |
| `src/providers/registry.ts` | Modify | Low -- context limit metadata |
| `src/types/errors.ts` | Modify | Low -- structured error types |
| `src/utils/retry.ts` | Modify | Low -- rate limit countdown |
| `src/main.ts` | Modify | Low -- auto-detect system prompt file |

**Estimated effort:** 3-4 days
**Risk:** Low. All features are independent and testable in isolation.

---

## Dependency Graph

```
Phase A (Config) ──────────────────────────────────────┐
    │                                                   │
    ├── Phase B (Streaming) ──── reads display.stream   │
    │                                                   │
    ├── Phase C (Input) ──────── reads behavior.saveHistory
    │                                                   │
    ├── Phase D (Reasoning) ──── reads provider.reasoningEffort
    │                                                   │
    ├── Phase E (Output) ─────── reads display.lineNumbers,
    │                            display.collapseThreshold
    │                                                   │
    └── Phase F (QoL) ────────── reads behavior.autoCompactThreshold,
                                 provider.systemPromptFile

Phases B-F can proceed in parallel after Phase A is complete.
Phases B, C, D, E, F have no dependencies on each other.
```

---

## Success Criteria

- [ ] Config system fully replaces frozen singleton
- [ ] All 11 settings accessible via `/config` with dot-path syntax
- [ ] Settings persist across sessions
- [ ] Streaming display shows tokens in real-time
- [ ] Input history recalls previous messages with up/down arrows
- [ ] Ctrl+W, Ctrl+A, Ctrl+E, Ctrl+K keybinds work
- [ ] `/effort` controls reasoning depth across all providers
- [ ] Line numbers, collapsible blocks, copy, and diff apply work
- [ ] Token budget warnings appear at threshold
- [ ] `/export` produces valid markdown
- [ ] All existing 322+ tests continue to pass
- [ ] New tests cover all new features
