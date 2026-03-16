# Changelog

All notable changes to GoodVibes TUI.

---

## [0.9.3] — 2026-03-16

### Bundled LSP Servers
- **Zero-config language intelligence** — TypeScript, Python, Bash, CSS, HTML, and JSON language servers ship as npm dependencies
- **Lazy binary download** — rust-analyzer auto-downloads from GitHub releases with SHA256 verification on first use
- **gopls auto-install** — installed via `go install` with GOBIN override if Go is on PATH
- **resolveCommand()** — 3-tier server resolution: node_modules/.bin → .goodvibes/bin → system PATH
- Fixed CSS/HTML server names (camelCase → hyphenated), added JSON server, added tsx config entry
- Fixed gopls args (added missing `serve` subcommand)

### Danger Zone
- **`/danger` command** — dedicated slash command for viewing/toggling danger settings
- **Red danger styling** — danger settings render in red (#ef4444) in `/help`, `/config`, and `/settings` modals
- **DANGER MODE warning** — persistent red "\u26a0 DANGER MODE \u2014 ALL CHANGES AUTO-APPROVED" in footer when autoApprove, allow-all, or all individual permissions are set to allow
- **`/danger` selection modal** — dedicated modal with Enter-to-toggle for boolean danger settings

### UI / UX
- **`/config` shows all 6 categories** — was hardcoded to only display/provider/behavior; now includes permissions, danger, tools
- **`/effort` selection modal** — interactive picker with descriptions, pre-selected on current level
- **Per-item color in selection modals** — `SelectionItem.fg` field enables per-item foreground color overrides
- **Bookmark modal wired** — `renderBookmarkModal` was never called in the render loop; now properly rendered
- **Bottom-anchored modal positioning** — all overlay modals (selection, file-picker, model-picker, bookmark) use actual rendered line counts instead of estimated overlayRows
- **Viewport height from actual sizes** — vHeight computed from real header/footer line counts, not hardcoded FOOTER_BASE_ROWS estimate

### Tool Improvements
- **Discovery hints** — tool descriptions now include "Discovery:" hints telling the AI how to discover runtime state (state, workflow, fetch, registry, agent tools)
- **read tool ast mode** — fixed description from "Phase 3 placeholder" to accurately describe tree-sitter implementation

### Documentation
- **README tools section rewrite** — flat table replaced with per-tool subsections highlighting differentiators vs Claude Code/Gemini CLI/Codex
- **LSP documentation** — bundled servers, auto-download, and optional prerequisites documented
- **Updated .gitignore** — added node_modules/, dist/, .goodvibes/, scripts/reset-suite.sh

### Cleanup
- Removed full-suite/ test fixtures and tool-updates-v3.md
- Removed stale package-lock.json (project uses bun.lock)

---

## [0.9.0] — Production-Ready Release

### Phase A: Foundation — Integration Wiring
- **Hook system wired into orchestrator** — every tool call now fires Pre/Post/Fail hooks via HookDispatcher
- **Tree-sitter wired into read tool** — outline/symbols/ast modes use CodeIntelligence with regex fallback
- **Tree-sitter wired into find tool** — expand_to support via getEnclosingScope(), symbols use tree-sitter
- **GitService wired into analyze** — diff mode uses GitService.diffBetween/diffStat instead of raw Bun.spawn
- **Permission system updated** — all 12 tools mapped to categories (read/write/edit/exec/find/fetch/analyze/inspect/agent/state/workflow/registry)
- **Tree-sitter grammars installed** — TypeScript, JavaScript, Python, JSON, CSS WASM grammars
- **Shared ProcessManager singleton** — extracted from exec tool for cross-module process tracking

### Phase B: Infrastructure
- **File watcher** — debounced fs.watch with path boundary enforcement, cache invalidation, hook dispatch
- **Tool LLM** — configurable LLM for tool-internal operations (semantic diff, auto-heal, commit messages)
- **Secrets manager** — AES-256-GCM encrypted storage with 3-tier resolution (env → encrypted file → null)
- **Auto-heal** — 3-stage pipeline (formatter → linter → ToolLLM) for write/edit validation failures
- **Overflow handler** — large outputs written to .goodvibes/.overflow/ with truncated reference
- **ModeManager** — output mode management (vibecoding/justvibes/default) with per-mode verbosity defaults
- **Prompt hook runner** — LLM-powered hook execution with $ARGUMENTS substitution and timeout

### Phase C: Tool Mode Expansion
- **find: references** — LSP textDocument/references with grep fallback
- **find: structural** — @ast-grep/napi AST pattern matching
- **find: expand_to** — tree-sitter expands matches to enclosing function/class scope
- **edit: ast + ast_pattern** — tree-sitter structural edits, ast-grep with $VAR/$$$VAR metavariable substitution
- **edit: validation chains** — validate.before/after with typecheck/lint/test/build via Bun.spawn
- **exec: progress + fail_fast** — pollable progress files, stop_on_error for sequential commands
- **fetch: structured/tables/pdf** — CSS selector extraction, HTML table parsing, PDF text extraction
- **fetch: service auth** — service registry with bearer/basic/api-key from SecretsManager
- **analyze: breaking + semantic_diff** — GitService diff + ToolLLM for impact analysis
- **analyze: upgrade/permissions/env_audit/test_find** — package compat, dangerous patterns, .env consistency, source→test mapping
- **inspect: api_spec/api_validate/api_sync** — OpenAPI generation, contract validation, frontend/backend drift detection
- **inspect: 11 frontend modes** — component_state, render_triggers, hooks, overflow, sizing, stacking, responsive, events, tailwind, client_boundary, error_boundary
- **read: image/PDF/notebook** — base64 images with mediaType, PDF text extraction, Jupyter .ipynb cell parsing
- **state: hooks + mode** — hook management (list/enable/disable/add/remove) and output mode switching

### Phase D: Agent Execution
- **In-process agent orchestrator** — each agent gets own ConversationManager + scoped ToolRegistry, async turn loop with MAX_TURNS=50 and cancellation check
- **Session isolation** — own message history, namespaced KVState, JSONL logging per agent
- **Git worktree lifecycle** — create on spawn, merge on complete, cleanup on cancel/error
- **Inter-agent message bus** — send/broadcast/subscribe with 5-minute TTL auto-cleanup
- **Agent actions** — get (detail), budget (tokens), plan, wait (with timeout), message
- **Agent archetypes** — load .goodvibes/agents/*.md with YAML frontmatter, progressive loading
- **Agent hook runner** — spawn agent on hook fire, poll for completion with timeout

### Phase E: UI
- **Modal factory** — shared rendering with box/title/footer/hints, composable sections, display-width-aware truncation
- **Background process indicator** — persistent status bar below input showing agent/tool counts
- **Background process modal** — list by type, navigate, peek, kill
- **Live-tail modal** — streaming output with scroll clamping and kill action
- **Service registry modal** — /services command for managing API service configurations
- **Git state in header** — branch name, dirty indicator (●), ahead/behind arrows (↑↓), stale-while-revalidate caching

### Phase F: External Integration
- **MCP client** — connect to servers from .goodvibes/mcp.json, JSON-RPC 2.0 over stdio, auto-restart on crash
- **MCP progressive loading** — names + descriptions at startup, full schemas on first use, cached
- **MCP permissions** — 'mcp' category added, default 'prompt'
- **Registry: fuse.js** — fuzzy search weighted name×3 > path×2 > description×1
- **Workflow: triggers wired** — hook events check TriggerManager, execute actions via Bun.spawn
- **Workflow: schedules wired** — setInterval execution with parseInterval('5m'/'1h'/'30s')
- **Workflow: daemon/external** — DaemonServer POST /task → AgentManager.spawn(), HttpListener POST /webhook → HookDispatcher.fire()
- **State: analytics + telemetry** — sql.js WASM SQLite for tool call recording, query, summary, export

### Phase G: Security & Polish
- **Spawn token expiry** — expiresAt field with 1-hour TTL, included in HMAC signature
- **HTTP listener security** — bearer token auth with timingSafeEqual, sliding-window rate limiting (60/min), localhost enforcement
- **Daemon security** — bearer token auth with timingSafeEqual on all endpoints, task submission logging
- **Credential encryption** — SecretsManager wired into API key resolution, /secrets command (set/get/list/delete)
- **Permission audit** — 58 tests verifying all 12 tools + danger gates + path traversal protection
- **Dependency verification** — 43 smoke tests for all added packages (@ast-grep/napi, fuse.js, sql.js, tree-sitter grammars, etc.)
- **2649 passing tests** across 120 files

### Phase H: Modals & Interactivity
- **Config/settings browser** — /settings opens modal with category tabs, inline boolean toggle, enum cycling, string/number editing
- **Session picker** — /sessions opens modal with title, timestamp, message count; Enter to load, 'd' to delete
- **Profile picker** — /profiles opens modal with preview; Enter to load, 'd' to delete, 's' to save current
- **Bookmark browser** — /bookmarks opens modal with labels and timestamps; Enter to navigate, 'o' to open file, 'd' to remove
- **Help/shortcuts overlay** — '?' key or /help toggles full-screen categorized shortcut reference with live command list
- **Agent detail modal** — deep view from process modal showing task, tools, tokens, messages, progress
- **Context inspector** — /context shows per-message token breakdown, large consumer detection (>10%), capacity bar, compaction suggestions
- **Apply diff action** — 'a' key on diff blocks applies changes to file with confirmation
- **Block actions menu** — Enter on a block shows type-filtered actions (copy/apply/bookmark/rerun/collapse)
- **Code block collapse** — extended collapse system to code blocks and thinking blocks with auto-collapse threshold
- **Error navigation** — /next-error, /prev-error, Ctrl+E to jump between error messages

### Infrastructure
- 2649 passing tests across 120 files (2721 total, 72 pre-existing)
- ~120 new source files, ~60 modified files
- 67 tasks across 8 phases, all reviewed at 9.9+ minimum score
- Dependencies added: @ast-grep/napi, fuse.js, sql.js, tree-sitter grammars (TS/JS/Python/JSON/CSS), web-tree-sitter

---

## [0.2.0]

### Interactive Modals
- **Model picker** — `/model` opens bordered modal with all models, capability details, provider → model → effort multi-step flow
- **Provider picker** — `/provider` opens provider list → filtered models → effort
- **Generic selection modal** — reusable fuzzy-searchable modal with category grouping, custom actions (delete, edit, toggle)
- **Help modal** — `/help` opens searchable modal instead of printing text; selecting a command executes it
- **Config modal** — Space toggles booleans / cycles enums inline without closing
- All list commands use modals: `/config`, `/template`, `/sessions`, `/bookmarks`, `/tools`, `/permissions`
- Modals open even when lists are empty (shows helpful placeholder)

### UI Polish
- Animated thinking indicator with rotating vaporwave phrases and cyan↔purple gradient
- Dynamic line number gutter (width scales with line count, content shifted right)
- Single "Context Usage" progress bar in footer with `[ used / max ]` token counts
- Footer context info line spacing and alignment
- Splash screen repositioned
- `/help` text color changed to light grey for readability
- Ctrl+L now fully clears and repaints the screen
- Command mode backspace properly tracks cursor position

### Model Registry
- Claude Opus 4.6: context window updated to 1M tokens
- Claude Sonnet 4.6: context window updated to 1M tokens

---

## [0.1.0] — ADDITIONS.md Phases A–F + ENHANCEMENTS.md Batches 1–5

### Phase A: Config System
- ConfigManager with 11+ typed settings across display, provider, behavior, permissions categories
- `/config` — show all, by category, by dot-path key, set and auto-persist
- `/config reset [key]` — reset to defaults
- `/config diff` — show settings changed from defaults
- `/config profile save/load/list/delete` — TUI-specific config profiles
- Backward-compatible config Proxy singleton
- Old flat config auto-migration to `~/.goodvibes/tui/settings.json`
- Project-level config overrides from `.goodvibes/tui/settings.json`
- Deep merge with clone safety, lazy initialization

### Phase B: Streaming
- `onDelta` callback on `ChatRequest` for real-time token display
- All 4 providers stream via onDelta (OpenAI, OpenAI-compat, Anthropic SSE, Gemini)
- Tool call and reasoning/thinking deltas emitted during streaming
- `startStreamingBlock` / `updateStreamingBlock` / `finalizeStreamingBlock` lifecycle
- Incremental buffer update (no full rebuild per token)
- `isStreaming` flag with proper abort cleanup
- `turn:stream-start` / `turn:stream-delta` / `turn:stream-end` events
- Optional tokens/sec counter (`display.showTokenSpeed`, default off)
- Optional partial tool call preview (`display.showToolPreview`, default off)

### Phase C: Input
- InputHistory with up/down recall, draft saving, dedup, persistence to `~/.goodvibes/tui/input-history.json`
- Ctrl+W — delete word backward
- Ctrl+A — move to line start (or apply diff)
- Ctrl+E — move to line end
- Ctrl+K — kill to end of line
- Ctrl+Z / Ctrl+Shift+Z — undo/redo in prompt editing (50-entry bounded stack)
- Ctrl+V — paste with image-first priority (multi-MIME clipboard)
- Ctrl+F — search conversation output (type query → Enter/Tab locks → arrows/jk navigate matches)
- Multi-file `@` references in a single prompt
- `!@filepath` content injection (reads file on submit)
- Tab path completion with fuzzy matching and cycling
- Image paste detection: PNG, JPEG, WebP, GIF (base64 + raw binary magic bytes)
- Full multimodal pipeline: image → ContentPart[] → provider format converters → LLM
- Atomic paste/image markers: `[TEXT: pN, N lines]`, `[IMAGE: imgN, name, size]`
- Cursor skips over markers, backspace/delete removes whole marker
- Capability check: strips images with warning for non-multimodal models

### Phase D: Reasoning Effort
- `/effort` command (show/set instant/low/medium/high)
- Shared `REASONING_BUDGET_MAP` constant
- Anthropic `thinking.budget_tokens` mapping with `anthropic-beta` header
- Gemini `thinking_config.thinking_budget` mapping
- Orchestrator reads effort from configManager per turn
- `max_tokens` auto-bumped when thinking budget exceeds it

### Phase E: Output
- `/lines` — toggle line number gutter on assistant output
- Collapsible tool result blocks (auto-collapse over threshold, Tab toggle)
- Ctrl+Y — copy nearest block to clipboard
- Ctrl+A — apply displayed diff to file (with permission check, occurrence validation)
- `/expand [type]` and `/collapse [type]` — filter by all/thinking/tool/code/diff
- OSC 8 hyperlinks for URLs and file paths in markdown output
- Ctrl+B — bookmark/unbookmark nearest block
- Ctrl+S — save nearest block content to file in `.goodvibes/tui/bookmarks/`
- `/bookmarks` — list and jump to bookmarks
- `parseDiffForApply`, `applyDiffContent` utilities
- `findNearestBlock` with type filter, `getBlockRegistry()` public accessor
- `'thinking'` block type for reasoning content

### Phase F: Quality of Life
- Token budget warning with 10%-bracket debounce at configurable threshold
- `/export [filename]` — async save conversation as markdown
- Auto-generated conversation title from first message (CJK-aware truncation)
- `/title [text]` — manual title override, shown in header
- Welcome screen re-shown after `/reset`
- System prompt chain loading: `~/.goodvibes/SYSTEM.md` + `GOODVIBES.md` with `@` includes, circular detection, max depth 5
- `ProviderError` with `guidance` and `retryAfterMs`, `formatProviderError` in orchestrator
- `/undo` / `/redo` — turn-based undo with stack, cleared on new input
- `/retry [text]` — re-send last message, optionally modified
- `/save [name]` / `/load <name>` / `/sessions` — named sessions in JSONL format
- Token usage (input/output/cache) stored per assistant message for future cost tracking
- Completion notifications: terminal bell (>5s), desktop notification via notify-send/osascript (>30s)
- `behavior.notifyOnComplete` config key (default true)

### Enhancement A1: Shared Config System
- Config migrated from `~/.config/goodvibes/` to `~/.goodvibes/tui/settings.json`
- Project-level overrides from `.goodvibes/tui/settings.json`
- Load order: defaults < global TUI < project TUI < env vars < CLI args
- Auto-migration from old paths
- `~/.goodvibes/goodvibes.json` shared cross-app config created

### Enhancement X1: System Prompt Chain Loading
- `readPromptFile()` with recursive `@` include resolution
- Circular detection via shared Set, max depth 5
- `@@` escape for literal `@` lines
- ENOENT vs other error distinction (debug vs error logging)
- Extracted to `src/utils/prompt-loader.ts` for testability

### Enhancement X3: Granular Permissions
- `/permissions` command with allow-all / prompt / custom modes
- Per-tool allow/prompt/deny settings
- 3-level dot-path config keys (`permissions.tools.file_read`)
- Config-driven `PermissionManager` with explicit unknown-tool handling

### Enhancement C5: Prompt Templates
- `/template save/use/list/edit/delete`
- `{{var}}` variables with positional and named args
- `{{template:name}}` chaining (max depth 3)
- Templates stored in `~/.goodvibes/tui/templates/`

### CSI u Tokenizer Fix
- Map ASCII letter charCodes to logicalName for Kitty keyboard protocol
- Fixes Ctrl+V/W/A/E/K/Y/Z and all letter-based keybinds in modern terminals

### Infrastructure
- 723+ tests across 44 files
- 20,700+ lines of TypeScript
- `DeepReadonly` type for config snapshots
- `TokenUsage` shared type
- `escapeAppleScript` for safe desktop notifications
- `BookmarkManager`, `ProfileManager`, `SessionManager`, `TemplateManager` with lazy singletons
- `SelectionModal` generic component with fuzzy search
- `SearchManager` with match navigation and viewport scrolling

---

## [0.0.1] — Initial Prototype

- TUI substrate with alt-screen, cell-based renderer, diff engine
- 4 LLM providers: OpenAI, Anthropic, Gemini, InceptionLabs (Mercury-2)
- 7 built-in tools: file_read, file_write, file_edit, shell_exec, grep, list_dir, glob
- ACP subagent protocol integration
- Permission system with session caching
- Markdown renderer with syntax-highlighted code blocks
- Diff view renderer
- File tree renderer
- Mouse support (selection, scroll, middle-click paste)
- Clipboard (OSC 52 copy, platform paste)
- Slash commands: /model, /provider, /help, /clear, /reset, /compact, /config, /tools, /debug, /quit
- @ file picker with fuzzy matching
- Conversation persistence and resume
