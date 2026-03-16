# Missing Features — v3 Spec vs Implementation

> Gap analysis between tool-updates-v3.md specification and current implementation.
> Generated 2026-03-16. Update as features are completed.

---

## 1. Integration Wiring

The 12 tools exist as standalone implementations but are not connected to infrastructure.

- [ ] **Hooks → tool execution** — Orchestrator calls tools directly without firing Pre/Post/Fail hooks. The hook system (dispatcher, chains, safe evaluator) exists but nothing emits events during tool execution.
- [ ] **Tree-sitter → tools** — read's outline/symbols modes use regex, not tree-sitter. Find's structural mode is a placeholder. Edit's ast mode is deferred.
- [ ] **LSP → tools** — find's references mode not implemented. Edit's ast rename not implemented.
- [ ] **Git → analyze** — analyze's diff mode shells out to `git` directly instead of using GitService. No PreCompact/PostCompact flow wired.
- [ ] **Agents don't execute** — AgentManager creates records but no background orchestrator runs. No session isolation. No worktree creation on spawn.
- [ ] **Permission system → new tool names** — Permissions still reference old tool names (file_read, file_write, etc.)

---

## 2. Missing Infrastructure

- [ ] **File watcher** (`src/state/file-watcher.ts`) — Watches key project files, updates ProjectIndex, invalidates FileStateCache on external changes, triggers Change:file:* hooks
- [ ] **Secrets manager** (`src/config/secrets.ts`) — Three-tier resolution: env var → encrypted config → session prompt. Currently only env vars work.
- [ ] **Tool LLM model** (`src/config/tool-llm.ts`) — Configurable LLM for tool-internal operations (semantic diff, commit messages, auto-heal, prompt hooks). Default: fastest available.
- [ ] **Auto-heal** (`src/tools/shared/auto-heal.ts`) — On write/edit validation failure, attempt auto-fix via formatter → linter → tool LLM. Opt-in via config.
- [ ] **Overflow handler** — Large tool outputs should write to `.goodvibes/.overflow/` with a reference. Currently just truncates.
- [ ] **ModeManager** — Output mode management (vibecoding/justvibes/default) with per-mode verbosity defaults
- [ ] **Telemetry (sql.js)** — WASM SQLite for zero-LLM-token call tracking. State tool's telemetry mode currently returns basic counters only.
- [ ] **Shared ProcessManager singleton** — exec tool has a basic one but it's not the shared singleton from the spec
- [ ] **Inter-agent message bus** — Real-time agent-to-agent and agent-to-orchestrator communication

---

## 3. Missing Tool Modes & Features

### read
- [ ] `relevant` mode — Semantic relevance filtering (LSP-assisted)
- [ ] Image support (PNG, JPG, GIF, WebP, SVG as visual content blocks)
- [ ] PDF support (`pages` parameter)
- [ ] Jupyter notebook support (.ipynb structured cell output)
- [ ] `content_file` source (read content from another file)
- [ ] `symbol_filter` parameter
- [ ] `output.include_metadata` (file size, encoding, modification time)

### edit
- [ ] `ast` match mode (tree-sitter structural match)
- [ ] `ast_pattern` match mode (ast-grep pattern matching)
- [ ] Validation chains (`validate.before` / `validate.after`: typecheck, lint, test, build)
- [ ] `before` / `after` hints
- [ ] Auto-heal integration

### find
- [ ] `references` mode — LSP-backed find-all-references
- [ ] `structural` mode — ast-grep pattern matching
- [ ] `dead_code` mode (v3 spec puts this in find, currently in analyze)
- [ ] `api_surface` mode
- [ ] `safe_delete` mode
- [ ] `circular` mode (v3 spec puts this in find, currently in analyze)
- [ ] `batch` mode — Heterogeneous queries (mix grep, glob, symbols, structural)
- [ ] `expand_to: function | class` — Tree-sitter expands matches to enclosing scope
- [ ] `ranked` results (relevance scoring)
- [ ] `relationships` (cross-file import/export)
- [ ] `preview_replace` (dry-run find/replace)

### exec
- [ ] `profile` mode — Function performance profiling
- [ ] `memory` mode — Memory leak detection
- [ ] `logs` mode — Log pattern analysis
- [ ] `progress` tracking (inline milestones, pollable progress file)
- [ ] `until` pattern `kill_after` option
- [ ] `update_imports` on file move
- [ ] `stop_on_error` / `fail_fast` for sequential commands

### fetch
- [ ] `structured` extraction (CSS selectors)
- [ ] `summary` extraction (LLM-powered)
- [ ] `tables` extraction
- [ ] `readable` extraction (reader mode)
- [ ] `pdf` extraction
- [ ] Service registry auth integration (bearer, basic, api-key from secrets)
- [ ] Cookie jar for session management
- [ ] Redirect control (configurable following)
- [ ] `body_data` object with auto-encoding
- [ ] `params` query parameter object

### analyze
- [ ] `breaking` mode — Detect breaking changes between git refs (LLM-powered)
- [ ] `semantic_diff` mode — LLM-powered semantic diff with impact analysis
- [ ] `upgrade` mode — Upgrade package with compat checks
- [ ] `permissions` mode — Check dangerous permission patterns
- [ ] `env_audit` mode — Audit .env files for consistency
- [ ] `test_find` mode — Find test files for a source file
- [ ] Full `git` mode using GitService (status, log, diff, blame, stash)
- [ ] Tool LLM integration for LLM-powered analysis modes

### inspect
- [ ] `api_spec` mode — Generate OpenAPI specification
- [ ] `api_validate` mode — Validate API against OpenAPI contract
- [ ] `api_sync` mode — Detect frontend/backend type drift
- [ ] `db_query` mode — Execute read-only database queries
- [ ] `db_prisma` mode — N+1 detection, Prisma analysis
- [ ] `component_state` mode — Trace state/props through components
- [ ] `render_triggers` mode — Analyze re-render causes
- [ ] `hooks` mode — Analyze hook dependency arrays
- [ ] `overflow` mode — Diagnose CSS overflow issues
- [ ] `sizing` mode — Analyze element sizing strategy
- [ ] `stacking` mode — Z-index and stacking context analysis
- [ ] `responsive` mode — Tailwind responsive breakpoint analysis
- [ ] `events` mode — Event handling and propagation
- [ ] `tailwind` mode — Detect Tailwind class conflicts
- [ ] `client_boundary` mode — Next.js use client/server analysis
- [ ] `error_boundary` mode — Error boundary coverage analysis

### agent
- [ ] `get` action — Detailed agent info with message history
- [ ] `budget` action — Check/update agent budget
- [ ] `plan` action — View execution plan
- [ ] `wait` action — Wait for agent completion
- [ ] `message` action — Send message to agent via message bus
- [ ] Actual background execution (in-process orchestrator)
- [ ] Session isolation (own ConversationManager, own context)
- [ ] Git worktree lifecycle (create on spawn, merge on complete, cleanup)
- [ ] Agent archetypes with markdown personality files
- [ ] Progressive loading of agent definitions

### state
- [ ] `telemetry` action — Real sql.js-backed telemetry queries
- [ ] `hooks` action — Manage hooks (list, enable, disable, add, remove, test)
- [ ] `mode` action — Get/set output mode (vibecoding/justvibes/default)
- [ ] `analytics` action — Query tokens/cache/commands/agents/files/cost/health
- [ ] `tag` action — Session tagging
- [ ] `export` action — Export session data
- [ ] `dashboard` action — Start/stop analytics dashboard
- [ ] `sync` action — Sync JSONL sessions to analytics DB
- [ ] `runtime` action — Inspect runtime engine state

### workflow
- [ ] `event` mode — Event bus query/tail/emit/stats
- [ ] `daemon` mode — Wired to actual DaemonServer
- [ ] `external` mode — Wired to actual HttpListener
- [ ] `config` mode — Runtime engine configuration
- [ ] Actual trigger execution (triggers exist but don't fire actions)
- [ ] Actual schedule execution (schedules exist but don't run)

### registry
- [ ] `recommend` scope: 'agents' (currently skills/tools only)
- [ ] Fuzzy search (fuse.js not installed)
- [ ] Progressive loading integration with system prompt
- [ ] MCP server tool discovery and registration

---

## 4. Missing UI

- [ ] **Background process indicator** — Persistent element below input area showing agent/tool count
- [ ] **Background process modal** — Down arrow → Enter opens list of processes by type
- [ ] **Live-tail peek modal** — Enter on a process shows streaming output
- [ ] **Service registry modal** — `/services` command for managing API service configs
- [ ] **Modal factory** (`src/renderer/modal-factory.ts`) — Consistent box rendering, focus management, composable sections
- [ ] **Git state in header bar** — Branch name, dirty indicator, ahead/behind remote

---

## 5. Missing Dependencies

- [ ] `@ast-grep/napi` — Structural pattern matching (find structural mode, edit ast_pattern mode)
- [ ] `sql.js` — WASM SQLite for telemetry and analytics
- [ ] `fuse.js` — Fuzzy search for registry tool
- [ ] `chokidar` — File watching fallback (if Bun.FileSystemWatcher insufficient)
- [ ] Tree-sitter grammar WASM files — Currently no grammars installed

---

## 6. Missing Security

- [ ] Spawn token expiry enforcement (tokens don't expire currently)
- [ ] HTTP listener authentication (bearer token on enable)
- [ ] HTTP listener rate limiting
- [ ] HTTP listener localhost-only binding
- [ ] Service registry credential encryption
- [ ] Full security audit of danger features

---

## 7. MCP Integration

- [ ] MCP client for connecting to external servers
- [ ] `.goodvibes/mcp.json` configuration
- [ ] Server lifecycle management (start, health check, auto-restart)
- [ ] Tool namespacing (`mcp:server:tool`)
- [ ] Progressive loading of MCP tool schemas
- [ ] MCP resource surfacing into system prompt
- [ ] Permission category: 'mcp' with default action 'prompt'

---

## Priority Order for Next Implementation

1. **Hooks → tools wiring** — Highest impact, enables the entire hook ecosystem
2. **Tree-sitter → tools wiring** — Upgrades read/find from regex to AST-aware
3. **Background process UI** — Users need visibility into running agents
4. **Agent execution** — The spawn framework exists, needs actual orchestrator
5. **Git header + PreCompact/PostCompact** — Key workflow improvement
6. **File watcher** — Keeps index/cache fresh on external changes
7. **Missing tool modes** — Incremental feature additions per tool
8. **MCP integration** — Ecosystem connectivity
9. **Secrets manager** — Better credential management
10. **Remaining UI** — Modal factory, service registry modal
