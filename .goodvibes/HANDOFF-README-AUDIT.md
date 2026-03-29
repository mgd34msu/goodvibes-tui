# README Audit Handoff Document

## Session Date: 2026-03-29

## What Was Read (Complete)

Every source file in the following directories was read in FULL content mode (no outlines, no skipping):

### Fully Read Directories
- `src/core/` — All 10 files (orchestrator, conversation, event-bus, compaction, tokenizer, intent-classifier, execution-plan, event-replay, history, plan-manager-instance)
- `src/providers/` — All 14 files (registry, synthetic, model-catalog, model-benchmarks, auto-register, favorites, interface, anthropic, openai, gemini, openai-compat, anthropic-compat, custom-loader, tool-formats, effort-levels, tier-prompts, model-limits)
- `src/agents/` — All 9 files (orchestrator, wrfc-controller, archetypes, message-bus, worktree, session, completion-report, wrfc-types, wrfc-workmap)
- `src/acp/` — All 4 files (connection, manager, protocol, index)
- `src/discovery/` — All 3 files (scanner, mcp-scanner, index)
- `src/hooks/` — All 8 files (dispatcher, chain-engine, matcher, types, index, runners/command, runners/http, runners/prompt, runners/typescript, runners/agent)
- `src/mcp/` — All 3 files (client, config, registry)
- `src/config/` — All 6 files (index, manager, schema, secrets, service-registry, tool-llm)
- `src/state/` — All 12 files (kv-state, file-cache, project-index, index, json-file-store, persistent-store, mode-manager, telemetry, file-undo, file-watcher, db, sqlite-store)
- `src/types/` — All 5 files (errors, grid, tools, sql-js.d.ts, wasm-files.d.ts)
- `src/utils/` — All 11 files (logger, retry, clipboard, notify, error-display, path-safety, glob-to-regex, prompt-loader, splash-lines, terminal-width, walk-dir)
- `src/permissions/` — All 2 files (manager, prompt)
- `src/security/` — All 3 files (index, spawn-tokens, user-auth)
- `src/bookmarks/` — 1 file (manager)
- `src/git/` — All 2 files (service, index)
- `src/daemon/` — All 3 files (index, server, http-listener)
- `src/export/` — All 2 files (markdown, session-export)
- `src/integrations/` — All 6 files (discord, slack, github, notifier, webhooks, index)
- `src/plugins/` — All 3 files (api, loader, manager)
- `src/sessions/` — 1 file (manager)
- `src/profiles/` — 1 file (manager)
- `src/renderer/` — All 40 files (compositor, ui-factory, buffer, diff, markdown, code-block, syntax-highlighter, layout, thinking, system-message, progress, tool-call, diff-view, file-tree, git-status, modal-factory, modal-utils, block-actions, file-picker-overlay, model-picker-overlay, search-overlay, history-search-overlay, process-indicator, process-modal, agent-detail-modal, live-tail-modal, context-inspector, autocomplete-overlay, selection-modal-overlay, help-overlay, settings-modal, session-picker-modal, profile-picker-modal, bookmark-modal, service-modal, panel-picker-overlay, panel-tab-bar, semantic-diff)
- `src/main.ts` — Full 1390 lines

### Total Files Read: ~155 source files

---

## What Was NOT Read (Remaining for Next Session)

### `src/input/` — 16 files (~320KB)
These handle all keyboard/mouse input processing and slash commands:

| File | Size | Description |
|------|------|-------------|
| `handler.ts` | 94KB | Main input processing — raw stdin parsing, key dispatch, modal routing, all keyboard shortcuts |
| `commands.ts` | 151KB | ALL slash command implementations — every `/command` handler |
| `model-picker.ts` | 24KB | Already read in earlier context (model picker logic) |
| `command-registry.ts` | 7KB | Command registration system |
| `autocomplete.ts` | 3KB | Tab completion for commands |
| `file-picker.ts` | 5KB | File picker modal state |
| `input-history.ts` | 7KB | Input history with persistence |
| `keybindings.ts` | 9KB | Keybinding manager with user overrides |
| `search.ts` | 3KB | Conversation search state |
| `selection.ts` | 3KB | Text selection manager |
| `selection-modal.ts` | 4KB | Generic selection modal state |
| `bookmark-modal.ts` | 4KB | Bookmark modal state |
| `profile-picker-modal.ts` | 6KB | Profile picker state |
| `session-picker-modal.ts` | 3KB | Session picker state |
| `settings-modal.ts` | 7KB | Settings browser modal state |
| `service-modal.ts` | 4KB | Service management modal state |

**Why these matter for README**: `commands.ts` (151KB) contains EVERY slash command — reading it would reveal the complete list of commands, their exact arguments, and any commands not in the README table. `handler.ts` (94KB) contains all keyboard shortcuts — reading it would verify the shortcuts table is complete.

### `src/panels/` — 21 files (~275KB)
All sidebar panel implementations:

| File | Size | Description |
|------|------|-------------|
| `panel-manager.ts` | 15KB | Panel lifecycle, split panes, focus management |
| `agent-inspector-panel.ts` | 25KB | Agent timeline viewer with JSONL parsing |
| `agent-logs-panel.ts` | 21KB | Agent log viewer |
| `cost-tracker-panel.ts` | 19KB | Cost/token tracking with sparklines |
| `git-panel.ts` | 18KB | Git status, staging, commits |
| `wrfc-panel.ts` | 16KB | WRFC chain viewer |
| `file-explorer-panel.ts` | 16KB | File tree browser |
| `symbol-outline-panel.ts` | 15KB | Symbol outline via tree-sitter |
| `token-budget-panel.ts` | 15KB | Token budget visualization |
| `provider-health-panel.ts` | 15KB | Provider latency/error tracking |
| `diff-panel.ts` | 17KB | Diff viewer panel |
| `debug-panel.ts` | 14KB | Debug info panel |
| `provider-stats-panel.ts` | 13KB | Provider usage statistics |
| `schedule-panel.ts` | 11KB | Cron task schedule viewer |
| `file-preview-panel.ts` | 12KB | File content preview |
| `docs-panel.ts` | 11KB | Documentation viewer |
| `session-browser-panel.ts` | 11KB | Session list browser |
| `plan-dashboard-panel.ts` | 11KB | Execution plan tracker |
| `thinking-panel.ts` | 9KB | Reasoning/thinking viewer |
| `context-visualizer-panel.ts` | 6KB | Context window visualizer |
| `tool-inspector-panel.ts` | 10KB | Tool call inspector |
| Plus: `base-panel.ts`, `builtin-panels.ts`, `index.ts`, `panel-picker.ts`, `types.ts` |

**Why these matter for README**: Each panel represents a user-facing feature. Reading these would confirm the exact set of panels and their capabilities for documentation.

### `src/intelligence/` — 10 files (~80KB)
Tree-sitter and LSP integration:

| File | Size | Description |
|------|------|-------------|
| `facade.ts` | 13KB | Intelligence service facade |
| `import-graph.ts` | 8KB | Import dependency graph |
| `config.ts` | 5KB | Language server config |
| `index.ts` | 1KB | Barrel export |
| `tree-sitter/service.ts` | 6KB | Tree-sitter WASM service |
| `tree-sitter/queries.ts` | 14KB | Symbol extraction queries |
| `tree-sitter/languages.ts` | 2KB | Language detection |
| `tree-sitter/embedded-wasm.ts` | 2KB | WASM binary embedding |
| `tree-sitter/index.ts` | 0.4KB | Barrel |
| `lsp/service.ts` | 8KB | LSP client service |
| `lsp/client.ts` | 8KB | LSP JSON-RPC client |
| `lsp/binary-downloader.ts` | 10KB | Auto-download rust-analyzer/gopls |
| `lsp/capabilities.ts` | 2KB | LSP capability declarations |
| `lsp/protocol.ts` | 2KB | LSP protocol types |
| `lsp/index.ts` | 0.5KB | Barrel |

**Why these matter for README**: Confirms the LSP binary download behavior, supported languages, and tree-sitter grammar list.

### `src/tools/` — ~20 files (~unknown size)
All 12 tool implementations:

| Directory | Tool | Description |
|-----------|------|-------------|
| `tools/read/` | read | File reading with extract modes |
| `tools/write/` | write | File writing with atomic ops |
| `tools/edit/` | edit | Find-and-replace editing |
| `tools/find/` | find | Multi-mode search |
| `tools/exec/` | exec | Shell execution |
| `tools/fetch/` | fetch | HTTP client |
| `tools/analyze/` | analyze | Code analysis suite |
| `tools/inspect/` | inspect | Project inspection |
| `tools/agent/` | agent | Subagent management |
| `tools/state/` | state | Session state and memory |
| `tools/workflow/` | workflow | Workflow state machines |
| `tools/registry-tool/` | registry | Skill/agent/tool discovery |
| `tools/shared/` | — | Process manager, shared utils |
| `tools/index.ts` | — | Tool registration |
| `tools/registry.ts` | — | ToolRegistry class |

**Why these matter for README**: Each tool has a schema.ts with the exact parameter definitions. Reading these would verify the tool descriptions in the README are accurate and complete (especially the mode counts like "14-mode analyze", "21-mode inspect").

### `src/workflow/` and `src/scheduler/` — ~4 files
Workflow state machines and cron scheduler:

| File | Description |
|------|-------------|
| `workflow/trigger-executor.ts` | Automation trigger execution |
| `workflow/index.ts` | Workflow exports |
| `scheduler/scheduler.ts` | Cron-based task scheduler |

**Why these matter for README**: Confirms workflow and scheduler capabilities.

---

## README Changes Made This Session

1. Added "Synthetic Provider & Intelligent Failover" section (committed at `08544ca`)
2. Comprehensive README rewrite covering all 25 audit items (agent running)

## README Changes Still Needed After Reading Remaining Files

1. **Verify slash command table completeness** — `commands.ts` has every command; the table likely has 10+ missing entries
2. **Verify keyboard shortcut table** — `handler.ts` has all keybindings; may have additions
3. **Verify tool mode counts** — "14-mode analyze", "21-mode inspect", "5 search modes" etc. may have changed
4. **Verify panel list** — Confirm exact panel names and counts
5. **Verify LSP languages** — Confirm which languages have bundled LSP support
6. **Verify tree-sitter grammars** — Confirm supported syntax highlighting languages

## Commits This Session

| Hash | Description | Score |
|------|-------------|-------|
| `052b18b` | JSDoc contradiction + slug collision fix | 9.8/10 |
| `93e905a` | backendCount/keyedBackendCount + getSyntheticModelInfo() | 10/10 |
| `f3f2243` | Synthetic picker: Top/All grouping + provider count + A_TIER_THRESHOLD | 10/10 |
| `f1701f5` | nameToSlug strip-only + slug collision tests | 10/10 |
| `7335b6a` | Transparent synthetic failover: auto-wait, transient error handling, signal cleanup | 10/10 |
| `c3597d2` | Failover test fixes for three-branch error handling | 10/10 |
| `6f75d39` | Cross-model failover for free models + paid exhaustion UX | 10/10 |
| `08544ca` | README: Synthetic Provider & Intelligent Failover documentation | 10/10 |
| `bd536cf` | Fix missing turn:complete event on paid model 429 exhaustion | 10/10 |
| (pending) | Comprehensive README rewrite | In progress |
