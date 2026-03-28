# Test Coverage Audit

**Date:** 2026-03-28  
**Issue:** #21  
**Audited by:** goodvibes:tester  

---

## 1. Current Test Status

| Metric | Value |
|--------|-------|
| Total tests run | 3,166 |
| Passing | 2,947 |
| Failing | 219 |
| Errors (runtime) | 28 |
| Pass rate | 93.1% |
| Test files | 145 |
| Source files (src/) | 240 |
| Run time | ~18s |

### Failing Test Suites (by describe block)

These suites have at least one failing test. The tests exist but are broken — these are **regressions**, not gaps.

| Suite | File | Estimated Failing |
|-------|------|-------------------|
| ConfigManager / Config persistence | `src/test/config/manager.test.ts`, `src/test/integration/config-persistence.test.ts`, `src/test/integration/config-reset.test.ts` | ~28 |
| Agent lifecycle (cancel/spawn/list/message bus) | `src/test/integration/agent-lifecycle.test.ts` | ~12 |
| AgentRunner (spawning/timeout/completion/error) | `src/test/hooks/runners/agent.test.ts` | ~15 |
| ImportGraph (build/findDependents/markDirty) | `src/intelligence/__tests__/import-graph.test.ts` | ~9 |
| command runner (timeout/error) | `src/test/hooks/runners/command.test.ts` | ~2 |
| ProcessManager (spawn/getOutput/handleCommand) | `src/test/tools/shared/process-manager.test.ts` | ~4 |
| DaemonServer / HttpListener | `src/test/daemon/server.test.ts` | ~5 |
| WrfcController | `src/test/agents/wrfc-controller.test.ts` | ~5 |
| Permission flow (auto-approve/cache/custom) | `src/test/integration/permission-flow.test.ts` | ~8 |
| Tool execution pipeline | `src/test/integration/tool-execution.test.ts` | ~4 |
| resolveApiKeys | `src/test/config/resolve-api-keys.test.ts` | ~3 |
| F6 formatProviderError | (various) | ~2 |
| StreamDelta accumulation | `src/test/agents/streaming.test.ts` | ~2 |
| Orchestrator (capability check) | `src/test/core/orchestrator.test.ts` | ~1 |
| ConversationManager title | `src/test/core/conversation.test.ts` | ~1 |
| LspService auto-detection | `src/test/intelligence/lsp.test.ts` | ~1 |
| budget/cancel/get/list/message/plan/progress/recommend/spawn/status/wait modes | (tool mode tests) | ~60 |

**Action required:** Fix failing tests before adding new ones. Many failures appear to be import/initialization errors rather than logic failures.

---

## 2. Coverage by Module

### 2a. Well-Covered Modules

These modules have dedicated test files and reasonable coverage:

| Module | Test File(s) | Notes |
|--------|-------------|-------|
| `src/agents/` | `src/test/agents/*.test.ts` (8 files) | Some failing |
| `src/bookmarks/` | `src/test/bookmarks/manager.test.ts` | Good |
| `src/config/` | `src/test/config/*.test.ts` (6 files) | Some failing |
| `src/core/event-bus.ts` | `src/core/event-bus.test.ts`, `src/test/core/event-bus.test.ts` | Duplicated — two test files |
| `src/core/conversation.ts` | `src/test/core/conversation.test.ts` | Some failing |
| `src/core/event-replay.ts` | `src/test/core/event-replay.test.ts` | Good |
| `src/core/execution-plan.ts` | `src/test/core/execution-plan.test.ts` | Good |
| `src/core/history.ts` | `src/test/core/history.test.ts` | Good |
| `src/core/intent-classifier.ts` | `src/test/core/intent-classifier.test.ts` | Good |
| `src/core/orchestrator.ts` | `src/test/core/orchestrator.test.ts` | Some failing |
| `src/daemon/server.ts` | `src/test/daemon/server.test.ts` | Some failing |
| `src/discovery/scanner.ts` | `src/test/discovery/scanner-context.test.ts` | Partial |
| `src/git/service.ts` | `src/test/git/service.test.ts` | Good |
| `src/hooks/` | `src/test/hooks/*.test.ts` (10 files) | Some failing |
| `src/input/` | `src/test/input/*.test.ts` (16 files) | Good coverage |
| `src/integrations/` | `src/test/integrations/*.test.ts` (2 files) | Good |
| `src/intelligence/facade.ts` | `src/test/intelligence/facade.test.ts` | Good |
| `src/intelligence/lsp/` | `src/test/intelligence/lsp.test.ts` | Some failing |
| `src/intelligence/tree-sitter/` | `src/test/intelligence/tree-sitter.test.ts` | Good |
| `src/mcp/` | `src/test/mcp/*.test.ts` (3 files) | Good |
| `src/permissions/` | `src/test/permissions/*.test.ts` (2 files) | Good |
| `src/profiles/manager.ts` | `src/test/profiles/manager.test.ts` | Good |
| `src/providers/graceful-degradation.ts` | `src/test/providers/graceful-degradation.test.ts` | Good |
| `src/providers/reasoning-effort.ts` | `src/test/providers/reasoning-effort.test.ts` | Good |
| `src/providers/tier-prompts.ts` | `src/test/providers/tier-prompts.test.ts` | Good |
| `src/providers/tool-formats.ts` | `src/test/providers/tool-formats.test.ts` | Good |
| `src/renderer/` | `src/test/renderer/*.test.ts` (20 files) | Partial |
| `src/scheduler/scheduler.ts` | `src/test/scheduler/scheduler.test.ts` | Good |
| `src/security/` | `src/test/security/*.test.ts` (2 files) | Good |
| `src/sessions/manager.ts` | `src/test/sessions/manager.test.ts` | Good |
| `src/state/` | `src/test/state/*.test.ts` (7 files), `src/state/__tests__/file-undo.test.ts` | Partial |
| `src/tools/` | `src/test/tools/*.test.ts` (19 files) | Some failing |
| `src/workflow/trigger-executor.ts` | `src/test/workflow/trigger-executor.test.ts` | Good |
| `src/workflow/schedule-manager.ts` | `src/test/workflow/schedule-manager.test.ts` | Good |
| `src/plugins/` | `src/test/plugins/plugin-system.test.ts` | Good |

#### Cross-cutting / Feature Tests

These test files exercise cross-module behavior or feature slices rather than a single source module:

| Test File | Notes |
|-----------|-------|
| `src/test/core/h8-h11-features.test.ts` | H8–H11 feature bundle |
| `src/test/core/output-enhancements.test.ts` | Output formatting enhancements |
| `src/test/core/plan-integration.test.ts` | Plan manager integration |
| `src/test/core/qol-f456.test.ts` | QoL features F4–F6 |
| `src/test/core/qol-features.test.ts` | QoL feature bundle |
| `src/test/core/streaming.test.ts` | Streaming pipeline (cross-module) |
| `src/test/core/undo-retry.test.ts` | Undo/retry orchestration |
| `src/test/workflow/schedule-manager.test.ts` | Schedule manager workflow |
| `src/test/plugins/plugin-system.test.ts` | Plugin system lifecycle |
| `src/test/features/batch5-extras.test.ts` | Batch 5 feature extras |
| `src/test/deps/dependency-check.test.ts` | Dependency validation |

#### Integration Tests (`src/test/integration/` — 6 files)

| Test File | Notes |
|-----------|-------|
| `src/test/integration/agent-lifecycle.test.ts` | Agent spawn/cancel/list |
| `src/test/integration/config-persistence.test.ts` | Config read/write cycle |
| `src/test/integration/config-reset.test.ts` | Config reset behavior |
| `src/test/integration/hook-lifecycle.test.ts` | Hook registration and firing |
| `src/test/integration/permission-flow.test.ts` | Permission auto-approve/cache |
| `src/test/integration/tool-execution.test.ts` | End-to-end tool pipeline |

### 2b. Zero-Coverage Modules (No Test Files)

These source modules have **no test files at all**:

#### src/acp/ — 0 tests, 4 source files
- `src/acp/connection.ts`
- `src/acp/manager.ts`
- `src/acp/protocol.ts`
- `src/acp/index.ts`

#### src/export/ — partially covered, 2 source files
- `src/export/session-export.ts` (642 lines — exports to JSON, Markdown, HTML with redaction) — **test file exists:** `src/test/export/session-export.test.ts`
- `src/export/markdown.ts` (214 lines — `exportToMarkdown`) — no test file

#### src/panels/ — 0 tests, 26 source files
- `src/panels/diff-panel.ts` (483 lines — `DiffPanel`, `parseDiff`, `splitIntoDiffEntries`)
- `src/panels/cost-tracker-panel.ts` (514 lines — `CostTrackerPanel`, cost calc, sparklines)
- `src/panels/provider-health-panel.ts` (487 lines — `ProviderHealthTracker`, `ProviderHealthPanel`)
- `src/panels/panel-manager.ts`
- `src/panels/base-panel.ts`
- `src/panels/builtin-panels.ts`
- `src/panels/provider-stats-panel.ts`
- `src/panels/plan-dashboard-panel.ts`
- `src/panels/token-budget-panel.ts`
- `src/panels/session-browser-panel.ts`
- `src/panels/symbol-outline-panel.ts`
- `src/panels/thinking-panel.ts`
- `src/panels/wrfc-panel.ts`
- `src/panels/git-panel.ts`
- `src/panels/file-explorer-panel.ts`
- `src/panels/file-preview-panel.ts`
- `src/panels/docs-panel.ts`
- `src/panels/debug-panel.ts`
- `src/panels/schedule-panel.ts`
- `src/panels/context-visualizer-panel.ts`
- `src/panels/agent-inspector-panel.ts`
- `src/panels/agent-logs-panel.ts`
- `src/panels/panel-picker.ts`
- `src/panels/tool-inspector-panel.ts`
- `src/panels/types.ts`
- `src/panels/index.ts`

#### src/templates/ — partially covered, 1 source file
- `src/templates/manager.ts` — **test file exists:** `src/test/templates/manager.test.ts`

#### src/utils/ — partially covered, 10 source files
- `src/utils/path-safety.ts` (18 lines — `resolveAndValidatePath`, security-critical) — **test file exists:** `src/test/utils/path-safety.test.ts`
- `src/utils/retry.ts` (101 lines — `withRetry`, `isRetryableError`, `computeDelay`) — **test file exists:** `src/test/utils/retry.test.ts`
- `src/utils/glob-to-regex.ts` (31 lines — `globToRegex`, `buildGlobMatcher`) — **test file exists:** `src/test/utils/glob-to-regex.test.ts`
- `src/utils/clipboard.ts`
- `src/utils/error-display.ts`
- `src/utils/logger.ts`
- `src/utils/notify.ts` — **test file exists:** `src/test/utils/notify.test.ts`
- `src/utils/terminal-width.ts`
- `src/utils/prompt-loader.ts` — **test file exists:** `src/test/utils/prompt-loader.test.ts`
- `src/utils/splash-lines.ts`

### 2c. Partially-Covered Modules

Modules that have test files but with identified gaps:

| Module | Gap |
|--------|-----|
| `src/providers/synthetic.ts` | No tests: `SyntheticProvider.chat()`, failover logic, cooldown handling, `isRateLimitOrQuotaError` |
| `src/providers/model-limits.ts` | No tests: `getTokenLimitsForModel`, `getContextWindowForModel`, `getPricingForModel`, `refreshModelLimits`, cache staleness logic, `findOpenRouterMatch` |
| `src/providers/anthropic.ts` | No dedicated test |
| `src/providers/openai.ts` | No dedicated test |
| `src/providers/gemini.ts` | No dedicated test |
| `src/providers/registry.ts` | No dedicated test |
| `src/core/context-compaction.ts` | **Test file exists** (`src/test/core/context-compaction.test.ts`); verify coverage of `compactMessages`, `shouldAutoCompact`, `estimateConversationTokens`, `checkAndCompact`, `partitionMessages` |
| `src/core/tokenizer.ts` | No dedicated test |
| `src/core/plan-manager-instance.ts` | No dedicated test |
| `src/input/command-registry.ts` | No dedicated test: `CommandRegistry.fuzzyMatch`, `scoreMatch`, `execute`, alias resolution |
| `src/input/handler.ts` | No dedicated test (2,327 lines — largest file, UI event handler) |
| `src/input/autocomplete.ts` | No dedicated test |
| `src/input/file-picker.ts` | No dedicated test |
| `src/input/model-picker.ts` | No dedicated test |
| `src/input/commands.ts` | No dedicated test |
| `src/state/sqlite-store.ts` | No test: `SQLiteStore.init`, `save`, `run`, `exec`, `close` |
| `src/state/persistent-store.ts` | No dedicated test |
| `src/state/db.ts` | No dedicated test |
| `src/state/kv-state.ts` | Partial |
| `src/state/project-index.ts` | Partial |
| `src/renderer/buffer.ts` | No dedicated test |
| `src/renderer/diff.ts` | No dedicated test |
| `src/renderer/layout.ts` | No dedicated test |
| `src/renderer/system-message.ts` | No dedicated test |
| `src/renderer/tool-call.ts` | No dedicated test |
| `src/renderer/autocomplete-overlay.ts` | No dedicated test |
| `src/renderer/semantic-diff.ts` | No dedicated test |
| `src/acp/connection.ts` | No test |
| `src/discovery/scanner.ts` | Only scanner-context tested, core scanning logic untested |
| `src/sessions/change-tracker.ts` | No dedicated test |
| `src/hooks/runners/http.ts` | No dedicated test (other runners tested) |
---

## 3. Priority List — Modules Needing Tests

Ranked by: **security risk** > **code size / complexity** > **usage frequency** > **failure blast radius**.

### Priority 1 — Critical (fix before any new tests)

These are currently broken. Engineers must fix these first as they mask real coverage.

| # | Module / Suite | Why Critical |
|---|---------------|-------------|
| 1 | `ConfigManager` + Config persistence | 28+ failures; config is foundational to the entire app |
| 2 | `AgentRunner` + Agent lifecycle | 27+ failures; agents are the primary execution model |
| 3 | `ProcessManager` | 4 failures; used by exec tool and daemon |
| 4 | `Permission flow` | 8 failures; security boundary — broken permissions is a blocker |
| 5 | `Tool execution pipeline` | 4 failures; all tool invocations flow through this |
| 6 | `ImportGraph` | 9 failures; intelligence layer is broken |

### Priority 2 — Security / Data Integrity (new tests needed)

| # | Module | Risk | Estimated Test Cases |
|---|--------|------|---------------------|
| 1 | `src/utils/path-safety.ts` | **HIGH** — single function `resolveAndValidatePath`; path traversal vulnerability; test file exists — verify and extend coverage | 6 |
| 2 | `src/export/session-export.ts` | **HIGH** — `redactSensitiveData`, `redactMessage`, `redactArgs`; data leakage risk; test file exists — verify and extend existing tests | 15 |
| 3 | `src/providers/synthetic.ts` | **HIGH** — failover logic, cooldown enforcement; billing/quota logic if broken causes 402 errors | 12 |
| 4 | `src/state/sqlite-store.ts` | **MEDIUM** — data persistence, crash recovery, schema init | 8 |

### Priority 3 — Core Logic (high complexity, widely used)

| # | Module | Complexity | Estimated Test Cases |
|---|--------|-----------|---------------------|
| 1 | `src/core/context-compaction.ts` | 342 lines, 8 exported functions; `compactMessages` calls the LLM — needs mock; test file exists — verify and extend existing tests | 14 |
| 2 | `src/providers/model-limits.ts` | 398 lines; cache TTL logic, OpenRouter model matching, fallback chains | 18 |
| 3 | `src/utils/retry.ts` | 101 lines; used across all providers; exponential backoff, retryable error detection; test file exists — verify and extend | 10 |
| 4 | `src/utils/glob-to-regex.ts` | 31 lines; used in hooks/matchers; invalid glob must not crash; test file exists — verify and extend | 8 |
| 5 | `src/input/command-registry.ts` | 188 lines; `fuzzyMatch` scoring, alias resolution, `execute` | 12 |
| 6 | `src/panels/diff-panel.ts` | 483 lines; `parseDiff` and `splitIntoDiffEntries` are pure functions, fully testable | 16 |
| 7 | `src/panels/cost-tracker-panel.ts` | 514 lines; `getPricing`, `calcCost`, `formatCost`, `buildSparkline` are pure functions | 14 |
| 8 | `src/panels/provider-health-panel.ts` | 487 lines; `ProviderHealthTracker` state machine (onTurnStart/onLlmResponse/onTurnError) | 16 |

### Priority 4 — Feature Completeness (medium risk)

| # | Module | Gap | Estimated Test Cases |
|---|--------|-----|---------------------|
| 1 | `src/export/markdown.ts` | `exportToMarkdown` — all message roles, tool calls, reasoning content | 10 |
| 2 | `src/acp/manager.ts` | `AcpManager.spawn`, `cancel`, `cancelAll`, `waitAll` | 10 |
| 3 | `src/input/keybindings.ts` | `KeybindingsManager.matches`, `loadFromDisk`, `formatCombo` (test file exists but coverage unclear) | 8 |
| 4 | `src/discovery/scanner.ts` | Core scanning: directory traversal, gitignore respect, depth limits | 12 |
| 5 | `src/providers/anthropic.ts` | Chat request shaping, streaming delta assembly, error mapping | 10 |
| 6 | `src/providers/openai.ts` | Same as anthropic, plus tool_choice formats | 10 |
| 7 | `src/sessions/change-tracker.ts` | Change tracking, diff generation | 6 |
| 8 | `src/state/persistent-store.ts` | Read/write cycle, corruption handling | 6 |
| 9 | `src/core/tokenizer.ts` | Token count estimation accuracy | 8 |
| 10 | `src/templates/manager.ts` | Template loading, variable substitution; test file exists — verify and extend `src/test/templates/manager.test.ts` | 8 |

### Priority 5 — Rendering / UI Logic (low risk, still valuable)

These are TUI rendering components. The primary risk is visual regressions, not data corruption. Test the **data transformation logic** (render functions that convert state → `Line[]`), not Ink component output.

| # | Module | What to Test |
|---|--------|-------------|
| 1 | `src/renderer/diff.ts` | Diff computation, line-by-line output |
| 2 | `src/renderer/markdown.ts` | Existing test — verify completeness |
| 3 | `src/renderer/layout.ts` | Column layout math, overflow handling |
| 4 | `src/renderer/system-message.ts` | Message formatting |
| 5 | `src/panels/panel-manager.ts` | Panel registration, lifecycle hooks |
| 6 | `src/utils/error-display.ts` | Error formatting for display |
| 7 | `src/utils/logger.ts` | Log level filtering, output format |

---

## 4. Specific Test Cases Recommended

### 4.1 `src/utils/path-safety.ts` — verify and extend `src/test/utils/path-safety.test.ts`

```
describe('resolveAndValidatePath')
  - returns resolved absolute path for files within cwd
  - allows nested subdirectory paths
  - allows current directory reference './'
  - throws for '../escape' (one level up)
  - throws for '../../deep-escape' (two levels up)
  - throws for absolute path outside root '/etc/passwd'
```

### 4.2 `src/export/session-export.ts` — verify and extend `src/test/export/session-export.test.ts`

```
describe('redactSensitiveData')
  - redacts ANTHROPIC_API_KEY=sk-ant-xxx patterns
  - redacts OPENAI_API_KEY=sk-xxx patterns
  - redacts Bearer token strings
  - does not redact unrelated text
  - handles multi-line input

describe('redactMessage')
  - redacts string content
  - redacts ContentPart[] content (each text part)
  - passes through non-text content unchanged

describe('exportToJSON')
  - includes all messages in output
  - includes metadata when provided
  - redacts sensitive data when redact:true
  - does not redact when redact:false (default)
  - includes cost and exportedAt fields

describe('exportToMarkdownExtended')
  - renders user messages with role header
  - renders assistant messages with role header
  - renders tool calls with name and args
  - omits cancelled messages

describe('exportToHTML')
  - produces valid HTML structure (contains <html>, <body>)
  - escapes HTML entities in message content
  - includes CSS block
  - applies redaction when requested

describe('defaultExportPath')
  - returns .json path for json format
  - returns .md path for md format
  - returns .html path for html format
```

### 4.3 `src/export/markdown.ts` → `src/test/export/markdown.test.ts`

```
describe('exportToMarkdown')
  - renders empty message list
  - renders user message with correct heading
  - renders assistant message with correct heading
  - renders system message
  - renders tool result message with callId
  - renders reasoningContent when present
  - renders reasoningSummary when present
  - renders ContentPart[] by concatenating text parts
  - renders toolCalls with name and args
  - includes metadata header when provided
  - marks cancelled messages with [Cancelled]
  - includes usage tokens in output when present
```

### 4.4 `src/providers/synthetic.ts` → `src/test/providers/synthetic.test.ts`

```
describe('isRateLimitOrQuotaError')
  - returns true for 429 status errors
  - returns true for errors containing 'rate limit'
  - returns true for 402 quota exhaustion
  - returns false for non-rate-limit errors
  - returns false for null/undefined

describe('SyntheticProvider')
  - constructor sets models list from MANUAL_SYNTHETIC_OVERRIDES keys
  - chat() calls the first backend provider's chat method
  - chat() fails over to second backend when first raises rate limit error
  - chat() enters cooldown for a backend after rate limit (does not retry immediately)
  - chat() throws after all backends are in cooldown
  - chat() recovers backend after cooldown period expires
  - chat() records 402 quota error as rate-limit cooldown
  - chat() passes through non-rate-limit errors immediately without failover
```

### 4.5 `src/providers/model-limits.ts` → `src/test/providers/model-limits.test.ts`

```
describe('getModelStem')
  - strips provider prefix from 'openai/gpt-4o' → 'gpt-4o'
  - returns unchanged for bare model id

describe('findOpenRouterMatch')
  - exact match by full id returns model data
  - stem match returns model data when no exact match
  - returns null when no match found

describe('resolveTokenLimits')
  - uses model definition limits when available
  - falls back to DEFAULT_TOKEN_LIMITS when model has no limits
  - merges provider overrides over model defaults

describe('isCacheStale')
  - returns false for freshly-fetched cache
  - returns true when fetchedAt + ttlMs < now

describe('getContextWindowForModel')
  - returns contextWindow from model definition
  - returns DEFAULT_TOKEN_LIMITS.contextWindow as fallback

describe('getPricingForModel')
  - returns pricing from cached OpenRouter data when available
  - returns null when cache miss
```

### 4.6 `src/core/context-compaction.ts` — verify and extend `src/test/core/context-compaction.test.ts`

```
describe('estimateConversationTokens')
  - returns 0 for empty message list
  - counts string content by character length / 4
  - handles ContentPart[] by extracting text

describe('shouldAutoCompact')
  - returns false when already compacting
  - returns false when below threshold
  - returns true when currentTokens / contextWindow >= threshold
  - returns false when contextWindow is 0 (guard)

describe('partitionMessages')
  - keeps the last N messages in recent partition
  - puts all messages before N in older partition
  - handles keepRecent larger than message list length

describe('getCompactionEvents')
  - returns empty array initially
  - returns recorded events after compaction

describe('getLastCompactionEvent')
  - returns null when no events
  - returns most recent event after multiple compactions

describe('compactMessages') [mocked LLM]
  - calls registry with summarization prompt
  - prepends summary as system message in result
  - appends kept recent messages after summary
  - records compaction event with correct token estimates
  - sets trigger to 'manual' or 'auto' based on option
  - throws when provider returns empty response

describe('checkAndCompact')
  - returns null when shouldAutoCompact returns false
  - calls compactMessages when shouldAutoCompact returns true
```

### 4.7 `src/utils/retry.ts` — verify and extend `src/test/utils/retry.test.ts`

```
describe('isRetryableError')
  - returns true for 429 status code errors
  - returns true for 500 status code errors
  - returns true for 503 status code errors
  - returns false for 400 bad request
  - returns false for 401 unauthorized
  - returns false for non-HTTP errors

describe('computeDelay')
  - first attempt returns initialDelayMs
  - second attempt doubles the delay (exponential)
  - caps at maxDelayMs

describe('withRetry')
  - returns immediately on first success (no retries)
  - retries on retryable error, then succeeds
  - throws after max retries exhausted
  - calls onRetry callback with attempt number and delay
  - does not retry non-retryable errors
  - respects custom maxRetries config
```

### 4.8 `src/utils/glob-to-regex.ts` — verify and extend `src/test/utils/glob-to-regex.test.ts`

```
describe('globToRegex')
  - '*.ts' matches 'foo.ts'
  - '*.ts' does not match 'foo.tsx'
  - '**/*.ts' matches 'src/foo/bar.ts'
  - '**/*.ts' matches file in root 'foo.ts'
  - '!*.ts' negation pattern is handled correctly
  - handles literal dots in extension
  - handles path separators correctly

describe('buildGlobMatcher')
  - returns a function
  - returned function matches expected paths
  - returned function rejects non-matching paths
```

### 4.9 `src/input/command-registry.ts` → `src/test/input/command-registry.test.ts`

```
describe('CommandRegistry')
  - register() adds command by name
  - register() indexes aliases
  - get() retrieves by primary name
  - get() retrieves by alias
  - getAll() returns all registered commands
  - unregister() removes command and its aliases
  - fuzzyMatch() returns exact match at top
  - fuzzyMatch() returns prefix match
  - fuzzyMatch() returns empty array when no match
  - execute() calls handler with args and context
  - execute() returns false for unknown command
  - execute() returns true on success

describe('scoreMatch')
  - exact match scores higher than prefix match
  - prefix match scores higher than substring match
  - returns 0 for no match
```

### 4.10 `src/panels/diff-panel.ts` — pure function tests

```
describe('parseDiff') — extract to testable module or test via DiffPanel
  - parses addition lines (starting with '+')
  - parses deletion lines (starting with '-')
  - parses context lines
  - parses hunk headers '@@ -1,5 +1,7 @@'
  - parses file header lines ('--- a/file', '+++ b/file')
  - assigns correct beforeNum and afterNum from hunk counters

describe('splitIntoDiffEntries')
  - returns empty array for empty input
  - splits single-file diff into one entry
  - splits multi-file diff by 'diff --git' marker
  - each entry has filePath parsed from header

describe('DiffPanel')
  - showDiff() sets entries with single file
  - loadRawDiff() parses raw diff string
  - handleInput() 'j' scrolls down
  - handleInput() 'k' scrolls up
  - handleInput() 'tab' advances to next file
  - handleInput() unknown key returns false
  - render() returns empty state line when no entries
  - clear() resets entries and scroll
```

### 4.11 `src/panels/cost-tracker-panel.ts` — pure function tests

```
describe('getPricing')
  - returns known model pricing for 'claude-3-5-sonnet'
  - returns known model pricing for 'gpt-4o'
  - returns DEFAULT_PRICING for unknown model
  - matches by model substring for versioned models

describe('calcCost')
  - calculates correct cost: inputTokens * input_rate + outputTokens * output_rate
  - returns 0 for zero tokens

describe('formatCost')
  - formats $0.00 as '$0.00'
  - formats fractional cents correctly
  - formats values >= $1.00 with two decimal places

describe('formatTokens')
  - formats values < 1000 without suffix
  - formats values >= 1000 with 'k' suffix
  - formats values >= 1000000 with 'M' suffix

describe('buildSparkline')
  - returns empty string for empty input
  - returns 16-character string for filled history
  - uses '▁' for minimum values, '█' for maximum
```

### 4.12 `src/panels/provider-health-panel.ts` — `ProviderHealthTracker`

```
describe('ProviderHealthTracker')
  - getAll() returns empty array initially
  - onLlmResponse() records success for active provider
  - onLlmResponse() sets status to 'online'
  - onLlmResponse() calculates latency from stream start
  - onTurnError() with rate-limit message sets status to 'rate-limited'
  - onTurnError() with non-rate-limit message sets status to 'error'
  - onTurnError() with rate-limit sets rateLimitExpiresAt in the future
  - _isRateLimitMessage() returns true for '429', 'rate limit', 'quota'
  - _isRateLimitMessage() returns false for generic errors
  - onProvidersChanged() adds new providers to records
  - get() returns undefined for unknown provider
  - get() returns health record for known provider
```

### 4.13 `src/acp/manager.ts` → `src/test/acp/manager.test.ts`

```
describe('AcpManager')
  - spawn() returns agent id string
  - spawn() creates AcpConnection with task
  - getActive() returns list of active agent infos
  - getActive() returns empty array initially
  - cancel() cancels connection for given id
  - cancel() is a no-op for unknown id
  - cancelAll() cancels all active connections
  - waitAll() resolves when all pending promises resolve
  - waitAll() returns results from all agents
```

---

## 5. Summary Table

| Priority | Category | Files | Estimated New Tests | Risk if Skipped |
|----------|----------|-------|--------------------|-----------------|
| 1 (Fix) | Broken tests | 6 suites | — | Masks real regressions |
| 2 | Security / data | 4 modules | ~41 | Data leak, path traversal, billing failures |
| 3 | Core logic | 8 modules | ~108 | Silent wrong behavior |
| 4 | Feature completeness | 10 modules | ~86 | Undetected feature regressions |
| 5 | Rendering / UI | 7 modules | ~35 | Visual regressions only |
| **Total** | | **~33 new + 5 extend** | **~242** | |

---

## 6. Notes for Engineers

1. **Duplicate test file:** `src/core/event-bus.test.ts` is covered by both `src/core/event-bus.test.ts` and `src/test/core/event-bus.test.ts`. Consider deduplicating.

2. **Test infrastructure note:** Many failures (especially agent/config tests) appear to be caused by shared singleton state bleeding between tests. Look for `ConfigManager`, `AgentManager`, and `EventBus` instances that need `beforeEach` resets.

3. **Mocking strategy for LLM calls:** `compactMessages` and provider tests (`anthropic.ts`, `openai.ts`, `synthetic.ts`) require mocking the `LLMProvider.chat()` interface. Use `vi.fn()` or bun mock equivalents on the provider registry.

4. **Panel tests strategy:** All panel `render()` methods return `Line[]` (not Ink JSX). Pure function tests on the render output are straightforward — no DOM or Ink test renderer needed. Focus on the logic-heavy private helpers (`parseDiff`, `getPricing`, `buildSparkline`, `ProviderHealthTracker`) first.

5. **`src/input/handler.ts` (2,327 lines):** This is the largest file with no dedicated test. Given its size and UI-coupling, test it last and focus on the pure logic extracted into sub-functions rather than the full input handler.

6. **`src/utils/path-safety.ts`** should be the **first** new test written — it is 18 lines, has 6 clear test cases, and is a security boundary. It is an easy win.
