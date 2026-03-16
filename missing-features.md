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

## Execution Plan

7 phases with dependency ordering. Phases parallelize internally where possible.

### Phase A: Integration Wiring (Week 1)

Everything depends on this. The tools and infrastructure exist but aren't connected.

| # | Task | Depends On | Parallel |
|---|------|------------|----------|
| A1 | **Wire hooks into orchestrator** — Every tool call fires Pre/Post/Fail hooks. Modify orchestrator.ts to wrap executeToolCalls(). | — | Yes |
| A2 | **Wire tree-sitter into read** — Replace regex outline/symbols with TreeSitterService. | — | Yes |
| A3 | **Wire tree-sitter into find** — Add expand_to support using findEnclosingScope(). | — | Yes |
| A4 | **Wire GitService into analyze** — Replace git subprocess with GitService. Add PreCompact/PostCompact. | — | Yes |
| A5 | **Update permission system** — Map new tool names to permission categories. | — | Yes |
| A6 | **Git state in header** — Branch + dirty indicator in header bar. Debounced. | — | Yes |

**Deliverable:** Hooks fire on every tool call. Tree-sitter active. Git in header. Permissions updated.

---

### Phase B: Missing Infrastructure (Week 2)

| # | Task | Depends On | Parallel |
|---|------|------------|----------|
| B1 | **File watcher** — Watch key files, invalidate cache, update index, fire Change:file:external hooks. | A1 | Yes |
| B2 | **Tool LLM model** — Config resolution for tool-internal LLM calls (semantic diff, auto-heal, commit messages). | — | Yes |
| B3 | **Secrets manager** — Env var → encrypted file → session prompt. Three-tier resolution. | — | Yes |
| B4 | **Auto-heal** — On write/edit validation failure: formatter → linter → tool LLM. Opt-in. | B2 | No |
| B5 | **Overflow handler** — Large outputs write to .goodvibes/.overflow/, return truncated + reference. | — | Yes |
| B6 | **Install tree-sitter grammars** — typescript, javascript, python, json, css WASM files. | — | Yes |

**Deliverable:** File changes auto-detected. Tool LLM available. Secrets managed. Grammars installed.

---

### Phase C: Tool Mode Expansion (Weeks 3-4)

| # | Task | Depends On |
|---|------|------------|
| C1 | **find: references** — LSP textDocument/references. Fall back to tree-sitter. | A3 |
| C2 | **find: structural** — Install @ast-grep/napi. AST pattern matching. | A3 |
| C3 | **find: batch** — Heterogeneous queries[] with IDs. | — |
| C4 | **find: expand_to** — Tree-sitter expands matches to enclosing function/class. | A3, B6 |
| C5 | **edit: ast + ast_pattern** — Tree-sitter structural edits. LSP rename. | A2, B6 |
| C6 | **edit: validation chains** — Post-edit typecheck/lint/test. | — |
| C7 | **exec: progress** — Milestones + pollable progress file. | B5 |
| C8 | **fetch: remaining extracts** — structured, tables, readable, pdf. | — |
| C9 | **fetch: service auth** — Wire secrets manager for bearer/api-key resolution. | B3 |
| C10 | **analyze: breaking + semantic_diff** — GitService + tool LLM for impact analysis. | A4, B2 |
| C11 | **analyze: remaining modes** — upgrade, permissions, env_audit, test_find. | — |
| C12 | **inspect: frontend modes** — Port 15 modes from frontend-engine regex patterns. | — |
| C13 | **inspect: api_spec + api_validate** — OpenAPI generation and validation. | — |
| C14 | **read: image/PDF/notebook** — Base64 images, PDF text, .ipynb cells. | — |
| C15 | **state: hooks + mode management** — Wire to HookDispatcher and ModeManager. | A1 |

**Deliverable:** All critical tool modes working. LSP references. Structural search. LLM analysis.

---

### Phase D: Agent Execution (Week 5)

| # | Task | Depends On |
|---|------|------------|
| D1 | **In-process agent orchestrator** — Each agent gets own ConversationManager + tool set. Async execution loop. | A1 |
| D2 | **Session isolation** — Own message history, agent- prefix, own KVState namespace, JSONL file. | D1 |
| D3 | **Git worktree lifecycle** — Create on spawn, set cwd, merge on complete, cleanup. | D1 |
| D4 | **Inter-agent message bus** — send, broadcast, subscribe. Messages injected into agent context. | D1 |
| D5 | **Wire remaining agent actions** — get, budget, plan, wait, message. | D1, D4 |
| D6 | **Agent archetypes + markdown** — Load .goodvibes/agents/*.md, parse frontmatter, inject into system prompt. | D1 |

**Deliverable:** Agents execute in background with worktrees, sessions, and communication.

---

### Phase E: UI (Week 6)

| # | Task | Depends On |
|---|------|------------|
| E1 | **Modal factory** — Shared rendering: box, title, footer, focus, composable sections. Refactor existing modals. | — |
| E2 | **Background process indicator** — Below input area. Agent/tool count. Down arrow → Enter opens modal. | D1, E1 |
| E3 | **Background process modal** — List by type. Navigate, peek, kill, close. | E1, E2 |
| E4 | **Live-tail peek modal** — Streaming output. Auto-scroll. Kill from here. | E1, E3 |
| E5 | **Service registry modal** — /services command. Add, edit, delete, test API services. | E1, B3 |

**Deliverable:** Users see and manage background work. Modal system unified.

---

### Phase F: External Integration (Week 7)

| # | Task | Depends On |
|---|------|------------|
| F1 | **MCP client** — Connect to servers from .goodvibes/mcp.json. Register tools with mcp: namespace. | — |
| F2 | **MCP progressive loading** — Names + descriptions at startup. Full schemas on first use. | F1 |
| F3 | **MCP permissions** — New 'mcp' category, default 'prompt'. | F1, A5 |
| F4 | **Registry: fuse.js** — Fuzzy search weighted: name > description > keywords. | — |
| F5 | **Workflow: wire triggers** — Hook events check TriggerManager. Execute actions. | A1, D1 |
| F6 | **Workflow: wire schedules** — setInterval/setTimeout. Execute via exec tool. | — |
| F7 | **Workflow: wire daemon/external** — Danger-gated start of DaemonServer/HttpListener. | — |
| F8 | **State: analytics + telemetry** — Install sql.js. Record and query tool calls. | — |

**Deliverable:** MCP connected. Triggers fire. Schedules run. Analytics tracked.

---

### Phase G: Security & Polish (Week 8)

| # | Task | Depends On |
|---|------|------------|
| G1 | **Spawn token expiry** — expires_at field, reject expired. Default 1 hour. | — |
| G2 | **HTTP listener security** — Bearer token, localhost, rate limiting, logging. | — |
| G3 | **Daemon security** — Auth token on all endpoints, task logging. | — |
| G4 | **Credential encryption** — Encrypt API creds at rest, decrypt on access. | B3 |
| G5 | **Permission audit** — Verify all tools check permissions. Verify danger gates. Path traversal. | A5 |
| G6 | **Install remaining deps** — @ast-grep/napi, sql.js, fuse.js, chokidar, grammars. | — |
| G7 | **Test expansion** — Integration tests for all pipelines. Target: 2000+ total. | All |

**Deliverable:** Security hardened. All deps installed. 2000+ tests. Production-ready.

---

### Phase Summary

| Phase | Week | Tasks | Key Deliverable |
|-------|------|-------|----------------|
| A | 1 | 6 | Hooks fire, tree-sitter active, git in header |
| B | 2 | 6 | File watcher, tool LLM, secrets, auto-heal |
| C | 3-4 | 15 | All critical modes across all 12 tools |
| D | 5 | 6 | Agents run in background with worktrees |
| E | 6 | 5 | Background process visibility, modal factory |
| F | 7 | 8 | MCP, triggers, schedules, analytics |
| G | 8 | 7 | Token expiry, auth, encryption, 2000+ tests |
| **Total** | **8 weeks** | **53 tasks** | **Production-ready v1.0** |
