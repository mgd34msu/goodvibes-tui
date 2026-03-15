# Session Handoff — GoodVibes TUI v0.2.0

> This document prepares a new session to continue development.
> Written 2026-03-15 at the end of a long implementation session.

---

## Project Overview

**goodvibes-tui** is a terminal-based AI coding assistant (like Claude Code, Gemini CLI, Codex). Built with Bun + TypeScript, no React/Ink — raw ANSI cell-based rendering with a custom diff engine.

- **Runtime:** Bun
- **Test runner:** `bun test` with `bun:test` imports (NOT vitest)
- **Build:** `bun run build` compiles to `dist/goodvibes`
- **Entry point:** `src/main.ts`
- **Version:** 0.2.0
- **Tests:** 723 across 44 files (2 flaky due to global config state on dev machine)
- **Lines:** ~20,800 TypeScript

---

## What Was Built This Session

### ADDITIONS.md (Phases A–F) — All Complete

The original spec (`ADDITIONS.md`, now archived) defined 6 phases:

| Phase | What | Status |
|-------|------|--------|
| A: Config System | Replace frozen singleton with layered, persistent ConfigManager | Done, 9.9/10 |
| B: Streaming | Real-time token display via onDelta callbacks | Done, 9.9/10 |
| C: Input | History recall, readline keybinds, image paste | Done, 9.9/10 |
| D: Reasoning | /effort command, provider reasoning mapping | Done, 9.9/10 |
| E: Output | Line numbers, collapsible blocks, copy, diff apply | Done, 9.9/10 |
| F: QoL | Token warnings, /export, titles, system prompt, error display | Done, 9.9/10 |

### ENHANCEMENTS.md (Batches 1–5) — All Complete

The enhancement spec (now archived) defined 25 enhancements across 5 batches:

| Batch | Enhancements | Status |
|-------|-------------|--------|
| 1: Foundation | A1 config migration to ~/.goodvibes/tui/, X1 system prompt chain loading, F1 named sessions | Done |
| 2: Core UX | C1 multi-@, C2 !@ injection, E1 Ctrl+F search, F2 undo/redo, F7 retry | Done |
| 3: Power Features | C3 tab completion, C4 prompt undo/redo, C5 templates, X3 permissions | Done |
| 4: Display & Polish | B1 thinking, D3 reasoning summary, X2 progress bars, E2 links, E3 expand/collapse, E4 bookmarks, A2 profiles | Done |
| 5: Nice-to-Have | A3 config diff, B2 tokens/sec, B3 tool preview, F3 token data, F8 notifications | Done |

### Interactive Modals — Complete

After the spec work, we built interactive modal UIs:

- **Model picker** — `/model` → all models → effort picker (3-step flow)
- **Provider picker** — `/provider` → providers → models → effort
- **Generic SelectionModal** — reusable component with fuzzy search, categories, custom actions
- **Wired into:** /config (space toggles values inline), /template, /sessions, /bookmarks, /tools, /permissions, /help
- **Help modal** — searchable, selecting a command executes it via registry

### Image Input Pipeline — Complete

Full end-to-end multimodal image support:
- 4 input methods: @ file picker, paste base64, paste file path, Ctrl+V clipboard grab (wl-paste/xclip/pngpaste)
- Formats: PNG, JPEG, WebP, GIF (base64 prefix + raw binary magic byte detection)
- Pipeline: imageRegistry → expandPrompt → ContentPart[] → event bus → orchestrator → provider format converters → LLM API
- Capability check strips images with warning for non-multimodal models
- Atomic markers: `[IMAGE: imgN, name, size]` — cursor skips, backspace deletes whole marker

### UI Polish — Done

- Animated thinking indicator (20 vaporwave phrases, cyan↔purple gradient, triangle wave)
- Dynamic line number gutter (width scales with total lines)
- Single "Context Usage" progress bar with `[ used / max ]` token counts
- Ctrl+L full screen clear via `clear:screen` event
- CSI u tokenizer fix for all letter-based keybinds in modern terminals

---

## Architecture

### Directory Structure

```
src/
  main.ts                 # Entry point, module wiring, render loop
  config/
    schema.ts             # GoodVibesConfig type, CONFIG_SCHEMA, defaults
    manager.ts            # ConfigManager (load/save/get/set/reset)
    index.ts              # Barrel export, backward-compat Proxy
  core/
    orchestrator.ts       # LLM turn lifecycle, tool execution, streaming
    conversation.ts       # Message storage, history buffer, block registry
    event-bus.ts          # Typed pub/sub event system
    history.ts            # InfiniteBuffer (line storage)
    tokenizer.ts          # Raw stdin → InputToken (CSI u, mouse, paste)
  input/
    handler.ts            # Keyboard/mouse handling, all keybinds (~1650 lines)
    commands.ts           # All slash commands (~1270 lines)
    command-registry.ts   # CommandRegistry, CommandContext interface
    autocomplete.ts       # Slash command autocomplete
    file-picker.ts        # @ file picker modal
    model-picker.ts       # Model/provider/effort picker modal
    selection-modal.ts    # Generic selection modal with fuzzy search
    search.ts             # SearchManager for Ctrl+F
    input-history.ts      # Up/down history recall
    selection.ts          # Mouse text selection
  providers/
    interface.ts          # LLMProvider contract, StreamDelta, ContentPart, REASONING_BUDGET_MAP
    registry.ts           # MODEL_REGISTRY (14 models), ProviderRegistry
    openai.ts             # OpenAI streaming provider
    openai-compat.ts      # Generic OpenAI-compatible (Mercury-2)
    anthropic.ts          # Anthropic SSE streaming + extended thinking
    gemini.ts             # Gemini streaming + thinking config
    tool-formats.ts       # Wire format converters (OpenAI/Anthropic/Gemini)
  renderer/
    compositor.ts         # Layout engine, diff-based rendering
    diff.ts               # ANSI diff engine with OSC 8 link support
    buffer.ts             # TerminalBuffer (2D cell grid)
    ui-factory.ts         # Header, footer, thinking indicator, progress bars
    markdown.ts           # Markdown → Line[] with syntax highlighting
    code-block.ts         # Syntax-highlighted code blocks
    diff-view.ts          # Unified diff rendering
    file-tree.ts          # Directory tree rendering
    tool-call.ts          # Tool call block rendering
    progress.ts           # Token bar rendering
    file-picker-overlay.ts
    model-picker-overlay.ts
    selection-modal-overlay.ts
    search-overlay.ts
  tools/                  # 7 built-in tools (file_read/write/edit, shell_exec, grep, list_dir, glob)
  permissions/            # PermissionManager with allow-all/prompt/custom modes
  acp/                    # Agent Client Protocol (subagent spawning)
  sessions/               # SessionManager (JSONL persistence)
  templates/              # TemplateManager ({{var}} expansion, chaining)
  bookmarks/              # BookmarkManager
  profiles/               # ProfileManager (config profiles)
  utils/                  # clipboard, logger, retry, terminal-width, glob-to-regex, path-safety, prompt-loader, notify, error-display
  types/                  # errors.ts, grid.ts (Cell/Line), tools.ts
  test/                   # 44 test files organized by module
```

### Key Design Patterns

1. **Cell-based rendering** — Every character on screen is a `Cell` with char, fg, bg, bold, dim, italic, underline, strikethrough, link. The compositor diffs old→new buffer and emits only changed cells.

2. **Event bus** — Typed `EventBus` decouples modules. Key events: `render:request`, `input:submit`, `turn:stream-delta`, `clear:screen`, `model-picker:complete`, `search:update`.

3. **Overlay pattern** — Modals (file picker, model picker, selection modal, search bar) render as `Line[]` appended to the viewport. `overlayRows` shrinks the conversation viewport to make room.

4. **Config layering** — Defaults < global TUI (`~/.goodvibes/tui/settings.json`) < project TUI (`.goodvibes/tui/settings.json`) < env vars < CLI args. Append-only on startup.

5. **Provider abstraction** — All 4 providers implement `LLMProvider.chat()` returning `ChatResponse`. Streaming via `onDelta` callback. Format converters handle wire protocol differences.

6. **Backward-compat Proxy** — `config` singleton uses a Proxy that delegates to `ConfigManager.getRaw()` for zero-breaking-change migration from the old frozen config.

---

## File Locations

```
~/.goodvibes/
  goodvibes.json          # Shared cross-app settings (mostly empty)
  SYSTEM.md               # Base system prompt (global)
  GOODVIBES.md            # User-editable global extensions
  tui/
    settings.json         # TUI config
    input-history.json    # Prompt history
    profiles/             # Config profiles
    templates/            # Prompt templates
    sessions/             # Saved sessions (JSONL)
    bookmarks/            # Saved bookmarks

.goodvibes/               # Project-level
  GOODVIBES.md            # Project-specific instructions
  tui/
    settings.json         # Project config overrides
    templates/            # Project templates
    sessions/             # Project sessions
```

---

## Integration Issues Fixed This Session

These were found during a manual feature completeness audit and fixed:

1. **Orchestrator systemPrompt** — Now uses `getSystemPrompt()` callback instead of `config.systemPrompt` Proxy (which did disk reads per turn)
2. **Image multimodal pipeline** — Full end-to-end: `ContentPart[]` flows through all providers
3. **Collapse state** — Keyed by stable `msg_N` instead of render-time counter
4. **Streaming performance** — Incremental buffer update via `truncateToLine()` instead of full rebuild per token
5. **`/tools`** — Reads from `ToolRegistry.list()` instead of hardcoded names
6. **Diff apply** — Validates path with `resolveAndValidatePath` before fs ops
7. **Paste markers** — Atomic: `[TEXT: pN, N lines]` with ID-based lookup, cursor skips over them
8. **CSI u tokenizer** — Maps ASCII charCodes to letter names for Kitty keyboard protocol

---

## Integration Issues Still in the Log (may be outdated)

The file `.goodvibes/logs/integration-issues.md` contains issues found during the audit. Most were fixed, but verify:

- Issue 7 (misleading tool filter comment) — cosmetic, may still be present
- Issue 8 (/clear double rebuild) — was fixed by removing redundant `rebuildHistory()` call
- Issue 9 (Anthropic beta header) — was fixed, `anthropic-beta: interleaved-thinking-2025-05-14` added conditionally

---

## Known Gaps / Not Implemented

### From user feedback (project_feature_review.md memory)
- **Image paste UX** — Ctrl+V works for clipboard images on Wayland (wl-paste). Middle-click tries image first, text second. Raw binary detection works for bracketed paste. macOS requires `pngpaste` installed.

### From ideas-for-future.md
- **E5: Diff syntax in prose** — detect "change X to Y" in LLM output and render as inline diff. Deferred due to false-positive risk.
- **F4: Git-aware context** — branch in header, `/diff` command. Part of a future git module.
- **F5: /commit command** — generate commit message from conversation. Part of the git module.

### From ENHANCEMENTS.md (archived, was fully implemented)
- **D1: Auto-effort** — explicitly rejected by user as counterintuitive
- **D2: Cost estimate** — not needed now
- **F6: Tool result caching** — user has own tooling for this

### Known test failures
- 2 ConfigManager tests fail on the dev machine because `~/.goodvibes/tui/settings.json` has non-default values that override defaults. Tests use `cm.reset()` but the global file persists. Not a code bug — it's an environment-specific test isolation issue.

---

## Design Decisions & Rationale

### Why cell-based rendering (not Ink/React)
The user wanted a low-level substrate they fully control. Ink adds React overhead and limits layout control. Cell-based rendering with a diff engine gives pixel-perfect control and minimal terminal writes.

### Why `~/.goodvibes/tui/` for config
All goodvibes programs share `~/.goodvibes/`. The `tui/` subdirectory provides app separation. Config, history, sessions, templates, bookmarks, profiles all live under `tui/`. Project-level overrides go in `.goodvibes/tui/`.

### Why JSONL for sessions
Append-friendly format. Each message is one line. Supports `removed: true` for undo without data loss. Meta line at the top for title/model/timestamp.

### Why templates use `{{var}}` syntax
User specifically requested variables that can be text, files, images, or template references. Templates can chain via `{{template:name}}`. Positional and named args supported.

### Why streaming rebuilds were a problem
The original streaming implementation called `markDirty()` on every delta, triggering `rebuildHistory()` (O(n) over all messages) on every token. Fixed by using `streamingStartLine` + `truncateToLine()` to only re-render from the streaming block start.

### Why OSC 8 links
Modern terminals (Kitty, iTerm2, Ghostty, recent Alacritty) support OSC 8 hyperlinks. Terminals that don't support them silently ignore the escape sequences. Zero cost for unsupported terminals.

### Why the selection modal is generic
The user requested modals for every list-based command. Rather than building individual modals, one reusable `SelectionModal` serves all: /config, /template, /sessions, /bookmarks, /tools, /permissions, /help. Supports fuzzy search, categories, custom actions (d=delete, e=edit, space=toggle).

### Why space toggles in config modal don't close it
The user specifically requested this — you should be able to toggle multiple settings without reopening the modal each time.

### Why `/help` is a modal
The user requested it so help doesn't take up permanent space in the conversation output.

---

## User Preferences

- **Test runner:** `bun test` with `bun:test` imports. NOT vitest. Reviewers kept flagging this incorrectly.
- **Review threshold:** Set to 9.9/10 in the runtime engine. All features were reviewed and fixed to meet this.
- **Max concurrent agents:** 12 (runtime config)
- **Vaporwave aesthetic:** The splash screen, thinking indicator, and general design follow a cyan/purple vaporwave theme
- **Vim keys:** Search navigation supports hjkl (only jk advertised in hints)
- **Shared config convention:** All goodvibes programs use `~/.goodvibes/`. TUI files go in `tui/` subdirectory.
- **Config file behavior:** Append-only on startup (never overwrite existing values), immediate persist on change
- **Help text color:** Light grey (252), not purple (135)

---

## How to Continue

1. **Read this file** and `CHANGELOG.md`
2. **Check `ideas-for-future.md`** for deferred features
3. **Run `bun test`** to verify baseline (expect 721-723 pass, 0-2 env-specific failures)
4. **Run `bun run build`** to verify compilation
5. **Try the app:** `bun run dev` or `./dist/goodvibes`
6. **Key files to read first:** `src/main.ts` (wiring), `src/input/handler.ts` (all input), `src/input/commands.ts` (all commands)

### Likely next tasks
- Fix the 2 flaky ConfigManager tests (need test isolation from global settings file)
- Review and fix remaining modal rendering issues (model picker capability line alignment varies per model)
- Implement the git module (F4/F5 from ideas-for-future.md)
- Consider inline terminal image display (Kitty/Sixel protocol) — requires renderer overhaul
- Performance profiling on long conversations (streaming is fixed, but initial render of 1000+ messages untested)
