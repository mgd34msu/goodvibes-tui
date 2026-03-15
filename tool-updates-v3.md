# GoodVibes TUI: Tool Architecture v3

> Third iteration. Supersedes v2. Incorporates all user feedback from three rounds of review.
> Written 2026-03-15. This is the authoritative design document for implementation.

---

## 1. Executive Summary

### What Changed from v2

v3 retains the 12-tool, mode-routed architecture from v2 but makes significant changes to cross-cutting systems:

**Hook System (Major Redesign):** The 4 named events from v2 (`PrePrecisionTool`, `PostPrecisionTool`, `OnPrecisionError`, `OnPrecisionMutation`) are replaced with a composable phase-based system. 5 lifecycle phases (`Pre`, `Post`, `Fail`, `Change`, `Lifecycle`) combine with 11 categories and specific matchers via colon-separated event identifiers (e.g., `Pre:tool:read`, `Post:git:commit`, `Fail:agent:spawn`). Wildcards enable broad matching (`Pre:tool:*`, `*:git:*`). 5 hook types are supported: `command`, `prompt`, `agent`, `http`, and `ts` (TypeScript executed directly by Bun). Configuration lives in `hooks.json`, not `settings.json`.

**Tool Rename:** `run` is renamed to `exec` throughout to avoid ambiguity with process semantics.

**Git Integration:** Full git CLI wrapping via `simple-git` package. All git operations flow through the hook system (`Pre:git:*`, `Post:git:*`, `Fail:git:*`). Enables PreCompact backup commits and PostCompact LLM-powered squash. Git state displayed in header bar. Git analysis modes in `analyze` tool.

**Danger Config Category:** New top-level config category for risky features: `agentRecursion`, `maxGlobalAgents`, `maxRecursionDepth`, `daemon`, `httpListener`. All disabled by default. Implemented but inaccessible until explicitly enabled.

**Agent Spawn Token System:** 3-layer security for agent recursion: (1) config gate via `danger.agentRecursion`, (2) budget/capacity check via WRFC slot request, (3) cryptographic spawn token system where main conversation holds an orchestrator token that generates multi-use agent tokens. Level-1 agents act as sub-orchestrators — they can decompose tasks and spawn level-2 workers. Level-2 agents are pure workers with no spawning ability.

**In-Process Agents:** Agents spawn within the TUI process (not external CLIs). Own sessions with `agent-{id}` prefix. No recursive spawning by default. Always background. Produce session JSONL files. Real-time inter-agent communication via message bus.

**Secrets Management:** Environment variable first (transparent if present), encrypted config fallback (`~/.goodvibes/tui/secrets.enc`), once-per-session prompt if neither available. Never prompt again in same session.

**Progressive Loading:** Name + brief description loaded for tools, skills, agents, and MCP servers. Counter-intuitively less token-efficient per item but reduces total request count by eliminating search/recommend round-trips. Full content loaded only on trigger match or first use.

**Tool LLM Model:** Configurable separately from conversation model. Default: fastest available for current provider. Used for semantic diff, commit messages, auto-heal, prompt hooks.

**Auto-Heal:** Write/edit validation failure triggers auto-fix attempt (formatter, linter, or tool LLM). Opt-in via config. Reports outcome either way.

**Additional Changes:** Background process UI with modal, modal factory for consistent rendering, file watching for ProjectIndex/FileStateCache invalidation, no read-before-write requirement, find tool language generalization via tree-sitter/LSP, fetch as full HTTP client with service registry modal, inspect language-specific where appropriate.

---

## 2. Tool Inventory

All 12 tools with complete feature lists. `run` is now `exec`.

### Tool 1: `read`

**Replaces:** `file_read` (TUI), `precision_read` (precision-engine), `precision_notebook` (precision-engine)

**What it does:** Token-efficient file reading with extraction formats, batching, pagination, and media support. The single most-used tool in any session.

**Modes (via `extract` parameter):**

| Mode | Description | Token Cost | Use Case |
|------|-------------|------------|----------|
| `content` | Full file content with line numbers | 1.0x | Config files, code to edit |
| `outline` | Structural overview (functions, classes, blocks) | 0.2-0.4x | Understanding file organization |
| `symbols` | Exported symbols with types/signatures | 0.1-0.3x | API surface, import planning |
| `ast` | Tree-sitter AST structural patterns | 0.3-0.5x | Refactoring, pattern detection |
| `lines` | Specific line range extraction | 0.05-0.2x | Targeted reads after grep |
| `relevant` | Semantic relevance filtering (LSP-assisted) | 0.2-0.5x | Context-aware extraction |

**Complete Feature List:**

- **Batch reads**: `files[]` array with per-file extract/range overrides
- **Line ranges**: `range: { start, end }` per file and `default_range` global
- **Pagination**: `token_budget` + `page` parameters; overflow goes to `.goodvibes/.overflow/`
- **Output formats**: `count_only | minimal | standard | verbose` via `output.format`
- **Line numbers**: `output.include_line_numbers` (default: true)
- **Metadata**: `output.include_metadata` (file size, encoding, modification time)
- **Token limits**: `output.max_tokens` hard cap, `output.max_per_item` lines-per-file cap
- **Size gating**: Large files gated by default; `force: true` bypasses
- **Symbol filtering**: `symbol_filter` array: `function | method | class | interface | type | variable | constant | enum | property | namespace`
- **Image support**: PNG, JPG, GIF, WebP, SVG returned as visual content blocks
- **PDF support**: `pages` parameter for page-range reading, max 20 pages/request
- **Jupyter notebooks**: `.ipynb` files return structured cell output
- **Encoding**: Auto-detected, configurable per file
- **Caching**: FileStateCache integration with hash-based invalidation
- **OCC**: Optimistic concurrency control for external modification detection
- **Hook integration**: Fires `Post:tool:read` on success, `Fail:tool:read` on failure

**Key Input Parameters:**
```typescript
interface ReadInput {
  files: Array<{
    path: string;
    extract?: 'content' | 'outline' | 'symbols' | 'ast' | 'lines' | 'relevant';
    range?: { start: number; end: number };
    force?: boolean;
    pages?: string;
  }>;
  extract?: string;
  default_range?: { start: number; end: number };
  symbol_filter?: SymbolKind[];
  token_budget?: number;
  page?: number;
  output?: {
    format?: 'count_only' | 'minimal' | 'standard' | 'verbose';
    include_line_numbers?: boolean;
    include_metadata?: boolean;
    max_per_item?: number;
    max_tokens?: number;
  };
}
```

---

### Tool 2: `write`

**Replaces:** `file_write` (TUI), `precision_write` (precision-engine)

**What it does:** Create or overwrite files with encoding support, batch writes, auto-heal, and no read-before-write requirement.

**Complete Feature List:**

- **Batch writes**: `files[]` array
- **Overwrite modes**: `fail_if_exists | overwrite | backup` per file
- **Backup**: Automatic backup to `.goodvibes/.backups/` when mode=backup
- **Encoding**: Configurable per file (default: utf-8)
- **Content sources**: `content` string, `content_base64` for binary/special chars, `content_file` path reference
- **Parent directory creation**: Automatic `mkdir -p`
- **Dry run**: `dry_run: true` previews without writing
- **Auto-heal**: On validation failure (syntax, lint), attempt auto-fix via formatter, linter, or tool LLM. Opt-in via config `tools.auto_heal`
- **No read-before-write**: FileStateCache + OCC + `fail_if_exists` + backup mode provide safety without requiring a prior read
- **OCC integration**: Updates FileStateCache after write
- **ProjectIndex update**: Triggers index refresh for written files
- **File watcher notification**: Notifies watcher to skip self-triggered events
- **Hook integration**: `Pre:tool:write` (can abort), `Post:tool:write`, `Fail:tool:write`, `Change:file:write`
- **Safe overwrite**: Configurable via `tools.safe_overwrite`
- **Git-clean skip**: `backup_git_clean_skip` skips backup when file is git-clean

**Key Input Parameters:**
```typescript
interface WriteInput {
  files: Array<{
    path: string;
    content?: string;
    content_base64?: string;
    content_file?: string;
    encoding?: string;
    mode?: 'fail_if_exists' | 'overwrite' | 'backup';
  }>;
  dry_run?: boolean;
  auto_heal?: boolean;  // override config default
}
```

---

### Tool 3: `edit`

**Replaces:** `file_edit` (TUI), `precision_edit` (precision-engine), `project_code_preview_edits` (project-engine)

**What it does:** Token-efficient file editing with atomic transactions, conflict detection, validation chains, auto-heal, and multiple match modes including AST-aware editing.

**Match Modes:**

| Mode | Description | Use Case |
|------|-------------|----------|
| `exact` | Exact string match (default) | Precise, known-content edits |
| `fuzzy` | Whitespace/case-insensitive match | Edits across reformatted code |
| `regex` | Regular expression find/replace | Pattern-based transformations |
| `ast` | Tree-sitter structural match | Language-aware refactoring |
| `ast_pattern` | ast-grep pattern matching | Complex structural queries |

**Complete Feature List:**

- **Batch edits**: `edits[]` array
- **Transactions**: `atomic` (all-or-nothing), `partial` (best-effort), `none`
- **Rollback**: `rollback_on_fail: true` reverts all edits on failure (atomic mode)
- **Conflict detection**: OCC via FileStateCache
- **Occurrence targeting**: `first | last | all | N`
- **Hints**: `near_line`, `in_function`, `in_class`, `before`, `after`
- **Validation chains**: `validate.before` and `validate.after`: `typecheck | lint | test | build`
- **Dry run**: `dry_run: true`
- **Preview edits**: Validate errors introduced by each edit (port of `project_code_preview_edits`)
- **Auto-heal**: On validation failure, attempt auto-fix. Opt-in via config
- **Output with diff**: `with_diff` format
- **Base64 support**: `find_base64` / `replace_base64`
- **No read-before-write**: Same safety guarantees as write tool
- **Hook integration**: `Pre:tool:edit` (can abort), `Post:tool:edit`, `Fail:tool:edit`, `Change:file:edit`
- **ProjectIndex update**: Triggers refresh

**Key Input Parameters:**
```typescript
interface EditInput {
  edits: Array<{
    path: string;
    find: string;
    replace: string;
    find_base64?: string;
    replace_base64?: string;
    id?: string;
    occurrence?: 'first' | 'last' | 'all' | number;
    hints?: {
      near_line?: number;
      in_function?: string;
      in_class?: string;
      before?: string;
      after?: string;
    };
  }>;
  match?: {
    mode?: 'exact' | 'fuzzy' | 'regex' | 'ast' | 'ast_pattern';
    case_sensitive?: boolean;
    whitespace_sensitive?: boolean;
  };
  transaction?: {
    mode?: 'atomic' | 'partial' | 'none';
    rollback_on_fail?: boolean;
  };
  validate?: {
    before?: ('typecheck' | 'lint' | 'test' | 'build')[];
    after?: ('typecheck' | 'lint' | 'test' | 'build')[];
  };
  dry_run?: boolean;
  auto_heal?: boolean;
}
```

---

### Tool 4: `find`

**Replaces:** `grep` (TUI), `glob` (TUI), `list_dir` (TUI), `precision_grep`, `precision_glob`, `precision_symbols`, `discover` (precision-engine), `project_code_dead`, `project_code_surface`, `project_code_safe_delete`, `project_deps_circular` (project-engine)

**What it does:** Unified search across files, content, symbols, structure, and code intelligence. Language-generalized via tree-sitter and LSP -- not TypeScript-only.

**Modes (via `mode` parameter):**

| Mode | Description | Replaces |
|------|-------------|----------|
| `files` | Glob-based file finding with filters | `precision_glob`, `glob`, `list_dir` |
| `content` | Regex content search with output control | `precision_grep`, `grep` |
| `symbols` | Symbol search (workspace or document) | `precision_symbols` |
| `references` | Find all references to a symbol (LSP) | LSP-backed, new |
| `structural` | AST pattern matching (ast-grep) | `discover` structural queries |
| `batch` | Multiple heterogeneous queries in parallel | `discover` |
| `dead_code` | Find unused exports/functions/variables | `project_code_dead` |
| `api_surface` | Get public API surface of modules | `project_code_surface` |
| `safe_delete` | Check if symbol can be safely deleted | `project_code_safe_delete` |
| `circular` | Find circular dependency chains | `project_deps_circular` |

**Language Generalization (v3 change):**

All analysis modes (`dead_code`, `api_surface`, `safe_delete`, `circular`) use tree-sitter for syntax-level multi-language support and LSP for semantic-level (types, references, diagnostics). Any language with a tree-sitter grammar gets structural analysis. Any language with an LSP server gets full semantic analysis. Graceful degradation: LSP > tree-sitter > regex > raw text.

**Complete Feature List (mode=files):**
- Glob patterns, exclude patterns, presets (`typescript | javascript | styles | config | tests | all`)
- Size/date/content/empty filters
- Backend selection: `auto | fast-glob | ripgrep`
- Sorting, symlinks, hidden files, gitignore
- Output: `count_only | paths_only | with_stats | with_preview`
- Preview lines, limits

**Complete Feature List (mode=content):**
- Batch queries with per-query patterns and filters
- Pattern types: regex, base64, whole_word
- Case sensitivity, multiline, negation
- File filtering: glob, exclude, hidden, binary
- Path scoping per query
- Output: `count_only | files_only | locations | matches | context | stats`
- Context control, scope expansion (`line | block | function | class`)
- Line truncation, result limits, pagination, parallel execution
- Preview replace, ranked results, cross-file relationships

**Complete Feature List (mode=symbols):**
- Workspace search or per-file document search
- Symbol kinds: `function | method | class | interface | type | variable | constant | enum | property | namespace`
- Visibility: `exported_only`, `include_private`
- Language hint (any language with tree-sitter grammar or LSP)
- Output: `count_only | names_only | locations | signatures | full`
- Grouping: `file | kind | none`

**Complete Feature List (mode=references):**
- LSP-backed find-all-references
- File + line + column targeting
- Include declaration option
- Falls back to tree-sitter pattern matching if LSP unavailable

**Complete Feature List (mode=structural):**
- ast-grep patterns (e.g., `console.log($$$ARGS)`)
- Language hint for parser selection
- Base64 patterns for complex expressions

**Complete Feature List (mode=batch):**
- Heterogeneous queries: mix `grep`, `glob`, `symbols`, `structural`, `index`
- Query IDs for result identification
- Project index query type for file tree with token sizes
- Index detail levels: `count_only | summary | paths_only | full`
- File type and path prefix filtering

**Complete Feature List (mode=dead_code):**
- Language-generalized via tree-sitter + LSP (not TypeScript-only)
- Scope: directory or file path
- `include_tests` flag
- Reports unused exports, functions, variables, types

**Complete Feature List (mode=api_surface):**
- Entry point files as public API boundaries
- Scope: directory or file path
- Distinguishes public vs internal API
- Works for any language with export semantics

**Complete Feature List (mode=safe_delete):**
- Symbol targeting: file + line + column
- Checks all external references before confirming safe
- LSP-backed for accuracy, tree-sitter fallback

**Complete Feature List (mode=circular):**
- DFS-based circular chain detection
- Optional node_modules inclusion
- Language-agnostic import graph

---

### Tool 5: `exec`

**Replaces:** `shell_exec` (TUI), `precision_exec` (precision-engine), `project_runtime_profile`, `project_runtime_memory`, `project_runtime_logs` (project-engine)

**Note:** Renamed from `run` (v2) to `exec` (v3) for clarity.

**What it does:** Execute shell commands with batching, background processes, retry logic, timeouts, expectation checking, and file operations. Also provides runtime profiling, memory monitoring, and log analysis.

**Modes (via `mode` parameter, default: `exec`):**

| Mode | Description | Replaces |
|------|-------------|----------|
| `exec` | Shell command execution (default) | `precision_exec`, `shell_exec` |
| `profile` | Function performance profiling | `project_runtime_profile` |
| `memory` | Memory leak detection | `project_runtime_memory` |
| `logs` | Log pattern analysis | `project_runtime_logs` |

**Complete Feature List (mode=exec):**
- **Batch commands**: `commands[]` array with per-command config
- **Parallel execution**: `parallel: true`
- **Background execution**: `background: true` returns immediately with process ID
- **Background management**: `bg_list`, `bg_status <id>`, `bg_output <id>`, `bg_stop <id>`
- **Timeouts**: Per-command and global `timeout_ms` (default: 120000)
- **Expectations**: `expect.exit_code`, `expect.stdout_contains`, `expect.stderr_contains`
- **Retry**: `retry.max`, `retry.delay_ms`, `retry.backoff` (fixed/exponential), `retry.on` (network/lock/busy/oom)
- **Until patterns**: `until.pattern` regex, `until.kill_after`, `until.timeout_ms`
- **File operations**: `file_ops[]` before commands: `copy`, `move`, `delete` with `recursive`, `overwrite`, `update_imports`, `dry_run`
- **Move with import rewriting**: `update_imports: true` rewrites import paths after move
- **Working directory**: Per-command `cwd` and global `working_dir`
- **Environment variables**: Per-command `env` object
- **Progress tracking**: `progress: true` for milestones, `progress_file: true` for pollable output
- **Stop on error**: `stop_on_error` / `fail_fast`
- **Output limits**: `exec_max_output_chars` (50000), `exec_max_output_lines` (500)
- **Overflow**: Excess goes to `.goodvibes/.overflow/`
- **Hook integration**: `Pre:tool:exec` (can abort), `Post:tool:exec`, `Fail:tool:exec`, `Change:file:exec` for file_ops

**Complete Feature List (mode=profile):**
- Function targeting: `file` + `function_name` + `inputs[]`
- Iteration control: `iterations` (default: 100), `warmup` (default: 10)
- Memory capture: `capture_memory` for heap delta
- Returns min, max, mean, median, p95, p99

**Complete Feature List (mode=memory):**
- Target: `pid` (existing) or `command` (spawn new)
- Monitoring: `duration_seconds` (default: 60), `snapshot_interval_ms` (default: 5000)
- Leak threshold: `threshold_mb` (default: 50)

**Complete Feature List (mode=logs):**
- Source: `file` path or `command` to spawn
- Pattern counting, anomaly detection, error frequency, rate changes
- Custom patterns, structured JSON log parsing
- `tail_lines` (default: 1000), `duration_seconds` (default: 30), `time_window`

---

### Tool 6: `fetch`

**Replaces:** `precision_fetch` (precision-engine)

**What it does:** Full-service HTTP client with batch support, extraction modes, service registry integration, and secrets management.

**Complete Feature List:**

- **Batch fetching**: `urls[]` array, parallel by default
- **All HTTP methods**: `GET | POST | PUT | DELETE | PATCH | HEAD | OPTIONS`
- **Request body**: `body` string, `body_base64`, `body_data` object with `body_type` (json/form/multipart/raw)
- **Query parameters**: `params` object
- **Custom headers**: Per-URL `headers` object
- **Cookies**: Cookie jar support for multi-request flows
- **Redirects**: Configurable redirect following (default: true, max: 10)
- **Extraction modes** (per-URL or global): `raw | text | json | markdown | structured | summary | code_blocks | tables | links | metadata | readable | pdf`
- **Authentication** (per-URL):
  - `bearer` -- Bearer token
  - `basic` -- username/password
  - `api-key` -- header + key
  - `custom-headers` -- arbitrary auth headers
  - `none` -- disable auth
- **Service registry**: `service: "OpenAI"` auto-applies bearer token + headers from registry
- **Secrets integration**: API credentials resolved via secrets management (env var > encrypted config > session prompt)
- **CSS selectors**: `selectors[]` for `structured` extraction
- **Timeouts**: Per-URL `timeout_ms` (default: 30000)
- **Parallel control**: `parallel` flag (default: true)
- **Hook integration**: `Pre:tool:fetch` (can abort), `Post:tool:fetch`, `Fail:tool:fetch`

**Key Input Parameters:**
```typescript
interface FetchInput {
  urls: Array<{
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    headers?: Record<string, string>;
    body?: string;
    body_data?: unknown;
    body_type?: 'json' | 'form' | 'multipart' | 'raw';
    params?: Record<string, string>;
    extract?: ExtractMode;
    service?: string;
    auth?: AuthConfig;
    selectors?: string[];
    timeout_ms?: number;
    follow_redirects?: boolean;
    max_redirects?: number;
  }>;
  extract?: ExtractMode;
  parallel?: boolean;
}
```

---

### Tool 7: `analyze`

**Replaces:** `project_code_breaking`, `project_code_semantic_diff`, `project_deps_analyze`, `project_deps_upgrade`, `project_security_secrets`, `project_security_permissions`, `project_security_env`, `project_test_coverage`, `project_test_find`, `bundle_analyze` (project-engine)

**What it does:** Code intelligence, dependency management, security scanning, test analysis, bundle optimization, and git-backed analysis.

**Modes (via `mode` parameter):**

| Mode | Description | Replaces |
|------|-------------|----------|
| `breaking` | Detect breaking changes between git refs | `project_code_breaking` |
| `semantic_diff` | LLM-powered semantic diff with impact analysis | `project_code_semantic_diff` |
| `dependencies` | Analyze deps: outdated, unused, duplicates | `project_deps_analyze` |
| `upgrade` | Upgrade a package with compat checks | `project_deps_upgrade` |
| `secrets` | Scan for hardcoded secrets/API keys | `project_security_secrets` |
| `permissions` | Check dangerous permission patterns | `project_security_permissions` |
| `env_audit` | Audit .env files for consistency | `project_security_env` |
| `coverage` | Parse test coverage reports | `project_test_coverage` |
| `test_find` | Find test files for a source file | `project_test_find` |
| `bundle` | Analyze bundle size and composition | `bundle_analyze` |
| `git` | Git repository analysis and status | New (v3) |

**New mode=git (v3):**
- **Status**: Working tree status, staged changes, branch info
- **Log**: Commit history with filtering (author, date range, path, message pattern)
- **Diff**: Diff between refs, staged diff, working tree diff
- **Blame**: Line-by-line attribution
- **Stash**: List, show, pop, apply stash entries
- All operations backed by `simple-git` package
- Hook integration: `Pre:git:*`, `Post:git:*`, `Fail:git:*` for all operations

**Git Integration in Other Modes:**
- `breaking` and `semantic_diff` use git refs via `simple-git`
- LLM analysis uses the tool LLM model (configurable separately from conversation model)
- Default tool LLM: fastest available for current provider
- Override via `tools.llm_model` config or per-call `model` parameter

**Complete Feature Lists for All Modes:** Identical to v2 (see v2 Section 1, Tool 7) with the addition of:
- All LLM-powered modes (`breaking`, `semantic_diff`) use configurable tool LLM model
- Git operations go through `simple-git` with full hook coverage
- Language-generalized where possible via tree-sitter/LSP

---

### Tool 8: `inspect`

**Replaces:** All project-engine API/database tools, all 14 frontend-engine tools, `scaffold`.

**What it does:** Deep inspection of project structure -- APIs, databases, UI components, layout, accessibility, and scaffolding.

**Modes (via `mode` parameter):**

| Mode | Description | Replaces |
|------|-------------|----------|
| `api_routes` | Discover API routes from framework files | `project_api_routes` |
| `api_spec` | Generate OpenAPI specification | `project_api_spec` |
| `api_validate` | Validate API against OpenAPI contract | `project_api_validate` |
| `api_sync` | Detect frontend/backend type drift | `project_api_sync` |
| `db_schema` | Get database schema from ORM/SQL | `project_db_schema` |
| `db_query` | Execute read-only database queries | `project_db_query` |
| `db_prisma` | Analyze Prisma schema + N+1 detection | `project_db_prisma` |
| `components` | Component hierarchy tree | `frontend_component_tree` |
| `component_state` | Trace state/props through components | `frontend_component_state` |
| `render_triggers` | Analyze re-render causes | `frontend_render_triggers` |
| `hooks` | Analyze hook dependency arrays | `frontend_hook_dependencies` |
| `layout` | CSS layout hierarchy analysis | `frontend_layout_hierarchy` |
| `overflow` | Diagnose CSS overflow issues | `frontend_overflow` |
| `sizing` | Analyze element sizing strategy | `frontend_sizing_strategy` |
| `accessibility` | Build accessibility tree + WCAG audit | `frontend_accessibility_tree` |
| `stacking` | Z-index and stacking context analysis | `frontend_stacking_context` |
| `responsive` | Tailwind responsive breakpoint analysis | `frontend_responsive_breakpoints` |
| `events` | Event handling and propagation | `frontend_event_flow` |
| `tailwind` | Detect Tailwind class conflicts | `frontend_tailwind_conflicts` |
| `client_boundary` | Next.js use client/server analysis | `frontend_client_boundary` |
| `error_boundary` | Error boundary coverage analysis | `frontend_error_boundaries` |
| `scaffold` | Scaffold new project from template | `scaffold` |

**Language-Specific Design (v3 clarification):**

CSS/Tailwind/React tools remain framework-specific -- this is correct and necessary. CSS layout analysis, Tailwind conflict detection, and React component trees are inherently framework-bound. Structural inspection is generalized via LSP where possible. The `components` mode works for React now and is extensible to Vue/Svelte via LSP later. API and database modes are already framework-agnostic.

**Complete Feature Lists:** Identical to v2 (see v2 Section 1, Tool 8) for all 22 modes.

---

### Tool 9: `agent`

**Replaces:** `precision_agent` (precision-engine), ACP system, `runtime_agents` (runtime-engine)

**What it does:** Spawn and manage in-process AI subagents with session isolation, spawn token security, and real-time communication.

**Modes (via `action` parameter):**

| Action | Description |
|--------|-------------|
| `spawn` | Spawn a new in-process agent session |
| `status` | Check agent status/progress |
| `list` | List all active agents |
| `get` | Get detailed agent info |
| `cancel` | Cancel a running agent |
| `budget` | Check/update agent budget |
| `plan` | View execution plan |
| `wait` | Wait for agent completion |
| `message` | Send message to agent via message bus |

**Complete Feature List (action=spawn):**
- **Prompt**: Task description (required)
- **Provider**: Provider for the agent session (inherits from main if not specified)
- **Model**: Provider-specific model override
- **Context files**: `context_files[]` injected into prompt
- **Scope**: `scope[]` file/directory paths for context matching
- **Acceptance criteria**: `acceptance_criteria[]` injected into session
- **Session isolation**: Agent gets own session with `agent-{id}` prefix, own context
- **In-process execution**: Agents run within the TUI process (not external CLIs)
- **Always background**: Returns immediately with agent_id
- **Session JSONL**: Produces session files just like the main conversation
- **Spawn token**: Requires valid spawn token (see Security Model section)
- **Budget**: `max_cost` (USD), `max_tokens`
- **Workflow integration**: `workflow_id`, `workflow_phase`, `depends_on[]`, `priority`
- **Agent archetype**: `archetype` (engineer, reviewer, tester, etc.) provides base behavior
- **Markdown personality**: Custom `.md` files can define agent personality (like Claude Code AGENT.md)
- **No recursive spawning by default**: Agents cannot spawn sub-agents unless `danger.agentRecursion` is true
- **Hook integration**: `Pre:agent:spawn` (can abort), `Post:agent:spawn`, `Fail:agent:spawn`, `Lifecycle:agent:start`

**Complete Feature List (action=message):**
- **Target**: Agent ID
- **Content**: Message content (string or structured)
- **Priority**: `normal | urgent`
- Delivered via inter-agent message bus
- Agent receives in its conversation context

**Complete Feature List (action=status/list/get/cancel/budget/plan/wait):**
Identical to v2 with the addition of:
- `Lifecycle:agent:stop` hook on completion/cancellation
- Message history accessible via `get`

---

### Tool 10: `state`

**Replaces:** `precision_config` state/telemetry/hooks/mode operations, all 7 analytics-engine tools, `runtime_state`

**What it does:** Unified state management -- session KV store, telemetry queries, budget tracking, analytics, hook management, mode control, and runtime state.

**Modes (via `action` parameter):**

| Action | Description |
|--------|-------------|
| `get` | Get state values by key |
| `set` | Set key-value pairs |
| `list` | List keys with optional prefix filter |
| `clear` | Remove state keys |
| `telemetry` | Query session telemetry |
| `hooks` | Manage hooks (see Hook System section for full design) |
| `mode` | Get/set output mode |
| `budget` | Set/check/clear session budget |
| `analytics` | Query tokens/cache/commands/agents/files/cost/health |
| `tag` | Session tagging |
| `export` | Export session data |
| `dashboard` | Start/stop analytics dashboard |
| `sync` | Sync JSONL sessions to analytics DB |
| `runtime` | Inspect runtime engine state |

**Complete Feature Lists:** Identical to v2 (see v2 Section 1, Tool 10) for all actions, with the following v3 changes:

- **action=hooks**: Now manages the composable hook system (5 phases, 11 categories, wildcard matchers). Operations: `list | enable | disable | add | remove | test`. See Hook System section for full specification.
- **action=mode**: Unchanged from v2.

---

### Tool 11: `workflow`

**Replaces:** `runtime_workflow`, `runtime_triggers`, `runtime_schedule`, `runtime_events`, `runtime_emit`, `runtime_daemon`, `runtime_external`, `runtime_config` (runtime-engine)

**What it does:** Formal workflow orchestration -- WRFC loops, fix loops, event bus, triggers, scheduling, daemon management, and external webhook integration.

**Modes (via `mode` parameter):**

| Mode | Description |
|------|-------------|
| `workflow` | WRFC/fix-loop state machines |
| `trigger` | Declarative event-driven automation |
| `schedule` | Heartbeat/cron/one-shot scheduling |
| `event` | Event bus query/tail/emit/stats |
| `daemon` | Runtime daemon lifecycle (Danger-gated) |
| `external` | Webhook listener (Danger-gated) |
| `config` | Runtime engine configuration |

**Danger Gating (v3 change):**
- `daemon` mode: Only functional when `danger.daemon` is true. Otherwise returns error explaining the feature is disabled.
- `external` mode: Only functional when `danger.httpListener` is true. Otherwise returns error.
- Both are fully implemented but not accessible until enabled in the Danger config category.

**Complete Feature Lists:** Identical to v2 (see v2 Section 1, Tool 11) for all modes.

---

### Tool 12: `registry`

**Replaces:** All 7 registry-engine tools

**What it does:** Fuzzy search over skill/agent/tool registries with dependency resolution and recommendation engine.

**Modes (via `action` parameter):**

| Action | Description |
|--------|-------------|
| `search_skills` | Search skill registry by keywords |
| `search_agents` | Search agent registry by expertise |
| `search_tools` | Search available tools by functionality |
| `recommend` | Task-based skill recommendations |
| `get_skill` | Load full skill content |
| `get_agent` | Load full agent definition |
| `dependencies` | Skill dependency analysis |

**Agent Registry (v3 additions):**
- **Markdown personality agents**: Users can create custom agents via markdown files with YAML frontmatter
- **Archetype specification**: Frontmatter `archetype: engineer | reviewer | tester | ...` provides base behavior
- **General ACP agent**: Default agent type when no archetype specified
- **Skill compatibility**: Compatible with Claude Code SKILL.md format
- **Progressive loading**: Name + description loaded by default; full content on first use or trigger match

**Recommendation defaults:**
- Recommendations extend to skills and tools by default
- Agent recommendations disabled by default (prefer native agents)
- Configurable via `tools.registry.recommend_agents`

**Complete Feature Lists:** Identical to v2 (see v2 Section 1, Tool 12) for all actions.

---

### Tool Consolidation Summary

| Tool | Modes | Tools Replaced | Primary Source |
|------|-------|---------------|----------------|
| `read` | 6 | 3 | precision |
| `write` | 3 | 2 | precision |
| `edit` | 5 | 3 | precision |
| `find` | 10 | 11 | precision + project |
| `exec` | 4 | 5 | precision + project |
| `fetch` | 1 | 1 | precision |
| `analyze` | 11 | 10 + git (new) | project + git |
| `inspect` | 22 | 28 | project + frontend |
| `agent` | 9 | 3 | precision + runtime |
| `state` | 14 | 10 | precision + analytics + runtime |
| `workflow` | 7 | 8 | runtime |
| `registry` | 7 | 7 | registry |
| **Total** | **99** | **91+** | |

---

## 3. Hook System

This section is the complete design specification for the hook system, sufficient for implementation.

### 3.1 Design Philosophy

The v2 hook system had 4 named events modeled after precision-engine internals. Claude Code has ~21 hooks added incrementally over time. We have the opportunity to design the system from the ground up with all that knowledge.

The v3 hook system uses **composable event identifiers** instead of named events. Every hookable action in the system follows the same `Phase:Category:Specific` pattern. This means:

- New hookable events require zero system changes -- just emit the event
- Users can match broadly (`Pre:tool:*`) or narrowly (`Pre:tool:read`)
- Categories group related events without artificial event proliferation
- The same 5 phases apply everywhere, creating a predictable mental model

### 3.2 Event Identifier Format

```
Phase:Category:Specific
```

Examples:
- `Pre:tool:read` -- Before the read tool executes
- `Post:git:commit` -- After a git commit succeeds
- `Fail:agent:spawn` -- After an agent spawn fails
- `Change:file:write` -- When a file is written
- `Lifecycle:session:start` -- When a session begins

### 3.3 Phases

| Phase | Timing | Blocking | Can Modify | Can Abort |
|-------|--------|----------|------------|-----------|
| `Pre` | Before operation | Yes (blocking) | Input data | Yes (abort operation) |
| `Post` | After success | Partial (can inject) | Output/context | No |
| `Fail` | After failure | Partial (can recover) | Error handling | No (but can trigger retry) |
| `Change` | On state change | No (fire-and-forget) | Nothing | No |
| `Lifecycle` | Session/agent events | Varies by event | Varies | Varies |

**Phase Semantics:**

**Pre hooks** are the only fully blocking hooks. They receive the operation's input, can modify it, and can abort the operation entirely by returning `{ abort: true, reason: "..." }`. Pre hooks execute sequentially in registration order. If any Pre hook aborts, subsequent Pre hooks do not run.

**Post hooks** are partially blocking. They receive the operation's output and can inject additional context (e.g., a Post:compact hook can inject backup information into the conversation). They cannot prevent the operation's result from being returned. Post hooks execute in parallel.

**Fail hooks** are partially blocking. They receive the error and can trigger recovery actions (e.g., a Fail:tool:write hook could attempt auto-heal). They cannot undo the failure but can modify the error response or trigger a retry. Fail hooks execute sequentially.

**Change hooks** are non-blocking fire-and-forget notifications. They inform interested parties that state changed. Used for logging, metrics, UI updates. Change hooks execute asynchronously.

**Lifecycle hooks** vary by event. Session start/stop are informational (non-blocking). Agent lifecycle events may be blocking for coordination.

### 3.4 Categories

| Category | Covers | Example Specifics |
|----------|--------|-------------------|
| `tool` | All 12 tool executions | `read`, `write`, `edit`, `find`, `exec`, `fetch`, `analyze`, `inspect`, `agent`, `state`, `workflow`, `registry` |
| `file` | File system mutations | `write`, `edit`, `delete`, `move`, `copy`, `rename` |
| `git` | All git operations | `commit`, `push`, `pull`, `checkout`, `branch`, `merge`, `rebase`, `stash`, `tag`, `reset`, `diff`, `log`, `status`, `add`, `worktree-create`, `worktree-remove` |
| `agent` | Agent lifecycle | `spawn`, `complete`, `fail`, `cancel`, `message` |
| `compact` | Context compaction | `compact` (singular -- Pre:compact, Post:compact, Fail:compact) |
| `llm` | LLM interactions | `request`, `response`, `stream_start`, `stream_delta`, `stream_end`, `tool_use`, `error` |
| `mcp` | MCP server interactions | `connect`, `disconnect`, `tool_call`, `tool_result`, `elicitation`, `elicitation_result`, `sampling` |
| `config` | Configuration changes | `update`, `reset`, `profile_switch` |
| `budget` | Budget events | `warning`, `exceeded`, `update` |
| `session` | Session lifecycle | `start`, `end`, `restore`, `export` |
| `workflow` | Workflow state changes | `create`, `advance`, `complete`, `fail`, `cancel` |

### 3.5 Matchers

Hook registrations use matchers to select which events they fire on.

**Exact match:**
```json
{ "matcher": "Pre:tool:read" }
```

**Wildcard (asterisk) -- matches any value in that position:**
```json
{ "matcher": "Pre:tool:*" }
```
Matches: `Pre:tool:read`, `Pre:tool:write`, `Pre:tool:edit`, etc.

```json
{ "matcher": "*:git:*" }
```
Matches: `Pre:git:commit`, `Post:git:push`, `Fail:git:merge`, etc.

```json
{ "matcher": "Pre:*:*" }
```
Matches: Every Pre-phase event.

**Multiple matchers (OR logic):**
```json
{ "matchers": ["Pre:tool:write", "Pre:tool:edit"] }
```

**Negation (NOT logic):**
```json
{ "matcher": "Pre:tool:*", "exclude": ["Pre:tool:read"] }
```

### 3.6 Hook Types

5 hook types, each suited to different use cases:

#### `command` -- Shell script

Executes a shell command. Input is piped via stdin as JSON. Output read from stdout as JSON.

```json
{
  "type": "command",
  "command": "/path/to/script.sh",
  "timeout_ms": 10000
}
```

**stdin (JSON):**
```json
{
  "event": "Pre:tool:write",
  "phase": "Pre",
  "category": "tool",
  "specific": "write",
  "data": {
    "tool_name": "write",
    "args": { "files": [{ "path": "src/index.ts", "content": "..." }] }
  },
  "session_id": "abc123",
  "timestamp": "2026-03-15T12:00:00Z"
}
```

**stdout (JSON, optional):**
```json
{
  "abort": false,
  "modified_data": { ... },
  "inject": { "context": "Additional info for LLM" }
}
```

If stdout is empty or non-JSON, the hook is treated as pass-through (no modification).

#### `prompt` -- LLM evaluation

Sends the event data to the tool LLM for evaluation. The LLM returns a decision.

```json
{
  "type": "prompt",
  "prompt": "Evaluate whether this file write should proceed. The file is {{data.args.files[0].path}}. Return JSON: {approve: boolean, reason: string}",
  "timeout_ms": 30000
}
```

The prompt is a template with `{{...}}` interpolation from the event data. The tool LLM model is used (configurable via `tools.llm_model`).

#### `agent` -- Full subagent verification

Spawns a full agent session to verify the event. The agent receives the event data as context and returns a verdict.

```json
{
  "type": "agent",
  "prompt": "Review this code change for security issues. Files: {{data.files}}",
  "archetype": "reviewer",
  "budget": { "max_tokens": 10000 },
  "timeout_ms": 60000
}
```

The agent runs asynchronously. For Pre hooks, the operation blocks until the agent completes. For Post/Fail hooks, the agent runs in the background.

#### `http` -- Webhook POST

Sends the event data as a POST request to a URL. Supports environment variable interpolation for secrets.

```json
{
  "type": "http",
  "url": "https://hooks.example.com/events",
  "headers": {
    "Authorization": "Bearer $WEBHOOK_SECRET"
  },
  "timeout_ms": 5000
}
```

Environment variables in `$VAR` or `${VAR}` format are resolved at execution time. The request body is the event data JSON. Response is optional -- a non-2xx status code is logged but does not abort (unless it's a Pre hook that expects a JSON response with `abort: true`).

#### `ts` -- TypeScript file (Bun-native)

Executes a TypeScript file directly via Bun. No compilation step. Full type access to the event data.

```json
{
  "type": "ts",
  "file": ".goodvibes/hooks/pre-write-validate.ts",
  "timeout_ms": 10000
}
```

**Hook TypeScript API:**
```typescript
// .goodvibes/hooks/pre-write-validate.ts
import type { HookEvent, HookResult } from 'goodvibes-tui/hooks';

export default async function(event: HookEvent): Promise<HookResult> {
  const { phase, category, specific, data } = event;

  // Example: block writes to certain directories
  if (data.args?.files?.some(f => f.path.startsWith('dist/'))) {
    return { abort: true, reason: 'Cannot write to dist/ directory' };
  }

  return { abort: false };
}
```

The `HookEvent` and `HookResult` types are exported from the TUI package for type safety. The file must export a default async function.

### 3.7 Configuration (`hooks.json`)

Hooks are configured in `hooks.json` at the project root (`.goodvibes/hooks.json`) or user level (`~/.goodvibes/tui/hooks.json`). Project hooks override user hooks for the same matcher.

```json
{
  "version": 1,
  "hooks": [
    {
      "id": "lint-on-write",
      "matcher": "Post:tool:write",
      "type": "command",
      "command": "npx eslint --fix {{data.files[0].path}}",
      "enabled": true,
      "timeout_ms": 10000,
      "description": "Auto-lint files after write"
    },
    {
      "id": "pre-commit-review",
      "matchers": ["Pre:git:commit"],
      "type": "prompt",
      "prompt": "Review the staged changes for obvious issues. Staged files: {{data.staged_files}}. Return JSON: {approve: boolean, issues: string[]}",
      "enabled": true,
      "timeout_ms": 30000,
      "description": "LLM review before git commit"
    },
    {
      "id": "compact-backup",
      "matcher": "Pre:compact:compact",
      "type": "ts",
      "file": ".goodvibes/hooks/compact-backup.ts",
      "enabled": true,
      "timeout_ms": 15000,
      "description": "Git backup commit before context compaction"
    },
    {
      "id": "compact-squash",
      "matcher": "Post:compact:compact",
      "type": "ts",
      "file": ".goodvibes/hooks/compact-squash.ts",
      "enabled": true,
      "timeout_ms": 30000,
      "description": "LLM-powered commit squash after compaction"
    },
    {
      "id": "notify-slack",
      "matcher": "*:agent:complete",
      "type": "http",
      "url": "https://hooks.slack.com/services/$SLACK_HOOK",
      "enabled": false,
      "timeout_ms": 5000,
      "description": "Notify Slack when agents complete"
    },
    {
      "id": "block-force-push",
      "matcher": "Pre:git:push",
      "type": "ts",
      "file": ".goodvibes/hooks/block-force-push.ts",
      "enabled": true,
      "timeout_ms": 5000,
      "description": "Prevent force push to protected branches"
    }
  ]
}
```

### 3.8 Execution Semantics

**Order of execution:**
1. All matching hooks are collected by matcher specificity (exact > wildcard)
2. Within the same specificity, hooks execute in registration order
3. Pre hooks execute sequentially (each can abort)
4. Post hooks execute in parallel (all run regardless)
5. Fail hooks execute sequentially (each can trigger recovery)
6. Change hooks execute asynchronously (fire-and-forget)

**Timeout behavior:**
- If a hook exceeds `timeout_ms`, it is killed and treated as a pass-through
- Timeout does not abort the operation (for Pre hooks, the operation proceeds)
- Timeout is logged as a warning

**Error handling:**
- If a hook throws/crashes, it is treated as a pass-through
- The error is logged to `.goodvibes/logs/hooks.log`
- Hooks should never bring down the main operation

**Data flow:**
```
Operation invoked
  |
  v
Collect Pre hooks for this event
  |
  v
Pre hook 1: receives input -> returns modified input or abort
  |
  v (if not aborted)
Pre hook 2: receives (possibly modified) input -> returns modified input or abort
  |
  v (if not aborted)
Execute operation with (possibly modified) input
  |
  +-- Success -->
  |     |
  |     v
  |   Fire Post hooks (parallel) with output
  |   Fire Change hooks (async) if state changed
  |     |
  |     v
  |   Return result (with any Post hook injections)
  |
  +-- Failure -->
        |
        v
      Fire Fail hooks (sequential) with error
        |
        v
      Return error (with any Fail hook modifications)
```

### 3.9 Hook Chains

Hook chains are ordered sequences of event matchers that must fire in order within a session. When the full chain is satisfied, the action fires. This enables complex workflows that span multiple events without requiring state-tracking logic inside hook scripts.

#### Configuration

```json
{
  "chains": [
    {
      "name": "post-compact-commit-verify",
      "description": "Verify the auto-commit after compaction",
      "steps": [
        { "match": "Post:compact", "capture": { "session_id": "$session_id" } },
        { "match": "Post:git:commit", "within": "30s", "condition": "message.startsWith('pre-compact')" }
      ],
      "action": {
        "type": "ts",
        "path": ".goodvibes/hooks/verify-compact-commit.ts"
      }
    },
    {
      "name": "test-after-edit-cycle",
      "description": "Run tests after a batch of edits settles",
      "steps": [
        { "match": "Post:tool:edit", "capture": { "files": "$paths_affected" } },
        { "match": "Post:tool:edit", "optional": true, "debounce": "2s" }
      ],
      "action": {
        "type": "command",
        "command": "bun test ${files}"
      }
    },
    {
      "name": "review-after-agent-merge",
      "description": "Auto-review after an agent's worktree is merged",
      "steps": [
        { "match": "Post:agent:complete", "capture": { "agent_id": "$agent_id" } },
        { "match": "Post:git:merge", "condition": "branch.includes(agent_id)" }
      ],
      "action": {
        "type": "agent",
        "prompt": "Review the changes merged from agent ${agent_id}. Check for quality issues.",
        "model": "claude-haiku-4-5"
      }
    }
  ]
}
```

#### Chain Mechanics

| Feature | Description |
|----------|-------------|
| **Ordered steps** | Events must fire in the specified order. If step 2 fires before step 1, the chain does not advance. |
| **Capture** | Extract values from event payloads into chain-scoped variables. Available to subsequent steps and the final action via `${var}` interpolation. |
| **Within** | Time window — step N+1 must fire within this duration of step N. If it does not, the chain resets. Prevents stale partial matches. |
| **Condition** | JavaScript expression evaluated against the event payload. Step only matches if the condition is true. |
| **Optional + debounce** | An optional step with debounce waits for the event to stop firing for the specified duration before advancing. Useful for "wait for edits to settle." |
| **Reset** | If any step fails its condition or times out, the chain resets to step 0. No partial state lingers. |

Chain state is tracked in memory per session. Each chain has a `currentStep` index and a `captures` map. When all steps are satisfied, the action fires and the chain resets.

#### Chain Evaluation

After each event fires its direct hooks, all chains are checked for step advancement. This means chains compose naturally with direct hooks — direct hooks fire first, then chains evaluate.

### 3.10 Full Execution Semantics

#### Ordering

1. Within a single event: hooks fire sequentially in registration order (hooks.json array order)
2. Scope priority: Managed (system) → Plugin → Project → User
3. Chain evaluation: after each event fires its direct hooks, all chains are checked for step advancement
4. Pre hooks: all must pass for the operation to proceed. First deny wins.
5. Post hooks: all fire regardless of each other's results.

#### Error Handling

| Scenario | Behavior |
|----------|----------|
| Hook throws/crashes | Error logged, hook skipped, operation continues. Hooks never crash the TUI. |
| Hook times out | Treated as error. Logged, skipped. |
| Pre hook returns deny | Operation blocked. Reason shown to LLM. Remaining pre hooks still fire (for logging) but deny is final. |
| Pre hook modifies input | Modified input passed to subsequent pre hooks AND the operation. Last modification wins. |
| Chain step times out | Chain resets silently. No error — it just did not match. |
| Hook action fails | For chains: logged, chain resets. For direct hooks: logged, continues. |

#### Timeout Cascade

- Default timeout: 30s for command/prompt/http hooks, 60s for agent hooks
- Per-hook override via `timeout` field
- Chain-level timeout: sum of step `within` values + action timeout
- Global hook timeout: configurable in settings (`hooks.globalTimeout: 120`)
- If total hook execution for a single event exceeds global timeout, remaining hooks are skipped with a warning

#### Context Injection

Any hook (direct or chain action) can return `additionalContext: "..."` which gets injected into the LLM's conversation as a system message:
- Pre:tool hook: "Warning: this file is in a protected directory"
- Post:compact chain: "Context restored from backup commit abc123"
- Pre:git:push hook: "CI status: 3 failing tests on this branch"

#### Async Hooks

Hooks can declare `async: true` to run in the background without blocking. Async hooks do not block the operation. Their output is logged but not injected into context. Useful for side effects: logging, notifications, formatting.

#### TypeScript Hook Execution

The `ts` hook type executes via `Bun.import()` (dynamic import). The hook file exports a default async function receiving a typed `HookEvent` and returning a typed `HookResult`. No compilation step, no bundling. Full access to node/bun APIs.

```typescript
// .goodvibes/hooks/validate-exec.ts
import type { HookEvent, HookResult } from 'goodvibes-tui/hooks';

export default async function(event: HookEvent): Promise<HookResult> {
  if (event.category === 'tool' && event.specific === 'exec') {
    const cmd = event.payload.tool_input?.cmd as string;
    if (cmd.includes('rm -rf /')) {
      return { decision: 'deny', reason: 'Refusing to delete root filesystem' };
    }
  }
  return { decision: 'allow' };
}
```

### 3.11 Runtime Management

Hooks are managed via the `state` tool (action=hooks):

```typescript
// List all hooks
state({ action: 'hooks', operation: 'list' })

// List hooks matching a specific event
state({ action: 'hooks', operation: 'list', matcher: 'Pre:git:*' })

// Enable/disable a hook
state({ action: 'hooks', operation: 'enable', id: 'lint-on-write' })
state({ action: 'hooks', operation: 'disable', id: 'lint-on-write' })

// Add a hook at runtime (session-scoped, not persisted to hooks.json)
state({ action: 'hooks', operation: 'add', hook: { ... } })

// Remove a runtime hook
state({ action: 'hooks', operation: 'remove', id: 'my-runtime-hook' })

// Test a hook with a mock event
state({ action: 'hooks', operation: 'test', id: 'lint-on-write', mock_event: { ... } })
```

---

## 4. Infrastructure Layer

### 4.1 Tree-sitter Service

**Location:** `src/intelligence/tree-sitter/`

Foundation for language-aware operations across the entire tool system. Powers `read` (outline/symbols/ast), `edit` (ast/ast_pattern), `find` (symbols/structural/dead_code/api_surface/safe_delete), and `inspect` frontend analysis.

**Architecture:**
```
src/intelligence/tree-sitter/
  service.ts          -- TreeSitterService singleton
  grammar-loader.ts   -- WASM grammar loading + caching
  parser-pool.ts      -- Parser instance pooling (one per language)
  query-library.ts    -- Reusable queries per language
  languages.ts        -- Language detection from extension/shebang/content
  types.ts            -- Shared types
```

**Key Design Decisions:**
- WASM-based grammars (`web-tree-sitter`) for Bun compatibility
- Core 10 languages bundled: TypeScript, JavaScript, Python, Rust, Go, JSON, YAML, Markdown, HTML, CSS
- Additional grammars downloaded on first use from tree-sitter registry
- In-memory grammar cache with LRU eviction
- Parser pool: one instance per language, reused
- Incremental parsing: trees cached in FileStateCache, sub-millisecond re-parse on edit
- Query library: pre-built queries per language (outline, symbols, imports, exports, jsx-elements, hooks, test-blocks)

**Language Generalization (v3 emphasis):**
Tree-sitter is the mechanism for moving away from TypeScript-only analysis. Any language with a tree-sitter grammar gets:
- Outline extraction (functions, classes, methods)
- Symbol extraction (exports, declarations)
- AST pattern matching
- Structural search
- Dead code detection (export analysis)
- API surface analysis

### 4.2 LSP Service

**Location:** `src/intelligence/lsp/`

Type-aware operations where available. Powers `find` (references), `edit` (type validation), `analyze` (breaking changes), `inspect` (component analysis).

**Architecture:**
```
src/intelligence/lsp/
  service.ts          -- LSPService singleton, server lifecycle
  client.ts           -- JSON-RPC over stdio client
  registry.ts         -- Per-language server config
  capabilities.ts     -- Feature detection per server
  types.ts            -- LSP protocol types
```

**Server Registry (defaults):**

| Language | Server | Package |
|----------|--------|---------|
| TypeScript | typescript-language-server | npm |
| Python | pylsp / pyright | pip |
| Rust | rust-analyzer | system |
| Go | gopls | system |
| JSON | vscode-json-languageserver | npm |
| CSS | vscode-css-languageserver | npm |

**Graceful Degradation Chain:**
```
LSP available --> Full type-aware operations
  |
  v (LSP not installed / not responding)
Tree-sitter available --> Structural analysis
  |
  v (Grammar not loaded)
Regex fallback --> Basic pattern matching
  |
  v (Always works)
Raw text --> Line-based operations
```

**Server Lifecycle:**
- Started on demand when a file of that language is first accessed
- Idle timeout: 5 minutes of inactivity
- Health checking: ping every 30 seconds, restart on failure
- Workspace root: auto-set to project root

### 4.3 CodeIntelligence Facade

**Location:** `src/intelligence/facade.ts`

Unified API consumed by tools. Internally dispatches to LSP, tree-sitter, or regex.

```typescript
interface CodeIntelligence {
  getOutline(filePath: string): Promise<OutlineNode[]>;
  getSymbols(filePath: string, filter?: SymbolKind[]): Promise<Symbol[]>;
  getReferences(filePath: string, line: number, col: number): Promise<Location[] | null>;
  getDefinition(filePath: string, line: number, col: number): Promise<Location | null>;
  getAST(filePath: string): Promise<ASTNode[] | null>;
  structuralSearch(pattern: string, language: string, path?: string): Promise<Match[]>;
  getDiagnostics(filePath: string): Promise<Diagnostic[]>;
  getCapabilities(language: string): LanguageCapabilities;
}
```

### 4.4 Git Service

**Location:** `src/git/`

**New in v3.** Full git CLI wrapping via `simple-git` package.

```
src/git/
  service.ts           -- GitService singleton, wraps simple-git
  hooks-integration.ts -- Emits hook events for all git operations
  types.ts             -- Git-specific types
```

**GitService API:**
```typescript
interface GitService {
  // Status
  status(): Promise<StatusResult>;
  diff(options?: DiffOptions): Promise<string>;
  log(options?: LogOptions): Promise<LogResult>;
  blame(file: string): Promise<BlameResult>;

  // Staging
  add(files: string | string[]): Promise<void>;
  reset(files?: string | string[]): Promise<void>;

  // Commits
  commit(message: string, options?: CommitOptions): Promise<CommitResult>;
  amend(message?: string): Promise<CommitResult>;

  // Branches
  branch(options?: BranchOptions): Promise<BranchResult>;
  checkout(ref: string, options?: CheckoutOptions): Promise<void>;
  merge(branch: string, options?: MergeOptions): Promise<MergeResult>;
  rebase(branch: string, options?: RebaseOptions): Promise<void>;

  // Remote
  push(options?: PushOptions): Promise<void>;
  pull(options?: PullOptions): Promise<PullResult>;
  fetch(options?: FetchOptions): Promise<void>;

  // Stash
  stash(options?: StashOptions): Promise<void>;
  stashList(): Promise<StashEntry[]>;
  stashPop(index?: number): Promise<void>;

  // Tags
  tag(name: string, options?: TagOptions): Promise<void>;
  tags(): Promise<string[]>;

  // Worktrees
  worktreeAdd(path: string, branch?: string): Promise<void>;
  worktreeRemove(path: string): Promise<void>;
  worktreeList(): Promise<WorktreeEntry[]>;

  // Low-level
  raw(args: string[]): Promise<string>;
}
```

**Hook Integration:**
Every GitService method emits hook events:
```typescript
async commit(message: string, options?: CommitOptions): Promise<CommitResult> {
  // Emit Pre:git:commit -- can abort
  const preResult = await this.hooks.emit('Pre:git:commit', { message, options });
  if (preResult.aborted) throw new HookAbortError(preResult.reason);

  // Execute
  const result = await this.git.commit(preResult.data.message, preResult.data.options);

  // Emit Post:git:commit
  await this.hooks.emit('Post:git:commit', { result, message });

  return result;
}
```

### 4.5 State Management

**Location:** `src/state/`

Identical to v2 (FileStateCache, ProjectIndex, KVState, Telemetry, Overflow) with additions:

**File Watching (v3 addition):**
```
src/state/
  file-watcher.ts      -- Lightweight file watcher
```

- Watches key project files (configurable patterns)
- Updates ProjectIndex on external file changes
- Invalidates FileStateCache entries for changed files
- Triggers `Change:file:*` hooks
- Optionally triggers LSP reindex for changed files
- Ignores self-triggered events (writes from our tools)
- Uses Bun's built-in `Bun.FileSystemWatcher` or `chokidar` fallback
- Default watch patterns: `src/**/*.{ts,tsx,js,jsx}`, `package.json`, `tsconfig.json`
- Configurable via `tools.file_watcher.patterns` and `tools.file_watcher.enabled`

### 4.6 Secrets Management

**Location:** `src/config/secrets.ts`

**New in v3.** Three-tier secret resolution.

**Resolution Order:**
1. **Environment variable** (highest priority): If `GOODVIBES_<SERVICE>_KEY` (or the service's configured env var name) is set, use it transparently. No prompt, no config.
2. **Encrypted config file**: `~/.goodvibes/tui/secrets.enc` -- encrypted at rest using a machine-specific key derived from OS keychain or user-provided passphrase.
3. **Session prompt** (lowest priority): Prompt user once per session. Value stored in memory only. Never written to disk unless user explicitly saves.

**API:**
```typescript
interface SecretsManager {
  // Resolve a secret (follows 3-tier order)
  get(service: string, key: string): Promise<string | null>;

  // Store a secret in encrypted config
  set(service: string, key: string, value: string): Promise<void>;

  // Delete a secret from encrypted config
  delete(service: string, key: string): Promise<void>;

  // List services with stored secrets (not the values)
  list(): Promise<ServiceSecretInfo[]>;

  // Mark a secret as resolved for this session (from prompt)
  setSessionSecret(service: string, key: string, value: string): void;
}
```

**Session Behavior:**
- Once a secret is resolved (from any tier), it is cached for the session
- Never prompt for the same secret twice in one session
- Service registry entries reference secret keys, not values

### 4.7 Tool LLM Model

**Location:** `src/config/tool-llm.ts`

**New in v3.** Configurable LLM for tool-internal operations.

**Use Cases:**
- Semantic diff (`analyze` mode=semantic_diff)
- Breaking change analysis (`analyze` mode=breaking)
- Commit message generation (PostCompact hook)
- Auto-heal (write/edit validation fix)
- Prompt hooks (hook type=prompt)

**Configuration:**
```json
{
  "tools": {
    "llm_model": {
      "default": "fastest",
      "overrides": {
        "anthropic": "claude-haiku-4",
        "openai": "gpt-4.1-mini",
        "google": "gemini-3.0-flash"
      }
    }
  }
}
```

- `"fastest"` (default): Automatically selects the fastest model available for the current provider
- Provider-specific overrides: Use a specific model regardless of default
- Global override: `"tools.llm_model.global": "anthropic:claude-haiku-4"` uses a specific provider+model for all tool LLM operations, even if the conversation uses a different provider
- Per-tool-call override: Some tools accept a `model` parameter to override for that specific call

### 4.8 Auto-Heal

**Location:** `src/tools/shared/auto-heal.ts`

**New in v3.** Automatic fix attempt on write/edit validation failure.

**Flow:**
```
Write/Edit operation
  |
  v
Validation check (if configured)
  |
  +-- Pass --> Return success
  |
  +-- Fail --> Is auto_heal enabled?
        |
        +-- No --> Return failure
        |
        +-- Yes --> Attempt fix chain:
              |
              1. Formatter (prettier, biome, etc.) -- fastest
              2. Linter --fix (eslint, biome, etc.) -- medium
              3. Tool LLM (ask LLM to fix the issue) -- slowest
              |
              v
            Re-validate
              |
              +-- Pass --> Return success with auto-heal note
              +-- Fail --> Return original failure
```

**Configuration:**
```json
{
  "tools": {
    "auto_heal": {
      "enabled": false,
      "strategies": ["formatter", "linter", "llm"],
      "formatter_cmd": "npx prettier --write",
      "linter_cmd": "npx eslint --fix",
      "max_attempts": 1
    }
  }
}
```

### 4.9 Configuration System

Extends existing `src/config/` with new keys:

```typescript
interface ToolConfig {
  // Existing (from v2)
  cache_mode: 'hash_only' | 'with_content';
  cache_max_mb: number;
  safe_overwrite: boolean;
  backup_dir: string;
  backup_git_clean_skip: boolean;
  max_file_bytes: number;
  max_token_estimate: number;
  max_diff_chars: number;
  page_size_lines: number;
  exec_max_output_chars: number;
  exec_default_timeout_ms: number;
  exec_max_output_lines: number;
  exec_overflow_dir: string;
  exec_max_background: number;
  exec_history_max: number;
  discover_symbol_timeout_ms: number;
  fetch_services: Record<string, ServiceConfig>;
  verbosity_defaults: Record<string, VerbosityLevel>;
  slow_fs_stat_threshold_ms: number;
  slow_fs_known_prefixes: string[];

  // New in v3
  auto_heal: AutoHealConfig;
  llm_model: ToolLLMConfig;
  file_watcher: FileWatcherConfig;
  registry: RegistryConfig;
}

interface DangerConfig {
  agentRecursion: boolean;        // default: false
  maxGlobalAgents: number;        // default: 8
  maxRecursionDepth: number;      // 0 = off (default), 1 = one level (max allowed, hard ceiling)
  daemon: boolean;                // default: false
  httpListener: boolean;          // default: false
}
```

---

## 5. Agent Architecture

### 5.1 In-Process Agents

Agents run within the TUI process, not as external CLI subprocesses. This eliminates:
- CLI installation requirements
- Process management complexity
- Communication overhead
- Provider-specific CLI flags

**Agent Session Model:**
```
Main Conversation (orchestrator token — generates agent tokens)
  |
  +-- Agent-A (agent token) → acts as sub-orchestrator
  |     |
  |     +-- Agent-A1 (no token, own worktree)
  |     +-- Agent-A2 (no token, own worktree)
  |     +-- Agent-A3 (no token, own worktree)
  |     → A merges worktrees from A1, A2, A3
  |
  +-- Agent-B (agent token) → simple worker, never spawns
  |
  +-- Agent-C (agent token) → sub-orchestrator
        |
        +-- Agent-C1 (no token, own worktree)
        +-- Agent-C2 (no token, own worktree)
        → C merges worktrees from C1, C2
→ Main conversation merges results from A, B, C
```

### 5.2 Session Isolation

- Each agent gets a unique session ID with `agent-` prefix
- Own conversation history, separate from main
- Own tool state (KV store namespace: `agent-{id}.`)
- Shared infrastructure: FileStateCache, ProjectIndex, GitService, CodeIntelligence
- Shared file system (agents can read/write the same project)
- Own budget tracking and enforcement

### 5.3 Spawn Token System (3-Layer Security)

Prevents uncontrolled agent recursion via three independent gates:

**Layer 1: Config Gate**
- `danger.agentRecursion` must be `true`
- If `false`, the `agent` tool's `spawn` action is simply not available to sub-agents
- The tool definition is not included in the agent's tool list

**Layer 2: Budget/Capacity Check**
- Before spawning, check `danger.maxGlobalAgents` against current active agent count
- If at capacity, the spawn fails with a clear error
- Agent can request a WRFC slot from the orchestrator in the main conversation
- The orchestrator decides whether to approve based on global state

**Layer 3: Cryptographic Spawn Token**
- Main conversation holds an **orchestrator token** (generated at session start)
- Orchestrator token can generate **agent tokens** (multi-use credentials)
- When spawning agents with recursion enabled:
  - Main generates an agent token from the orchestrator token
  - Token is injected into the agent's initial context
  - Agent (level-1) can use its token to spawn multiple level-2 sub-agents
  - Sub-agents receive NO token — they cannot spawn further
- Token validation:
  - Tokens are cryptographic (HMAC-SHA256 signed by orchestrator)
  - Multi-use: agent tokens are credentials, not consumed on use
  - Scoped: token encodes the agent ID and depth that can use it
  - Expiry: tokens expire after 1 hour

**Token Structure:**
```typescript
interface SpawnToken {
  type: 'orchestrator' | 'agent';
  session_id: string;
  issued_to: string;        // agent ID or 'main'
  issued_by: string;        // 'system' for orchestrator, agent ID for agent tokens
  depth: number;            // 0 for orchestrator, 1 for agent tokens
  max_depth: number;        // from config, always 1
  can_generate: boolean;    // true for orchestrator, false for agent
  signature: string;        // HMAC-SHA256
}
```

### 5.4 Git Worktree Isolation

Every subagent MUST get its own git worktree. This provides complete file isolation between parallel agents.

**Worktree lifecycle:**
```
Agent spawned
  → Pre:agent:spawn hook fires
  → git worktree add .goodvibes/worktrees/agent-{id} -b agent-{id}
  → Agent runs in its own branch/worktree
  → Agent completes
  → Post:agent:complete hook fires
  → Orchestrator runs merge analysis
  → If clean: git merge agent-{id} into parent branch
  → If conflicts: LLM resolves or escalates to user
  → git worktree remove .goodvibes/worktrees/agent-{id}
  → Post:git:worktree-remove hook fires (cleanup)
```

**Merge is the orchestrator's job** — when subagents complete, their orchestrator (main or sub) does merge analysis using `analyze --mode git_diff` to compare worktree branches, then merges or resolves conflicts.

### 5.5 Inter-Agent Communication

**Message Bus:**
```typescript
interface MessageBus {
  // Send message to specific agent
  send(targetAgentId: string, message: AgentMessage): void;

  // Broadcast to all agents
  broadcast(message: AgentMessage): void;

  // Subscribe to messages for this agent
  subscribe(agentId: string, handler: (msg: AgentMessage) => void): void;

  // Query message history
  history(agentId: string, since?: string): AgentMessage[];
}

interface AgentMessage {
  from: string;           // Sender agent/session ID
  to: string;             // Recipient agent ID or '*' for broadcast
  type: 'task' | 'result' | 'status' | 'question' | 'answer' | 'cancel';
  content: string;        // Message content
  data?: unknown;         // Structured data
  priority: 'normal' | 'urgent';
  timestamp: string;
}
```

- Messages injected into agent's conversation context on next turn
- Urgent messages interrupt current processing
- Main conversation can monitor all agent messages
- Agent teams (v2 feature): Stub for v1, full implementation later

### 5.5 Agent Archetypes

| Archetype | Base Behavior | Tool Access |
|-----------|--------------|-------------|
| `engineer` | Code implementation, follows instructions | All 12 tools |
| `reviewer` | Code review, quality assessment | read, find, analyze, inspect |
| `tester` | Test creation and execution | All 12 tools |
| `researcher` | Information gathering, analysis | read, find, fetch, analyze |
| `general` | Default, no specialized behavior | All 12 tools |

Archetypes are starting points. Custom markdown personality files can further customize behavior.

---

## 6. Integration Architecture

### 6.1 ToolRegistry Integration

The existing `Tool` interface remains unchanged. Each tool registers into the same `ToolRegistry`:

```typescript
// src/tools/index.ts
export function registerTools(
  registry: ToolRegistry,
  services: ToolServices,
): void {
  registry.register(new ReadTool(services));
  registry.register(new WriteTool(services));
  registry.register(new EditTool(services));
  registry.register(new FindTool(services));
  registry.register(new ExecTool(services));   // renamed from RunTool
  registry.register(new FetchTool(services));
  registry.register(new AnalyzeTool(services));
  registry.register(new InspectTool(services));
  registry.register(new AgentTool(services));
  registry.register(new StateTool(services));
  registry.register(new WorkflowTool(services));
  registry.register(new RegistryTool(services));
}
```

**ToolServices (dependency injection container):**
```typescript
interface ToolServices {
  intelligence: CodeIntelligence;
  fileState: FileStateCache;
  projectIndex: ProjectIndex;
  kvStore: KVState;
  telemetry: Telemetry;
  hooks: HooksManager;
  modes: ModeManager;
  processes: ProcessManager;
  overflow: OverflowHandler;
  config: ConfigManager;
  bus: EventBus;
  acp: AcpManager;
  git: GitService;             // New in v3
  secrets: SecretsManager;     // New in v3
  toolLLM: ToolLLMProvider;    // New in v3
  fileWatcher: FileWatcher;    // New in v3
  messageBus: MessageBus;      // New in v3
}
```

### 6.2 Event Bus Integration

All events follow the hook system's `Phase:Category:Specific` pattern. The event bus bridges internal TypeScript events with the hook system:

```typescript
interface EventBus {
  // Internal event subscription (TypeScript callbacks)
  on(event: string, handler: Function): void;

  // Emit event (fires both internal handlers and matching hooks)
  emit(event: string, data: unknown): Promise<HookResult>;

  // Query event history
  query(filter: EventFilter): EventEntry[];
}
```

The event bus unifies:
- Internal tool events (from v2: `turn:*`, `tool:*`, `state:*`, `agent:*`, `workflow:*`)
- Hook events (from v3: `Phase:Category:Specific`)
- Both systems receive the same events

### 6.3 Conversation Manager Integration

Tool results flow through existing `ConversationManager.addToolResults()`. The renderer is updated for new output formats:

- Large results (>20 lines) auto-collapse
- Mode-aware display in tool call header (e.g., "read [outline]")
- Diff rendering for edit `with_diff` output
- Progress rendering for background processes
- Budget warnings in status bar
- Git state in header bar (branch, clean/dirty, ahead/behind)

### 6.4 ACP Agent System Integration

The `agent` tool unifies three agent systems:

```
                    +------------------+
                    |   agent tool     |
                    |  (action router) |
                    +--------+---------+
                             |
               +-------------+-------------+
               |             |             |
               v             v             v
    +--------------+ +-------------+ +--------------+
    | In-Process   | | AcpManager  | | Runtime      |
    | Agent (v3)   | | (existing)  | | Agents       |
    | (default)    | | (ACP proto) | | (workflow)   |
    +--------------+ +-------------+ +--------------+
```

- **spawn (default)**: In-process agent with session isolation (v3 primary path)
- **spawn (acp)**: ACP protocol agents via existing AcpManager (compatibility)
- **spawn (workflow)**: Workflow-aware agents with phase tracking

---

## 7. Progressive Loading

### 7.1 Strategy

Counter-intuitively, v3 loads MORE initial data than Claude Code's names-only approach, but this reduces total request count.

**Claude Code approach:** Load names only -> search when needed -> load full content -> use
**v3 approach:** Load name + brief description -> use or search if unclear -> load full content on trigger/first use

### 7.2 Loading Levels

| Asset | Level 0 (Always) | Level 1 (On Demand) |
|-------|------------------|--------------------|
| **Tools** | Name + 1-line description + parameter summary | Full JSON Schema definition |
| **Skills** | Name + description + trigger patterns | Full skill content (markdown) |
| **Agents** | Name + archetype + description | Full agent definition + personality |
| **MCP Servers** | Server name + tool names + descriptions | Full tool schemas |

### 7.3 Token Cost

| Asset Type | Per-Item L0 Cost | Typical Count | Total L0 Cost |
|------------|-----------------|---------------|---------------|
| Tools | ~30 tokens | 12 | ~360 tokens |
| Skills | ~20 tokens | 30 | ~600 tokens |
| Agents | ~15 tokens | 10 | ~150 tokens |
| MCP Tools | ~25 tokens | 20 | ~500 tokens |
| **Total** | | | **~1,610 tokens** |

This is higher than names-only (~400 tokens) but eliminates 2-3 search/recommend calls per session (~1,500 tokens each), netting a savings of ~2,900 tokens per session.

### 7.4 Trigger-Based Full Loading

Skills load their full content when:
- A trigger pattern matches the current task/message
- The LLM explicitly calls `registry.get_skill`
- An agent archetype requires the skill

Tools load their full schema when:
- The LLM calls the tool for the first time
- The tool is referenced in a skill's requirements

MCP tools load their full schema when:
- The LLM calls the tool
- The server is explicitly connected

---

## 8. Security Model

### 8.1 Danger Config Category

Risky features are gated behind a dedicated config category:

```json
{
  "danger": {
    "agentRecursion": false,
    "maxGlobalAgents": 8,
    "maxRecursionDepth": 0,
    "daemon": false,
    "httpListener": false
  }
}
```

| Setting | Default | Range | Effect |
|---------|---------|-------|--------|
| `agentRecursion` | `false` | boolean | Enables agent spawn tool for sub-agents |
| `maxGlobalAgents` | `8` | 1-32 | Maximum concurrent agents across all sessions |
| `maxRecursionDepth` | `0` | 0-1 | `0` = agents cannot spawn subagents (default, safe); `1` = agents can spawn one level of subagents (dangerous, max allowed value); depth 2+ is a hard ceiling with no config option |
| `daemon` | `false` | boolean | Enables background daemon mode |
| `httpListener` | `false` | boolean | Enables HTTP webhook listener |

**Why max depth is 0 or 1:**
- `maxRecursionDepth: 0` — agents cannot spawn subagents (default, safe)
- `maxRecursionDepth: 1` — agents can spawn one level of subagents (dangerous, max allowed value)
- There is NO option for depth 2+ (hard ceiling)

A setting of 2+ is unsafe. An LLM already one layer deep, reading the config, might conclude it can recurse further. With a hard ceiling of 1, the token system enforces the boundary regardless of what the LLM reads.

### 8.2 Spawn Token Security

See Section 5.3 for full specification. Summary of the 3-layer model:

1. **Config gate**: `danger.agentRecursion` must be true
2. **Capacity check**: Global agent count vs `danger.maxGlobalAgents`
3. **Cryptographic token**: Multi-use agent tokens, HMAC-signed, expiring after 1 hour

### 8.3 Secrets Management Security

See Section 4.6. Key security properties:
- Environment variables are the recommended path (12-factor app compatible)
- Encrypted config uses OS keychain where available
- Session secrets never written to disk
- Service registry stores references to secrets, never raw values
- `analyze` mode=secrets scans for leaked secrets in code

### 8.4 Daemon/HTTP Gating

- Daemon and HTTP listener are fully implemented but disabled by default
- Enabling requires setting `danger.daemon` / `danger.httpListener` to true
- The Danger config category signals to users that these features carry risk
- When enabled, the HTTP listener binds to localhost only by default
- Authentication required for all HTTP endpoints (bearer token generated on start)
- Rate limiting on all endpoints
- No remote access without explicit proxy configuration by the user

### 8.5 File System Boundaries

- Write operations restricted to project root by default
- `tools.sandbox` config can enable stricter sandboxing
- Backup directory always within project (`.goodvibes/.backups/`)
- Overflow directory always within project (`.goodvibes/.overflow/`)
- Secrets file in user home (`~/.goodvibes/tui/secrets.enc`)

---

## 9. UI Additions

### 9.1 Background Process Indicator

**Location:** Below the input area.

**Display:**
```
> [input area]
  [2 agents, 1 tool running] [Down arrow to manage]
```

**Behavior:**
- Shows only when background processes exist
- Down arrow key selects the indicator
- Enter opens the background process modal
- Auto-updates as processes start/complete

### 9.2 Background Process Modal

**Opened via:** Down arrow -> Enter on the background process indicator.

**Layout:**
```
+--[ Background Processes ]-------------------+
|                                             |
| AGENTS (2)                                  |
| > agent-abc123  Implementing auth module    |
|   agent-def456  Running test suite          |
|                                             |
| TOOLS (1)                                   |
|   exec bg-001   npm run build (45s)         |
|                                             |
| [Enter] Peek  [Ctrl+K] Kill  [Esc] Close   |
+---------------------------------------------+
```

**Interactions:**
- Arrow keys navigate the list
- Enter on a process opens a live-tail peek modal
- Ctrl+K kills the selected process
- Esc closes the modal, returns focus to input

### 9.3 Live-Tail Peek Modal

**Opened via:** Enter on a process in the background process modal.

**Layout:**
```
+--[ agent-abc123: Implementing auth module ]-+
|                                             |
| [tool:read] src/auth/index.ts               |
| [tool:write] src/auth/middleware.ts          |
| [tool:exec] npx tsc --noEmit                |
| > Implementing JWT validation...            |
|   Creating middleware chain...              |
|                                             |
| [Ctrl+K] Kill  [Esc] Back                  |
+---------------------------------------------+
```

**Behavior:**
- Live-tail of the process/agent output
- Auto-scrolls to bottom
- Ctrl+K kills from this view too
- Esc goes back to the process list modal

### 9.4 Service Registry Modal

**Opened via:** `/services` command.

**Layout:**
```
+--[ Service Registry ]----------------------+
|                                            |
| CONFIGURED SERVICES                        |
| > OpenAI       api-key    [configured]     |
|   Anthropic    bearer     [env var]        |
|   GitHub       bearer     [not set]        |
|                                            |
| [Enter] Edit  [A] Add  [D] Delete          |
| [T] Test  [Esc] Close                      |
+--------------------------------------------+
```

**Interactions:**
- Enter edits a service (name, auth type, credentials)
- A adds a new service
- D deletes (with confirmation)
- T tests the service (sends a health-check request)
- Credentials managed via SecretsManager

### 9.5 Modal Factory

**Location:** `src/renderer/modal-factory.ts`

Consistent rendering for all modals in the TUI.

**Features:**
- ASCII box rendering with configurable borders
- Title in top border
- Footer with keyboard shortcuts
- Focus management (modal captures all input)
- Keyboard routing to modal components
- Responsive sizing (adapts to terminal width/height)
- Composable sections:
  - `search` -- Search/filter input
  - `list` -- Selectable list with scroll
  - `detail` -- Read-only detail pane
  - `live-tail` -- Streaming output display
  - `separator` -- Horizontal line
  - `text` -- Static text block
  - `input` -- Text input field
  - `confirm` -- Yes/No confirmation

**API:**
```typescript
interface ModalFactory {
  create(config: ModalConfig): Modal;
}

interface ModalConfig {
  title: string;
  sections: ModalSection[];
  footer?: string;
  width?: number | 'auto' | 'full';
  height?: number | 'auto' | 'full';
  onKeypress?: (key: KeyEvent) => void;
  onClose?: () => void;
}

interface Modal {
  render(): void;
  focus(): void;
  close(): void;
  update(section: string, data: unknown): void;
}
```

### 9.6 Git State in Header Bar

The header bar is extended to show git status:

```
goodvibes v0.2.0 | claude-4-opus | main* +3 -1 | 1.2k tokens
```

- Branch name with dirty indicator (`*`)
- Ahead/behind remote count
- Staged file count
- Updates via `Change:git:*` hooks and file watcher

---

## 10. Implementation Strategy

### 10.1 File Structure

```
src/
  tools/
    index.ts              -- Tool registration, ToolServices interface
    read.ts               -- read tool
    write.ts              -- write tool
    edit.ts               -- edit tool
    find.ts               -- find tool
    exec.ts               -- exec tool (renamed from run.ts)
    fetch.ts              -- fetch tool
    analyze.ts            -- analyze tool
    inspect.ts            -- inspect tool
    agent.ts              -- agent tool
    state.ts              -- state tool
    workflow.ts           -- workflow tool
    registry-tool.ts      -- registry tool
    shared/
      output.ts           -- Output formatting, verbosity
      validation.ts       -- Input validation
      errors.ts           -- Tool error types
      types.ts            -- Shared types
      auto-heal.ts        -- Auto-heal logic

  intelligence/
    tree-sitter/
      service.ts
      grammar-loader.ts
      parser-pool.ts
      query-library.ts
      languages.ts
      types.ts
    lsp/
      service.ts
      client.ts
      registry.ts
      capabilities.ts
      types.ts
    facade.ts

  git/
    service.ts            -- GitService (simple-git wrapper)
    hooks-integration.ts  -- Hook event emission
    types.ts

  state/
    file-state-cache.ts
    project-index.ts
    kv-store.ts
    telemetry.ts
    overflow.ts
    hooks.ts              -- HooksManager (v3 composable system)
    modes.ts
    process-manager.ts
    file-watcher.ts       -- File system watcher

  config/
    secrets.ts            -- SecretsManager
    tool-llm.ts           -- Tool LLM model resolution
    danger.ts             -- Danger category validation

  agents/
    manager.ts            -- In-process agent manager
    session.ts            -- Agent session isolation
    spawn-token.ts        -- Cryptographic token system
    message-bus.ts        -- Inter-agent communication
    archetypes.ts         -- Agent archetype definitions

  renderer/
    modal-factory.ts      -- Modal rendering system
    background-ui.ts      -- Background process indicator
    service-modal.ts      -- Service registry modal
    git-header.ts         -- Git state in header

  tools-legacy/           -- Old tools (kept during migration)
```

### 10.2 Dependency Decisions

| Dependency | Decision | Rationale |
|------------|----------|----------|
| `web-tree-sitter` | WASM grammars | Bun compatible, no native compilation |
| `@ast-grep/napi` | Native binding | Structural search, Bun supports native modules |
| `simple-git` | Git wrapping | Full git CLI coverage, good reputation, maintained |
| `sql.js` | WASM SQLite | Telemetry + analytics, no native deps |
| `fuse.js` | Fuzzy search | Registry search, pure JS |
| `chokidar` | File watching | Fallback if Bun.FileSystemWatcher insufficient |
| `ripgrep` | System binary | Content search backend, fallback to regex |
| LSP servers | System-installed | Users install their own, TUI manages lifecycle |

### Implementation Plan

#### Phase 1: Foundation (Week 1-2)
- `src/state/` — Port KVState, FileStateCache (OCC), ProjectIndex, Telemetry (sql.js)
- `src/config/` — Extend ConfigManager with danger category, tool LLM config
- `src/hooks/` — Hook dispatcher, event model, chain engine, 5 hook types (command, prompt, agent, http, ts)
- `hooks.json` schema + validation
- Delete old tools and their tests (file-read, file-write, file-edit, shell-exec, grep, list-dir, glob-tool)

#### Phase 2: Core Tools (Week 2-3)
- `src/tools/read/` — Full precision_read port with all extract modes
- `src/tools/write/` — With auto-heal, no-read-before-write, base64
- `src/tools/edit/` — Transactions, match modes, hints, validation
- `src/tools/find/` — Mode router (files/content/symbols/references/structural)
- `src/tools/exec/` — Background processes, retry, file_ops, smart commands
- Wire all tools through hook system
- Tests for each tool (~50 tests per tool)

#### Phase 3: Intelligence (Week 3-4)
- `src/intelligence/tree-sitter/` — Grammar loading, parsing, caching, queries
- `src/intelligence/lsp/` — Pluggable server lifecycle, JSON-RPC client
- Integrate tree-sitter into read (outline, symbols, ast modes)
- Integrate tree-sitter into find (structural mode, expand_to function/class)
- Integrate LSP into find (references mode) and edit (ast rename mode)
- Language detection + config

#### Phase 4: Git + Analysis (Week 4-5)
- `src/git/` — simple-git wrapper with hook emission
- Git worktree management for agents
- `src/tools/analyze/` — All modes
- `src/tools/inspect/` — All modes
- PreCompact → PostCompact flow with git backup/squash

#### Phase 5: Agents + Orchestration (Week 5-6)
- `src/tools/agent/` — In-process agents, sessions, spawn tokens
- `src/tools/workflow/` — WRFC state machine, triggers, scheduling
- `src/tools/state/` — KV scratchpad, budget, context, memory, telemetry
- Agent communication bus
- Background process UI (indicator + modal)
- Git worktree lifecycle for agents

#### Phase 6: Integration + Polish (Week 6-7)
- `src/tools/fetch/` — Full HTTP client, service registry, extract modes
- `src/tools/registry/` — Search, recommend, progressive loading
- MCP client integration
- Service registry modal, modal factory refactor
- File watcher service, secrets management
- Comprehensive test suite (target: 500+ new tests)

#### Phase 7: Danger Features (Week 7-8)
- Daemon mode (implemented, disabled)
- HTTP listener (implemented, disabled)
- Agent recursion (orchestrator/agent token system)
- Security audit

#### Testing Strategy

- Unit tests: every tool mode, every hook type, every state operation
- Integration tests: tool → hook → state pipeline
- Hook chain tests: multi-step chains with timing, captures, conditions
- Agent tests: lifecycle, worktree, token generation/validation
- Git tests: all operations with hook verification
- Test runner: `bun test` with `bun:test` imports
- Target: 500+ new tests, ~1,170+ total

### 10.4 Testing Strategy

**Framework:** `bun test` with `bun:test` imports.

```
src/test/
  tools/
    read.test.ts
    write.test.ts
    edit.test.ts
    find.test.ts
    exec.test.ts          -- renamed from run.test.ts
    fetch.test.ts
    analyze.test.ts
    inspect.test.ts
    agent.test.ts
    state.test.ts
    workflow.test.ts
    registry.test.ts
  intelligence/
    tree-sitter.test.ts
    lsp.test.ts
    facade.test.ts
  state/
    file-state-cache.test.ts
    project-index.test.ts
    kv-store.test.ts
    telemetry.test.ts
    process-manager.test.ts
    hooks.test.ts         -- v3 composable hook system
    file-watcher.test.ts
    overflow.test.ts
  git/
    service.test.ts
    hooks-integration.test.ts
  agents/
    manager.test.ts
    spawn-token.test.ts
    message-bus.test.ts
  config/
    secrets.test.ts
    tool-llm.test.ts
    danger.test.ts
  renderer/
    modal-factory.test.ts
    background-ui.test.ts
```

**Test Categories:**
- Unit: Each tool mode in isolation with mocked ToolServices
- Integration: Tool + real filesystem (temp directories)
- Hook: Hook system event flow, abort, modification, timeout
- Security: Spawn token generation, validation, expiry, consumption
- Regression: Edge cases from precision-engine test suite
- Performance: Token output measurement per verbosity mode

---

## 11. Appendix: Complete Hook Event Matrix

Every `Phase:Category:Specific` combination supported by the system.

### tool

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Pre:tool:read` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:read` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:read` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:write` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:write` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:write` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:edit` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:edit` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:edit` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:find` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:find` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:find` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:exec` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:exec` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:exec` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:fetch` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:fetch` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:fetch` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:analyze` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:analyze` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:analyze` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:inspect` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:inspect` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:inspect` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:agent` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:agent` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:agent` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:state` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:state` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:state` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:workflow` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:workflow` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:workflow` | Fail | Partial | `{ tool_name, error, args }` |
| `Pre:tool:registry` | Pre | Yes | `{ tool_name, args }` |
| `Post:tool:registry` | Post | Partial | `{ tool_name, result, duration_ms }` |
| `Fail:tool:registry` | Fail | Partial | `{ tool_name, error, args }` |

### file

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Change:file:write` | Change | No | `{ path, size, hash }` |
| `Change:file:edit` | Change | No | `{ path, edits_applied, hash }` |
| `Change:file:delete` | Change | No | `{ path }` |
| `Change:file:move` | Change | No | `{ source, destination }` |
| `Change:file:copy` | Change | No | `{ source, destination }` |
| `Change:file:rename` | Change | No | `{ old_path, new_path }` |
| `Change:file:external` | Change | No | `{ path, change_type }` (from file watcher) |

### git

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Pre:git:commit` | Pre | Yes | `{ message, options, staged_files }` |
| `Post:git:commit` | Post | Partial | `{ result, message, hash }` |
| `Fail:git:commit` | Fail | Partial | `{ error, message }` |
| `Pre:git:push` | Pre | Yes | `{ remote, branch, options }` |
| `Post:git:push` | Post | Partial | `{ result }` |
| `Fail:git:push` | Fail | Partial | `{ error }` |
| `Pre:git:pull` | Pre | Yes | `{ remote, branch, options }` |
| `Post:git:pull` | Post | Partial | `{ result }` |
| `Fail:git:pull` | Fail | Partial | `{ error }` |
| `Pre:git:checkout` | Pre | Yes | `{ ref, options }` |
| `Post:git:checkout` | Post | Partial | `{ ref }` |
| `Fail:git:checkout` | Fail | Partial | `{ error, ref }` |
| `Pre:git:branch` | Pre | Yes | `{ name, options }` |
| `Post:git:branch` | Post | Partial | `{ name, result }` |
| `Fail:git:branch` | Fail | Partial | `{ error }` |
| `Pre:git:merge` | Pre | Yes | `{ branch, options }` |
| `Post:git:merge` | Post | Partial | `{ result }` |
| `Fail:git:merge` | Fail | Partial | `{ error, conflicts }` |
| `Pre:git:rebase` | Pre | Yes | `{ branch, options }` |
| `Post:git:rebase` | Post | Partial | `{ result }` |
| `Fail:git:rebase` | Fail | Partial | `{ error }` |
| `Pre:git:stash` | Pre | Yes | `{ options }` |
| `Post:git:stash` | Post | Partial | `{ result }` |
| `Fail:git:stash` | Fail | Partial | `{ error }` |
| `Pre:git:tag` | Pre | Yes | `{ name, options }` |
| `Post:git:tag` | Post | Partial | `{ name }` |
| `Fail:git:tag` | Fail | Partial | `{ error }` |
| `Pre:git:reset` | Pre | Yes | `{ ref, options }` |
| `Post:git:reset` | Post | Partial | `{ result }` |
| `Fail:git:reset` | Fail | Partial | `{ error }` |
| `Pre:git:add` | Pre | Yes | `{ files }` |
| `Post:git:add` | Post | Partial | `{ files }` |
| `Fail:git:add` | Fail | Partial | `{ error }` |
| `Pre:git:diff` | Pre | Yes | `{ options }` |
| `Post:git:diff` | Post | Partial | `{ result }` |
| `Pre:git:log` | Pre | Yes | `{ options }` |
| `Post:git:log` | Post | Partial | `{ result }` |
| `Pre:git:status` | Pre | Yes | `{ options }` |
| `Post:git:status` | Post | Partial | `{ result }` |
| `Pre:git:worktree-create` | Pre | Yes | `{ path, branch }` |
| `Post:git:worktree-create` | Post | Partial | `{ path, branch }` |
| `Fail:git:worktree-create` | Fail | Partial | `{ error }` |
| `Pre:git:worktree-remove` | Pre | Yes | `{ path }` |
| `Post:git:worktree-remove` | Post | Partial | `{ path }` |
| `Fail:git:worktree-remove` | Fail | Partial | `{ error }` |

### agent

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Pre:agent:spawn` | Pre | Yes | `{ prompt, provider, model, options }` |
| `Post:agent:spawn` | Post | Partial | `{ agent_id, session_id }` |
| `Fail:agent:spawn` | Fail | Partial | `{ error, prompt }` |
| `Post:agent:complete` | Post | No | `{ agent_id, result, duration_ms }` |
| `Fail:agent:fail` | Fail | No | `{ agent_id, error }` |
| `Post:agent:cancel` | Post | No | `{ agent_id, reason }` |
| `Change:agent:message` | Change | No | `{ from, to, type, content }` |
| `Lifecycle:agent:start` | Lifecycle | No | `{ agent_id, session_id, task }` |
| `Lifecycle:agent:stop` | Lifecycle | No | `{ agent_id, exit_reason }` |

### compact

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Pre:compact:compact` | Pre | Yes | `{ session_id, message_count, token_count }` |
| `Post:compact:compact` | Post | Partial | `{ session_id, messages_removed, tokens_freed }` |
| `Fail:compact:compact` | Fail | Partial | `{ error }` |

**PreCompact + PostCompact Flow:**
1. `Pre:compact:compact` fires -> hook runs `git add -A && git commit -m "pre-compact backup"` (backup commit)
2. Context compaction runs
3. `Post:compact:compact` fires -> hook uses tool LLM to generate commit message -> runs `git commit --amend -m "<generated message>"` (squash)
4. If compaction fails, `Fail:compact:compact` fires -> backup commit remains as safety net

### llm

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Pre:llm:request` | Pre | Yes | `{ messages, model, tools, temperature }` |
| `Post:llm:response` | Post | Partial | `{ response, usage, duration_ms }` |
| `Fail:llm:error` | Fail | Partial | `{ error, request }` |
| `Change:llm:stream_start` | Change | No | `{ request_id }` |
| `Change:llm:stream_delta` | Change | No | `{ request_id, delta }` |
| `Change:llm:stream_end` | Change | No | `{ request_id, total_tokens }` |
| `Change:llm:tool_use` | Change | No | `{ tool_name, args, request_id }` |

### mcp

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Pre:mcp:connect` | Pre | Yes | `{ server_name, config }` |
| `Post:mcp:connect` | Post | Partial | `{ server_name, tools }` |
| `Fail:mcp:connect` | Fail | Partial | `{ server_name, error }` |
| `Post:mcp:disconnect` | Post | No | `{ server_name, reason }` |
| `Pre:mcp:tool_call` | Pre | Yes | `{ server_name, tool_name, args }` |
| `Post:mcp:tool_result` | Post | Partial | `{ server_name, tool_name, result }` |
| `Fail:mcp:tool_call` | Fail | Partial | `{ server_name, tool_name, error }` |
| `Pre:mcp:elicitation` | Pre | Yes | `{ server_name, schema }` |
| `Post:mcp:elicitation_result` | Post | Partial | `{ server_name, result }` |
| `Pre:mcp:sampling` | Pre | Yes | `{ server_name, messages }` |
| `Post:mcp:sampling` | Post | Partial | `{ server_name, response }` |

### config

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Change:config:update` | Change | No | `{ key, old_value, new_value }` |
| `Change:config:reset` | Change | No | `{ key }` |
| `Change:config:profile_switch` | Change | No | `{ old_profile, new_profile }` |

### budget

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Change:budget:warning` | Change | No | `{ usage, threshold, budget }` |
| `Change:budget:exceeded` | Change | No | `{ usage, budget }` |
| `Change:budget:update` | Change | No | `{ old_budget, new_budget }` |

### session

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Lifecycle:session:start` | Lifecycle | No | `{ session_id, provider, model }` |
| `Lifecycle:session:end` | Lifecycle | No | `{ session_id, duration_ms, total_tokens }` |
| `Lifecycle:session:restore` | Lifecycle | No | `{ session_id, messages_restored }` |
| `Post:session:export` | Post | No | `{ session_id, format, path }` |

### workflow

| Event | Phase | Blocking | Data |
|-------|-------|----------|------|
| `Lifecycle:workflow:create` | Lifecycle | No | `{ workflow_id, type }` |
| `Change:workflow:advance` | Change | No | `{ workflow_id, from_state, to_state }` |
| `Lifecycle:workflow:complete` | Lifecycle | No | `{ workflow_id, result }` |
| `Lifecycle:workflow:fail` | Lifecycle | No | `{ workflow_id, error }` |
| `Lifecycle:workflow:cancel` | Lifecycle | No | `{ workflow_id, reason }` |

---

### Wildcard Matching Examples

| Matcher | Matches |
|---------|---------|
| `Pre:tool:*` | All Pre-phase tool events (Pre:tool:read, Pre:tool:write, ...) |
| `Post:tool:*` | All Post-phase tool events |
| `*:tool:read` | All phases for the read tool (Pre, Post, Fail) |
| `*:git:*` | Everything git-related (Pre:git:commit, Post:git:push, ...) |
| `Pre:*:*` | Every Pre-phase event across all categories |
| `Change:*:*` | Every Change event |
| `Lifecycle:*:*` | Every Lifecycle event |
| `*:*:*` | Every event (use with extreme caution) |
| `*:agent:spawn` | All phases for agent spawn |
| `Fail:*:*` | Every failure event across all categories |

---

*This document is the authoritative reference for the GoodVibes TUI tool system v3. It supersedes v1 and v2. Implementation begins with Phase 1 (Infrastructure) and proceeds through Phase 5 (UI + Integration) over approximately 6 weeks.*
