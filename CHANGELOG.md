# Changelog

All notable changes to GoodVibes TUI.

---

## [0.9.14] — 2026-03-30

### Input & Navigation
- Fix left/right arrow keys: add kitty keyboard protocol support (Ghostty/kitty terminals)
- Fix left/right arrow keys disabled after slash command use
- Fix slug erase: backspace at marker start removes entire paste slug
- Space after slash command closes autocomplete modal

### Agent System
- Fix batch-spawn not breaking turn loop (caused infinite wait polling)
- Non-blocking agent wait mode: 0ms default, 5s cap
- Agent progress indicator: shows "Turn N · tool — args" instead of permanent "Thinking..."
- Consecutive error circuit breaker: warns at 5, stops at 10 all-fail turns
- Agent model fallback: gracefully handle non-existent models

### Edit Tool
- Fuzzy matching fallback for less capable models (whitespace-normalized → line-based at 70% threshold)
- Better error messages with closest match preview and similarity percentage
- Warning propagation through all output formats

### Provider & UI
- Fix ACP stdin crash: WritableStream adapter for Bun FileSink
- Fix text tool call parser: handle underscore delimiter format (kimi models)
- Fix system message colors: only errors are red, status messages are cyan
- Fix spinner color fading after ~67 min (JS negative modulo on frame counter)
- Spinner message rotation slowed from ~3s to ~30s

---

## [0.9.13] — 2026-03-30

### Synthetic Provider & Model Picker
- Fix ZeroEval benchmark parser: handle raw JSON array response + correct field names (gpqa_score, swe_bench_verified_score, etc.)
- Benchmark scoring for synthetic models uses real backend model IDs instead of non-existent canonical slugs
- Fix blank synthetic model list when opening /model then /provider (availableOnly filter)
- Show provider counts (Np) in model picker for synthetic models
- Quality tier badges [S]/[A]/[B]/[C] work for synthetic models via getQualityTierFromScore()
- Benchmark sort (composite/swe/gpqa) works correctly for synthetic models
- Render lag fix: O(1) Map index for canonical lookups, deduplicated per-frame calls
- normalizeModelName: preserve version numbers, size indicators, and model tier identifiers
- Top Models / All Synthetic sub-grouping with benchmark-based ranking
- Extract getQualityTierFromScore() helper eliminating 3 duplicate threshold sites

### Failover & Error Handling
- Fix frozen response crash: shallow-copy tool calls before mutation (kimi/ollama-cloud providers)
- 401/403 errors now failover to next backend instead of crashing the synthetic chain
- Agent model fallback: gracefully handle non-existent models by falling back to current model
- Text-based tool call parser: extract tool calls from models that output raw <|toolcallbegin|> tokens

### Provider System
- Remove hardcoded static model lists from OpenAI, Gemini, Anthropic providers
- Stop hiding 855 catalog models that are synthetic backends from native provider listings
- Fix configured provider detection: check config system (secrets + env var aliases), not just process.env
- Map config 'gemini' to catalog 'google' provider ID
- Synthetic provider always shows as configured when canonicals exist
- Set configuredProviders in /provider picker (was only set in /model picker)

---

## [0.9.11] — 2026-03-28

### Dynamic Model Catalog
- Models sourced from models.dev (4,102 models, 105 providers) with 24h TTL cache
- Benchmark integration from ZeroEval (275 models, 22 scoring dimensions)
- Auto-provider registration — set an env var, provider auto-configures
- Catalog-driven SyntheticProvider with tier-isolated failover (free/paid/subscription never cross)
- "best-free" synthetic model — resolves to highest-benchmarked free model with keys
- Static BUILTIN_MODEL_REGISTRY removed (~2,500 lines of hardcoded data)
- Change notifications on catalog refresh (filtered to user's favorites + top benchmarks)

### Enhanced Model Picker
- Pricing tier filter: Free / Paid / Subscription / All
- Family grouping: GPT, Claude, Gemini, Llama, Qwen, GLM, MiniMax, DeepSeek, etc.
- Capability filters: Reasoning, Tool Use, Structured Output, Multimodal, Open Weights
- Available-only toggle (default on) — only models with configured keys
- Benchmark sort: SWE-bench, GPQA, composite score
- Quality tier badges [S/A/B/C] next to model names
- Pinned/favorite models with star indicator at top

### Favorites & Usage Tracking
- `/pin` and `/unpin` commands for model favorites
- Usage history tracking (model, timestamp, count)
- Favorites persist across sessions

### Context Validation
- Pre-flight check before provider.chat() — catches context window overflow before provider rejection
- Auto-compact trigger when context exceeds model limit
- Clear error with specific token counts and alternative model suggestions

### Cost Tracker Integration
- Catalog-backed pricing for all models
- Free models show $0.00 explicitly
- DEFAULT_PRICING fallback removed

### Roadmap Implementation (all at 10/10)
- Agent streaming fixes (#1)
- TS cleanup fixes (#5)
- CI pipeline hardening (#6)
- Model picker fixes (#7)
- Documentation (#20)
- Test coverage audit (#21)
- Performance audit plan (#22)
- Security P0 fixes (#23)
- Release infrastructure (#24)
- Plugin/extension system (#25)
- Keyboard customization (#27)
- History search fixes (#41)
- Undo/redo file operations (#42)
- Context compaction (#43)
- Graceful degradation fixes (#44)
- Session export (#46)
- Semantic diff integration (#49)
- Dependency ordering (#50)

### Codebase Audit Fixes
- MCP version hardcode fixed (imports VERSION)
- Daemon fail-closed auth (was fail-open)
- All 11 as-any casts eliminated from commands.ts
- console calls replaced with logger throughout
- Shallow Object.freeze replaced with structuredClone
- EventBus error isolation per handler
- Deep freeze on workflow definitions
- Shared walkDir utility extracted (DRY)
- Path validation for TypeScript hooks
- Context validation with auto-compact

### Documentation
- Complete docs suite: GETTING-STARTED.md, COMMANDS.md (51 commands), PROVIDERS.md (13 providers), ARCHITECTURE.md, CONFIGURATION.md (42 settings)

---

## [0.9.10] — 2026-03-26

### Synthetic Failover Provider
- **Automatic rate-limit failover** — new `synthetic` provider wraps multiple backends for the same model; when one provider returns a 429 or rate-limit error, the request automatically retries with the next provider in the rotation
- **6 failover models** — GPT-OSS 120B, MiniMax M2.5, Kimi K2.5, Qwen 3.5 397B, GLM-5, Nemotron 3 Super 120B
- **Cooldown tracking** — rate-limited backends are skipped for 60 seconds (or the provider's retry-after value); traffic returns to the preferred backend once its cooldown expires
- **Transparent to users** — failover models appear as a single entry in the model picker; backend rotation is invisible

### New Providers
- **AIHubMix** — 20 free models including GPT-4.1, GPT-4o, Gemini 2.0/3.0 Flash, GLM coding series, MiniMax coding series, Kimi for Coding, MiMo V2 Flash, Step 3.5 Flash (`AIHUBMIX_API_KEY`)
- **Groq** — 10 free models on Groq LPU inference: Qwen3 32B, GPT-OSS 120B/20B, Kimi K2/K2.5, Llama 3.3 70B/3.1 8B/4 Scout, Compound/Compound Mini (`GROQ_API_KEY`)
- **Cerebras** — 2 free models on wafer-scale inference: Llama 3.1 8B, Qwen3 235B A22B (`CEREBRAS_API_KEY`)
- **Mistral** — 14 models: Large/Medium/Small 4, Codestral, Devstral (3 sizes), Magistral (2 sizes), Ministral (3 sizes), Pixtral Large, Nemo (`MISTRAL_API_KEY`)
- **Ollama Cloud** — 34 free models including DeepSeek V3.1/V3.2, Cogito 2.1, Qwen3/3.5 series, Kimi K2/K2.5, Mistral Large 3, GLM 4.6-5, MiniMax M2.x, Nemotron 3 (`OLLAMA_CLOUD_API_KEY`)
- **NVIDIA NIM** — 115 models (1000 free credits): DeepSeek, Nemotron Ultra/Super/Nano, Llama 2-4, Qwen 2.5-3.5, Kimi K2, Mistral, Gemma, Phi 3-4, and more (`NVIDIA_API_KEY`)
- **HuggingFace** — 124 free models: Qwen 2.5-3.5, DeepSeek V3/R1, GLM 4-5, Llama 3-4, Cohere Command, MiniMax, ERNIE, Cogito, OLMo, MiMo (`HF_API_KEY`)
- **LLM7** — 5 free models: GLM-4.6V Flash, Codestral, GPT-OSS 20B, Llama 3.1 8B Turbo, Ministral 8B (`LLM7_API_KEY`)

### Provider Management
- **`/provider add <name> <baseURL> [apiKey]`** — add custom providers from within the TUI; auto-probes server for models, detects context windows, writes provider JSON config
- **`/provider remove <name>`** — remove custom providers; file watcher auto-deregisters
- **Path traversal protection** — provider names validated against `[a-zA-Z0-9_-]+` in both add and remove
- **URL validation** — malformed URLs caught before network probe
- **HTTPS-aware** — context window detection skipped for HTTPS URLs (only works with HTTP local servers)

### Context Window Detection
- **Dynamic context windows for discovered LLMs** — scan now queries each server for actual context window sizes instead of hardcoding 8192
- **Server-type strategies** — Ollama (`/api/show`), vLLM (`/v1/models/{id}`), llama.cpp (`/props`), generic (`/v1/models/{id}` + `/props` fallback)
- **Parallel metadata fetching** — per-model context queries use `Promise.allSettled` to avoid blocking scan
- **llama.cpp on non-standard ports** — server header detection no longer limited to port 8080
- **Context windows persist** — detected values saved in `discovered-providers.json` across sessions

### Bug Fixes
- Fixed context window percentage not updating for discovered models
- Fixed llama.cpp server type detection on non-standard ports

### Code Health
- 24 tests for context window detection covering all 4 server type paths
- Provider name validation shared via `isValidProviderName()` helper

---

## [0.9.9] — 2026-03-18

### Token Counting
- **Real provider-reported tokens** — context bar and warnings now use `lastInputTokens` from the most recent LLM response instead of the `text.length / 4` heuristic
- **Anthropic cache tokens** — captures `cache_read_input_tokens` and `cache_creation_input_tokens` from SSE stream; `lastInputTokens` includes cache tokens for accurate context window occupancy
- **Deleted `estimateTotalTokens()`** — the heuristic estimation method is gone; all token tracking uses real numbers
- **Context bar fixed** — was comparing cumulative lifetime tokens against context window (meaningless); now shows current context usage from latest response

### Agent Resilience
- **Network-aware retry** — transient network errors no longer permanently kill WRFC chains; agent-level retry with 5s/10s/20s/40s/60s backoff waits for network recovery before failing
- **Cancellation during retry** — cancelled agents are detected after each retry sleep, preventing up to 90s of wasted work
- **Loop detection** — detects agents repeating the exact same tool call (same name + identical JSON args); system message nudge at 3 repetitions, firm user message at 5; never skips execution, only escalates messaging

### Breaking Changes
- **`skipWrfc` → `dangerously_disable_wrfc`** — renamed to discourage models from casually bypassing WRFC review chains

### Bug Fixes
- `getCurrentModel` falls back to first selectable model instead of crashing on unknown model ID
- Fixed readonly property error in agent exec argument sanitization
- Removed bare `a` keyboard shortcut that was swallowing the first character of input
- Short tool results (≤200 chars) are no longer collapsible
- JSON prettified in expanded tool results
- WRFC chain IDs shown in full in UI messages
- Dynamic provider list from registry (not hardcoded)

### Code Health
- **Zero TypeScript errors** — fixed all `npx tsc --noEmit` errors across source and test files
- Added `sql.js` type declaration (`src/types/sql-js.d.ts`)
- `ChatResponse.usage` fields documented with per-provider semantics
- WRFC regression detection — warns when review scores decline across fix cycles
- Gate retry depth stored per-chain (no ancestry walks needed)

---

## [0.9.8] — 2026-03-18

### WRFC Workmap & Session Tracking
- **WRFC workmap** — JSONL-based session workmap (`{sessionId}_workmap.jsonl`) tracks all WRFC lifecycle events: engineer_complete, review_complete, fix_started, gate_result, chain_passed, chain_failed
- **wrfc-chains tool mode** — LLM can list all WRFC chains in current session with status, last score, and event count
- **wrfc-history tool mode** — LLM can query detailed event history for any chain including review scores, issues, and gate results
- **Gate retry hard cap** — gate failures stop spawning follow-up agents after `wrfc.maxFixAttempts` (default 3) retries through ancestry chain
- **Cancelled agent events** — cancelled agents now emit `subagent:error` so WRFC chains don't get stuck in engineering state
- **Non-blocking conversation** — turn loop ends immediately after agent spawn; WRFC review/fix runs fully in background
- **Persistent WRFC messages** — WRFC lifecycle events use `addSystemMessage()` so they survive history rebuilds (click, scroll, resize)
- **Minimal spawn output** — agent spawn returns plain text instead of JSON blob; no more green code blocks in conversation

### Agent Execution
- **Interruptible turn loop** — user input during tool execution breaks the turn loop; queued message processed immediately
- **Force turn end on spawn** — orchestrator ends turn after any agent spawn; no more LLM thinking while agents run
- **Workflow tool deterrence** — description updated to prevent LLM from confusing state tracker with task execution

### Process Modal & UI
- **Auto-refresh** — process modal refreshes every 1 second while open; running times tick live
- **Smart WRFC labels** — review agents show `[Review] task... (target: 9.9/10)`, fix agents show `[Fix #N] task... (8.4 → 9.9/10)`
- **Original task from chain** — WRFC agent labels look up the original task description from the WrfcController chain

### System Prompt
- **GOODVIBES.md** — bundled token efficiency guidelines deployed to `~/.goodvibes/GOODVIBES.md` via postinstall
- **skipWrfc default** — schema now explicitly sets `default: false`

### Fixes
- **Resize crash** — null guard on cell access in diff engine prevents TypeError on terminal resize
- **Markdown surrogate pairs** — fixed surrogate pair handling in inline text accumulator

---

## [0.9.7] — 2026-03-17

### WRFC Safety & Reliability
- **Active chain cap with FIFO queue** — max 6 concurrent WRFC chains, excess queued and dequeued on completion
- **Same-error detection** — fingerprints gate failures, aborts cascade after 1 identical ancestor match
- **Gate auto-detection** — skips typecheck (no tsconfig.json), lint (no eslint config), test/build (no npm scripts)
- **Buffered completions** — agents that finish while their chain is queued are processed on dequeue
- **Unlimited fix attempts** — removed hard cap on review fix cycles; same-error detection is the only halt mechanism
- **awaiting_gates state** — gates wait for ALL active chains to finish review/fix before running; prevents premature gate execution on incomplete work
- **Pending chains block gates** — queued (not-yet-started) chains also prevent gate execution
- **Terminal chain cleanup** — passed/failed chains pruned from memory after 60 seconds
- **parentChainId linkage** — gate-failure follow-up chains correctly linked to parent via pendingParentChainIds map
- **activeChainCount O(1)** — counter replaces O(n) filter for chain cap checks

### WRFC Conversation Integration
- **8 lifecycle listeners** — chain-created, review-complete, fix-attempt, chain-passed, chain-failed, auto-commit, gate-result, cascade-abort all bubble to the conversation
- **Cleaner review messages** — failed reviews show score + threshold + "spawning a fix agent" instead of separate fix-attempt lines
- **Left margin on all log lines** — conversation.log() now applies LAYOUT.LEFT_MARGIN to all lines including the first
- **Proxy method binding fix** — providerRegistry and configManager Proxy exports now bind methods to singleton, fixing model/config switch not applying

### Agent Execution
- **Inline exec for agents** — agent exec calls forced to `background: false` with 10-minute default timeout; no more leaked background processes
- **Process cleanup on completion** — orphaned background processes killed when agent finishes (safety net)
- **Non-git repo failsafe** — autoCommit gracefully passes WRFC chain when project has no `.git` directory instead of crashing

### Process Modal & UI
- **Smart agent labels** — process modal shows `[Engineer]`, `[Review]`, `[Fix #N]` with original task description and score info (e.g. `8.4 → 9.9/10`)
- **Completed processes hidden** — finished agents and done exec processes filtered from process modal and footer indicator
- **Agent detail modal truncated** — task text capped to first line (120 chars) instead of dumping full WRFC request

### Rendering Fixes
- **Symbol width fix** — ✓ ✗ ✔ ✘ and box drawing characters correctly treated as single-width in getDisplayWidth()
- **ReviewerReport type narrowing** — fixed TypeScript errors in wrfc-controller.ts

---

## [0.9.6] — 2026-03-17

### Visual Redesign
- **Consistent margins** — 4-char left margin, 2-char right margin on all assistant content, tool results, system messages, and thinking blocks. Centralized in `src/renderer/layout.ts` as single source of truth.
- **Tool call collapsed format** — replaced full-width black bars with clean single-line format: status icon (✓/✗/⠋) + tool name + key argument + result summary + duration. Collapsed by default.
- **Tool results through markdown** — expanded tool results now render through the markdown pipeline with syntax highlighting. JSON results auto-wrapped in code fences.
- **Thinking blocks** — replaced emoji prefix with dim purple left border (`▍`), italic dimmed text. Cleaner, less noisy.
- **System message types** — differentiated by type: red border for errors, yellow for warnings, cyan for info. Replaces the old all-red styling.
- **Click-to-toggle** — single click on collapsed/expanded blocks toggles them. Distinguishes clicks from drag-to-select (2-cell threshold).
- **Code block right margin** — code blocks now respect the 2-char right margin instead of running edge-to-edge.
- **Code block left margin** — code blocks (header, content, footer) now start at column 4 with no bg bleed into margin area.
- **Bold markdown fix** — `**bold**` now renders correctly after emoji (surrogate pair handling in plain text accumulator).
- **Skill slash commands** — `/add-provider` (and any skill with matching triggers) now works as a slash command.
- **Registry search paths** — skill/agent discovery now searches `.goodvibes/tui/skills/` and directory-based `SKILL.md`/`AGENT.md` formats.
- **Version propagation** — version is now 0.9.6 everywhere (package.json is single source of truth via prebuild).

### New Files
- `src/renderer/layout.ts` — LAYOUT, TOOL_STATUS, BORDERS constants
- `src/renderer/thinking.ts` — thinking block renderer with left border
- `src/renderer/system-message.ts` — system message renderer with typed borders

---

## [0.9.5] — 2026-03-17

### Automated WRFC Chains (Section 8)
- **WrfcController** — event-driven state machine that automates Work-Review-Fix-Complete chains. Every agent spawned without `skipWrfc` gets an auto-generated WRFC chain.
- **10-dimension reviewer** — dedicated reviewer archetype with scoring rubric (Correctness, Type Safety, Error Handling, Security, Performance, Code Quality, Testing, Documentation, Completeness, Integration). Each dimension 0-1.0, minimum threshold configurable (default 9.9).
- **Automated fix cycles** — when review score falls below threshold, a fixer agent is spawned with the full issue list and point values. Max fix attempts configurable (default 3).
- **Quality gates** — after review passes, configurable gates run (typecheck, lint, test, build). Gate failures spawn a new WRFC chain to fix them.
- **Auto-commit** — when review passes and all gates pass, changes are auto-committed via AgentWorktree.
- **Structured completion reports** — agents produce typed JSON reports (EngineerReport, ReviewerReport, TesterReport, GenericReport) parsed by the controller.
- **WRFC chain tracing** — every chain gets a `wrfc-{uuid}` ID. All agents in a chain (engineer, reviewer, fixer) share the same ID for post-hoc traceability.

### Agent Communication (Section 7)
- **User-message injection** — AgentMessageBus messages now injected as user messages (not system), so agents acknowledge and can respond to inter-agent communication.
- **Full output capture** — `AgentRecord.fullOutput` stores the complete final assistant response (no more 200-char truncation). Captured on success, failure, and max-turns paths.
- **skipWrfc flag** — agents spawned with `skipWrfc: true` bypass the WRFC chain (for utility agents, reviewers, fixers).

### Custom Providers
- **Custom provider loader** — loads `*.json` configs from `~/.goodvibes/tui/providers/` to add OpenAI-compatible providers (OpenRouter, Ollama, Together, Groq, LM Studio, Fireworks, vLLM).
- **Hot-reload** — file watcher auto-reloads provider configs on change with 300ms debounce.
- **Add Provider skill** — bundled interactive skill guiding users through provider setup with smart defaults for 7 providers.

### Registry & Deployment
- **Directory-based skills/agents** — registry tool now discovers `skills/foo/SKILL.md` and `agents/foo/AGENT.md` in addition to flat `.md` files.
- **Expanded search paths** — registry searches `.goodvibes/skills/`, `.goodvibes/tui/skills/`, `~/.goodvibes/skills/`, and `~/.goodvibes/tui/skills/` (same for agents).
- **Postinstall script** — `scripts/postinstall.ts` deploys bundled skills and agents to `~/.goodvibes/tui/` without overwriting existing files.
- **Git tracking** — `.goodvibes/skills/` and `.goodvibes/agents/` are now tracked in git (rest of `.goodvibes/` remains ignored).

### Configuration
- **WRFC config section** — `wrfc.scoreThreshold` (default 9.9), `wrfc.maxFixAttempts` (default 3), `wrfc.autoCommit` (default true), `wrfc.gates` array.
- **WRFC events** — 8 new EventBus events for chain lifecycle (chain-created, state-changed, review-complete, fix-attempt, gate-result, chain-passed, chain-failed, auto-commit).

---

## [0.9.4] — 2026-03-17

### Agent System
- **Agent session JSONL logging** — every agent run produces a full session log at `.goodvibes/tui/sessions/agent-{id}.jsonl` with LLM requests/responses, tool calls (name, args, result preview), and lifecycle events (start, complete, fail, cancel, max turns)
- **Rich agent system prompt** — 5-layer prompt: base autonomy instructions, archetype overlay (from `.goodvibes/agents/*.md` or built-in fallbacks), project context (auto-detected), coding conventions (from `.goodvibes/GOODVIBES.md`), and task description
- **Dynamic tool descriptions** — agent prompts only include descriptions for tools the agent actually has access to, with all 11 tool types covered (read, write, edit, find, exec, analyze, inspect, state, fetch, workflow, registry)
- **Project context auto-detection** — agents receive working directory, project type, package manager, TypeScript status, test framework, entry points, and available scripts
- **Recovery strategy** — agents instructed to try own knowledge, search context7 MCP docs if available, read local files, then try alternatives before reporting failure
- **Shared file state** — `FileStateCache` and `ProjectIndex` passed through to agent-scoped tool registries so agents share cache/OCC state with the main session

### Process Monitor
- **Process indicator below input** — moved from above to below the input area, focusable via down arrow from the prompt
- **Keyboard navigation** — down arrow focuses indicator, Enter opens process list (same as F2), up arrow returns to input, Ctrl shortcuts fall through to global handlers, works from both single-line and multiline input
- **Full-width process list** — F2 modal uses full terminal width with dynamic label sizing
- **All agent statuses visible** — completed, failed, and cancelled agents remain in the process list with status icons
- **Full-width detail modals** — agent detail and live tail modals use full terminal width
- **Session log in detail view** — agent detail modal displays last 10 JSONL session events with timestamps, loaded async on open

### Infrastructure
- **`logger.warn()` method** — added to `ActivityLogger` alongside existing info/error/debug
- **Partial dependency warning** — `AgentOrchestrator.getFullRegistry()` logs a warning when only one of FileStateCache/ProjectIndex is injected
- **Project context caching** — `buildProjectContext()` result cached per session, not recomputed per agent
- **`bun.lock` detection** — package manager detection recognizes both `bun.lockb` and text-based `bun.lock`
- **`formatDuration` shared utility** — extracted from duplicated implementations into `modal-utils.ts`
- **Named constants** — magic numbers replaced with descriptive constants across process-modal and agent-detail-modal


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
