# goodvibes-tui Roadmap

> Generated 2026-03-27 from comprehensive codebase analysis.
> Current version: **0.9.10** | ~200 source files | ~100 test files | ~948 test cases

---

## v0.9.11 — Critical Fixes & Test Coverage

**Theme:** Stability, correctness, and confidence for the push to 1.0.

### 1. Agent streaming (not-streaming is the #1 UX bug)

- **Problem:** `src/agents/orchestrator.ts` calls `provider.chat()` without streaming. Long agent turns (30s+) appear frozen — no spinner text updates, no partial output. The main orchestrator (`src/core/orchestrator.ts`) already streams via `onDelta` callbacks, but the agent orchestrator has zero streaming code.
- **Fix:** Wire `onStream`/`onDelta` into `AgentOrchestrator.runAgent()`, emit `subagent:stream-delta` events, and surface partial output in the agent detail modal.
- **Files:** `src/agents/orchestrator.ts`, `src/renderer/agent-detail-modal.ts`, `src/core/event-bus.ts`
- **Effort:** M
- **Dependencies:** None

### 2. Auto-sync `src/version.ts` on version bumps

- **Problem:** `scripts/prebuild.ts` correctly reads `package.json` and writes `src/version.ts`, but it only runs on `bun run build` (via the `prebuild` npm script). During development (`bun run dev`), version.ts can drift. There's no `npm version` hook to keep them in sync on `npm version patch/minor/major`.
- **Fix:** Add a `version` lifecycle script in package.json that runs prebuild.ts. Alternatively, have `src/version.ts` read from package.json at runtime (eliminates the sync problem entirely).
- **Files:** `package.json`, `scripts/prebuild.ts`, `src/version.ts`
- **Effort:** S
- **Dependencies:** None

### 3. Scanner: fetch output token limits

- **Problem:** `src/discovery/scanner.ts` populates `modelContextWindows` (context window sizes) but never fetches output/max-completion token limits. The `DiscoveredServer` interface lacks an `modelOutputLimits` field. `src/providers/model-limits.ts` fetches from OpenRouter and has `max_output` in its cache, but the scanner's local-server discovery path doesn't contribute output limits.
- **Fix:** Extend `DiscoveredServer` with `modelOutputLimits?: Record<string, number>`. For Ollama, query `/api/show` for `num_predict`. For OpenAI-compat servers, check `/v1/models` response for `max_output_tokens` if available. Merge with model-limits.ts data.
- **Files:** `src/discovery/scanner.ts`, `src/providers/model-limits.ts`, `src/providers/interface.ts`
- **Effort:** M
- **Dependencies:** None

### 4. Missing test coverage

Current state: ~948 test cases across ~100 test files. The following areas have zero or insufficient coverage:

| Area | Status | Files to test | Effort |
|------|--------|---------------|--------|
| Batch agent spawn | No tests | `src/agents/orchestrator.ts` (multi-agent) | M |
| Cohort reporting | No tests | `src/agents/completion-report.ts` | S |
| Synthetic provider failover | 0 tests | `src/providers/synthetic.ts` | M |
| Model-limits resolution | 0 tests | `src/providers/model-limits.ts` | M |
| Context window detection (scanner) | 1 test file | `src/discovery/scanner.ts` (expand) | S |
| ACP connection/manager | 0 tests | `src/acp/connection.ts`, `src/acp/manager.ts` | M |
| Panel system | 0 tests | `src/panels/*.ts` | L |
| Workflow/trigger executor | 1 test | `src/workflow/trigger-executor.ts` (expand) | S |

- **Effort:** L (aggregate)
- **Dependencies:** None

### 5. TypeScript error cleanup

- **Problem:** 25 instances of `@ts-ignore`, `@ts-expect-error`, or `as any` across 8 source files. Concentrated in:
  - `src/input/commands.ts` (11 instances) — likely type narrowing issues
  - `src/intelligence/tree-sitter/embedded-wasm.ts` (7 instances) — WASM interop
  - `src/agents/worktree.ts` (2), `src/git/service.ts` (1), `src/state/sqlite-store.ts` (1), `src/state/db.ts` (1), `src/tools/analyze/index.ts` (1), `src/tools/find/index.ts` (1)
- **Fix:** Add proper types, replace `as any` with type guards, fix the underlying type issues. The WASM/sqlite ones may require declaration files.
- **Files:** See list above
- **Effort:** M
- **Dependencies:** None

### 6. CI/CD pipeline

- **Problem:** No `.github/` directory exists. No CI pipeline for tests, type checking, or builds.
- **Fix:** Create GitHub Actions workflow with: `bun test`, `bunx tsc --noEmit`, `bun run build`, artifact upload for release binaries.
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- **Effort:** M
- **Dependencies:** Item 5 (TS errors should be fixed first)

---

## v0.9.12 — UX Improvements

**Theme:** Make the existing features more usable and polished.

### 7. Model picker search/filter/grouping

- **Problem:** `src/input/model-picker.ts` shows all 370+ models in a flat list with no search. `ModelPickerModal` has `openAllModels()` that just sets `this.models = models` with no filtering, grouping, or fuzzy search.
- **Fix:** Add fuzzy search (fuse.js is already a dependency), group by provider, show capability badges (vision, tools, reasoning). Allow keyboard filtering.
- **Files:** `src/input/model-picker.ts`, `src/renderer/model-picker-overlay.ts`
- **Effort:** M
- **Dependencies:** None

### 8. Synthetic provider auto-generation

- **Problem:** `SYNTHETIC_MODEL_MAP` in `src/providers/synthetic.ts` has 6 hardcoded model entries. Any model available from 2+ providers should automatically get a synthetic failover entry.
- **Fix:** At registration time, scan all providers for overlapping model IDs (by stem, e.g., `gpt-4o` across OpenAI and Azure). Dynamically build the failover map. Keep the hardcoded map as fallback for cross-model failover (e.g., Claude -> GPT-4o).
- **Files:** `src/providers/synthetic.ts`, `src/providers/registry.ts`
- **Effort:** M
- **Dependencies:** None

### 9. Provider health/status dashboard

- **Problem:** No way to see which providers are up, rate-limited, or erroring. `src/panels/provider-stats-panel.ts` exists but its scope is unclear.
- **Fix:** Extend the provider stats panel with: last response time, error rate, rate limit status, cooldown timers (from synthetic provider), connectivity indicator. Add a `/providers` command.
- **Files:** `src/panels/provider-stats-panel.ts`, `src/providers/registry.ts`, `src/input/commands.ts`
- **Effort:** M
- **Dependencies:** None

### 10. Model-limits inform system prompt tier and context compaction

- **Problem:** `src/providers/model-limits.ts` resolves token limits per model, and `src/providers/tier-prompts.ts` defines system prompts by tier (small/medium/large). But the connection between them is manual — model-limits data doesn't automatically select the right tier or trigger context compaction when approaching limits.
- **Fix:** Wire `getTokenLimitsForModel()` into `tier-prompts.ts` selection logic. Trigger compaction when context usage exceeds 80% of the model's context window. Surface warnings in the token budget panel.
- **Files:** `src/providers/model-limits.ts`, `src/providers/tier-prompts.ts`, `src/core/orchestrator.ts`, `src/panels/token-budget-panel.ts`
- **Effort:** M
- **Dependencies:** Item 3 (output limits)

### 11. Agent progress auto-surfacing

- **Problem:** `src/agents/completion-report.ts` generates cohort reports, but nothing proactively displays agent progress. Users must manually check.
- **Fix:** Auto-show a status bar segment or notification when agents complete/fail. Emit events from `AgentOrchestrator` that the compositor can subscribe to. Show a summary toast with pass/fail counts.
- **Files:** `src/agents/orchestrator.ts`, `src/agents/completion-report.ts`, `src/renderer/compositor.ts`, `src/renderer/system-message.ts`
- **Effort:** M
- **Dependencies:** Item 1 (streaming, for progress events)

### 12. Error display improvements

- **Problem:** `src/utils/error-display.ts` exists but raw provider error messages still surface in many places (rate limits, auth failures, network errors).
- **Fix:** Create an error taxonomy with user-friendly messages. Map common provider errors (401, 402, 429, 500, ECONNREFUSED) to actionable messages with fix suggestions. Centralize through `error-display.ts`.
- **Files:** `src/utils/error-display.ts`, `src/providers/*.ts`, `src/core/orchestrator.ts`
- **Effort:** M
- **Dependencies:** None

---

## v1.0.0-rc1 — Feature Completeness

**Theme:** Everything a coding agent TUI needs to be competitive with Claude Code, Gemini CLI, and Codex.

### 13. Conversation branching (fork/try/return)

- **Problem:** No way to fork a conversation, try an approach, and return to the branch point. This is critical for exploration workflows.
- **Fix:** Implement a branching model on top of `ConversationManager`. Store branch points as snapshots. Commands: `/fork`, `/branches`, `/checkout <branch>`. Render branch indicator in status bar.
- **Files:** `src/core/conversation.ts`, `src/core/history.ts`, `src/input/commands.ts`, `src/renderer/layout.ts`
- **Effort:** L
- **Dependencies:** None

### 14. Unified multi-file diff view

- **Problem:** `src/panels/diff-panel.ts` and `src/renderer/diff-view.ts` exist for individual diffs, but there's no session-level "what changed" view showing all files modified across all turns.
- **Fix:** Track file modifications across the session (via tool call results for edit/write). Build a session diff aggregator. Add `/session-diff` command and a panel view.
- **Files:** `src/panels/diff-panel.ts`, `src/renderer/diff-view.ts`, `src/state/file-cache.ts`, `src/input/commands.ts`
- **Effort:** M
- **Dependencies:** None

### 15. Cost tracking (tokens to dollars)

- **Problem:** `src/panels/cost-tracker-panel.ts` exists and tracks token usage, but doesn't convert to dollar costs. No pricing data per model.
- **Fix:** Add a pricing table (source from OpenRouter API response which includes pricing). Calculate cumulative session cost. Show cost per turn and session total. The model-limits infrastructure already fetches OpenRouter data which includes `pricing` fields.
- **Files:** `src/panels/cost-tracker-panel.ts`, `src/providers/model-limits.ts`, `src/state/telemetry.ts`
- **Effort:** M
- **Dependencies:** Item 3 (model-limits enhancement)

### 16. Image input flow for multimodal models

- **Problem:** The core orchestrator handles image content parts (stripping them for non-multimodal models), and 2 input files reference image handling. But there's no user-facing flow for pasting/attaching images.
- **Fix:** Support clipboard paste (detect image data in paste buffer), file drag reference (`@image.png`), and screenshot capture. Convert to base64 content parts. Gate behind model capability check.
- **Files:** `src/input/handler.ts`, `src/utils/clipboard.ts`, `src/core/orchestrator.ts`
- **Effort:** M
- **Dependencies:** None

### 17. MCP server auto-discovery

- **Problem:** MCP servers must be manually configured in `mcp.json`. No auto-discovery of locally running MCP servers.
- **Fix:** Scan common MCP server locations (npx-installed servers, project-local `.mcp/` directories, global config). Auto-suggest adding discovered servers. Similar to the local LLM scanner but for MCP.
- **Files:** `src/mcp/config.ts`, `src/mcp/registry.ts`, `src/discovery/scanner.ts` (pattern reuse)
- **Effort:** L
- **Dependencies:** None

### 18. Git integration panel

- **Problem:** `src/panels/git-panel.ts` and `src/renderer/git-status.ts` exist, but `src/git/service.ts` capabilities vs. panel integration is unclear. Need a full git workflow panel: status, stage, diff, commit, branch.
- **Fix:** Ensure the git panel surfaces: working tree status, staged changes, recent commits, branch info, and inline diff preview. Wire to existing `simple-git` dependency. Add `/git` command.
- **Files:** `src/panels/git-panel.ts`, `src/git/service.ts`, `src/renderer/git-status.ts`, `src/input/commands.ts`
- **Effort:** M
- **Dependencies:** None

### 19. Session resumption with full state preservation

- **Problem:** Session save/load exists in `main.ts` (`saveConversation`/`loadLastConversation`), and `src/sessions/manager.ts` handles session management. But agent state, WRFC chains, execution plans, and panel state are not preserved across sessions.
- **Fix:** Serialize agent records, WRFC controller state, active execution plans, and panel configurations into the session file. Restore on resume.
- **Files:** `src/sessions/manager.ts`, `src/agents/orchestrator.ts`, `src/agents/wrfc-controller.ts`, `src/core/execution-plan.ts`, `src/panels/panel-manager.ts`
- **Effort:** L
- **Dependencies:** None

### 20. Documentation

- **Architecture docs:** The codebase has 200+ files across 40+ directories. Only `docs/architecture/dynamic-model-limits.md` and `docs/prompt-caching-design.md` exist. Need: module map, data flow diagrams, provider architecture, tool system, agent lifecycle.
- **API docs:** No JSDoc-generated docs. Key interfaces and public APIs should be documented.
- **Contributor guide:** No CONTRIBUTING.md. Need: setup instructions, testing, code style, PR process.
- **Files:** `docs/architecture/*.md`, `docs/api/*.md`, `CONTRIBUTING.md`
- **Effort:** L
- **Dependencies:** None

---

## v1.0.0 — Production Release

**Theme:** Polish, stability, and confidence.

### 21. Full test coverage audit and gap filling

- **Target:** 80%+ line coverage across all non-renderer source files.
- **Current:** ~948 tests, ~100 test files. Major gaps: panels, ACP, full integration flows.
- **Effort:** XL
- **Dependencies:** All v0.9.x items

### 22. Performance audit

- **Areas:** Startup time (bun compile helps), memory usage during long sessions, token counting efficiency, scanner speed on large subnets.
- **Effort:** M
- **Dependencies:** None

### 23. Security audit

- **Areas:** API key handling (`src/config/secrets.ts`), spawn token validation (`src/security/spawn-tokens.ts`), path traversal in tools, MCP server trust model.
- **Effort:** M
- **Dependencies:** None

### 24. Release infrastructure

- **Fix:** GitHub Releases workflow with: changelog generation, multi-platform binary builds (already have `build:all` script), checksums, auto-publish.
- **Files:** `.github/workflows/release.yml`, `CHANGELOG.md` (automate)
- **Effort:** M
- **Dependencies:** Item 6 (CI/CD)

---

## v1.1.0+ — Post-1.0 Enhancements

**Theme:** Power features and ecosystem.

### 25. Plugin/extension system

- **Problem:** No way for users to add custom tools, panels, or commands without modifying source.
- **Fix:** Define a plugin API with hooks for: custom tools, custom panels, custom commands, event listeners. Load from `~/.goodvibes/plugins/` or project-local `.goodvibes/plugins/`.
- **Files:** New `src/plugins/` module
- **Effort:** XL
- **Dependencies:** Stable public API (1.0)

### 26. Conversation export (Markdown/HTML)

- **Problem:** No way to export a conversation for sharing or archival.
- **Fix:** Export full conversation with code blocks, tool calls, and diffs as Markdown or rendered HTML. Include metadata (model, tokens, duration).
- **Files:** New `src/export/` module, `src/input/commands.ts`
- **Effort:** M
- **Dependencies:** None

### 27. Keyboard shortcut customization

- **Problem:** Keybindings are hardcoded in `src/input/handler.ts`.
- **Fix:** Load keybinding config from `~/.goodvibes/keybindings.json`. Allow rebinding any action. Show current bindings in help overlay.
- **Files:** `src/input/handler.ts`, new `src/config/keybindings.ts`
- **Effort:** M
- **Dependencies:** None

### 28. Clipboard image paste for vision models

- **Problem:** Related to item 16 but specifically clipboard detection on Linux (xclip/wl-clipboard) and macOS (pbpaste).
- **Fix:** Platform-specific clipboard image detection. Integrate with item 16's content part handling.
- **Files:** `src/utils/clipboard.ts`, `src/input/handler.ts`
- **Effort:** S
- **Dependencies:** Item 16

### 29. Prompt caching implementation ✅ DONE (v0.9.10)

- **Problem:** `docs/prompt-caching-design.md` exists as a design doc but implementation status is unclear.
- **Fix:** Implement prompt caching per the design doc — cache system prompts, tool definitions, and repeated context blocks. Reduce token costs on multi-turn conversations.
- **Files:** `src/core/conversation.ts`, `src/providers/*.ts`
- **Effort:** L
- **Dependencies:** Provider-specific cache support

### 30. Multi-model conversations (model switching mid-conversation)

- **Problem:** Currently switching models via the picker resets context or uses the new model for all subsequent turns. No way to use different models for different tasks within a conversation.
- **Fix:** Allow per-turn model selection. Tag messages with which model generated them. Support "ask Claude for review, GPT for implementation" workflows.
- **Files:** `src/core/orchestrator.ts`, `src/core/conversation.ts`, `src/providers/registry.ts`
- **Effort:** L
- **Dependencies:** None

### 31. AnthropicCompatProvider

- **Problem:** `src/providers/custom-loader.ts` has a TODO noting that `AnthropicCompatProvider` is not yet implemented. Custom providers using Anthropic-compatible APIs (like AWS Bedrock direct) can't be loaded.
- **Fix:** Implement `AnthropicCompatProvider` mirroring `OpenAICompatProvider` but for the Anthropic Messages API format.
- **Files:** `src/providers/anthropic.ts` (or new file), `src/providers/custom-loader.ts`
- **Effort:** M
- **Dependencies:** None

---

## Additional Items Identified During Analysis

These were not in the original list but emerged from codebase analysis:

### 32. ACP (Agent Client Protocol) test coverage

- **Problem:** `src/acp/` has 4 files (connection.ts, index.ts, manager.ts, protocol.ts) with zero test coverage. ACP is a critical inter-agent communication layer.
- **Effort:** M

### 33. Hook system edge cases

- **Problem:** The hook system (`src/hooks/`) is extensive (chain-engine, dispatcher, 5 runner types) but only has basic tests. Edge cases like hook timeouts, circular chains, and error propagation in chains need coverage.
- **Effort:** M

### 34. Scheduler robustness

- **Problem:** `src/scheduler/scheduler.ts` handles cron-style scheduling. Currently basic — needs timezone support, missed-run handling, and scheduler state persistence.
- **Effort:** M

### 35. Tree-sitter WASM type safety

- **Problem:** `src/intelligence/tree-sitter/embedded-wasm.ts` has 7 type suppressions — the most in any single file. This is the code intelligence layer.
- **Fix:** Create proper `.d.ts` declarations for the WASM bindings.
- **Effort:** S

---

## v1.1.0+ — Additional Enhancements

### 36. Agent memory across sessions
- **Problem:** Agents start from zero context every time. Past work is lost.
- **Fix:** Persist a summary of each agent's completed work. New agents receive relevant past summaries as context bootstrap.
- **Files:** `src/agents/orchestrator.ts`, new `src/agents/memory.ts`
- **Effort:** L
- **Depends on:** #19 (session state preservation)

### 37. Agent specialization by model
- **Problem:** All agents use the same model regardless of task type.
- **Fix:** Route reviewer tasks to reasoning models (Magistral, QwQ), coding tasks to code models (Codestral, Devstral), research to fast models (Flash, Haiku). Configurable model-per-template mapping.
- **Files:** `src/agents/orchestrator.ts`, `src/tools/agent/index.ts`, `src/config/schema.ts`
- **Effort:** M
- **Depends on:** None

### 38. Agent self-evaluation
- **Problem:** Agents report completion without verifying their work.
- **Fix:** Before reporting done, agents self-check: did tests pass? did the build succeed? are there lint errors? Configurable per template.
- **Files:** `src/agents/orchestrator.ts`
- **Effort:** M
- **Depends on:** None

### 39. Live reload for development
- **Problem:** TUI must be manually restarted after code changes during development.
- **Fix:** `bun --watch` integration in dev mode. Auto-restart on source file changes.
- **Files:** `package.json`, new `scripts/dev-watch.ts`
- **Effort:** S
- **Depends on:** None

### 40. Debug panel
- **Problem:** No visibility into API requests/responses, per-call token counts, latency.
- **Fix:** New panel showing real-time API call log with method, model, tokens, latency, status code. Toggle via `/debug` or keyboard shortcut.
- **Files:** new `src/panels/debug-panel.ts`, `src/panels/builtin-panels.ts`
- **Effort:** M
- **Depends on:** None

### 41. Command history search (Ctrl+R)
- **Problem:** No way to search through previous slash commands and prompts.
- **Fix:** Ctrl+R opens reverse search through input history. Matches as you type.
- **Files:** `src/input/handler.ts`, `src/input/history.ts`
- **Effort:** M
- **Depends on:** None

### 42. Undo/redo for file operations
- **Problem:** Individual tool operations (write, edit) can't be undone except via git.
- **Fix:** Track file state before each write/edit tool call. `/undo` reverts the last file operation. `/redo` re-applies.
- **Files:** `src/tools/shared/`, new `src/state/file-undo.ts`
- **Effort:** L
- **Depends on:** None

### 43. Automatic context compaction
- **Problem:** When approaching context window limit, the model may crash or truncate.
- **Fix:** Monitor context usage per turn. When above 80% threshold, auto-compact older messages (summarize, remove tool results, keep key decisions). Already partially wired via `autoCompactThreshold` config.
- **Files:** `src/core/orchestrator.ts`, `src/core/conversation.ts`
- **Effort:** M
- **Depends on:** #10 (model-limits inform compaction)

### 44. Graceful degradation on provider failure
- **Problem:** If the selected provider is down, the user gets a raw error.
- **Fix:** On provider failure (network error, 500, 503), offer to switch to another provider with the same model or a comparable model. Integrate with synthetic provider for automatic failover.
- **Files:** `src/core/orchestrator.ts`, `src/providers/synthetic.ts`
- **Effort:** M
- **Depends on:** #9 (provider health dashboard)

### 45. Session crash recovery
- **Problem:** If the TUI crashes mid-session, conversation state is lost.
- **Fix:** Periodic auto-save of conversation state to disk. On startup, detect incomplete sessions and offer to resume.
- **Files:** `src/core/orchestrator.ts`, `src/main.ts`
- **Effort:** M
- **Depends on:** #19 (session state preservation)

### 46. Shareable session export
- **Problem:** No way to share a session with someone else.
- **Fix:** `/export html` generates a self-contained HTML file with the full conversation, code blocks, diffs, and tool results rendered. Browsable offline.
- **Files:** new `src/export/html.ts`, `src/input/commands.ts`
- **Effort:** L
- **Depends on:** #26 (conversation export)

### 47. Team provider pools
- **Problem:** No shared API key management across a team.
- **Fix:** Shared provider config with per-user usage quotas. Central key store with rotation support.
- **Files:** new `src/config/team.ts`, `src/providers/registry.ts`
- **Effort:** XL
- **Depends on:** None

### 48. Webhook notifications
- **Problem:** No way to be notified when long-running agent tasks complete.
- **Fix:** `/notify` command configures webhook URLs (Slack, Discord, ntfy). Fires on agent completion, WRFC chain pass/fail, session end.
- **Files:** new `src/integrations/webhooks.ts`, `src/input/commands.ts`
- **Effort:** M
- **Depends on:** None

### 49. AST-aware editing
- **Problem:** File edits use string find/replace which can match wrong locations.
- **Fix:** Edit tool accepts AST node targets (function name, class name, import). Uses tree-sitter to locate the exact node, then replaces its content.
- **Files:** `src/tools/edit/`, `src/intelligence/tree-sitter/`
- **Effort:** L
- **Depends on:** #35 (tree-sitter type safety)

### 50. Semantic diff
- **Problem:** Diffs show textual changes, not functional changes.
- **Fix:** After edits, show what changed functionally: new functions added, signatures changed, imports modified. Uses AST comparison.
- **Files:** new `src/renderer/semantic-diff.ts`, `src/intelligence/tree-sitter/`
- **Effort:** L
- **Depends on:** #49 (AST-aware editing)

### 51. Dependency-aware task ordering
- **Problem:** When an agent edits a module, its dependents aren't automatically re-checked.
- **Fix:** After file edits, trace import graph to find affected files. Queue typecheck/lint on dependents. Surface broken imports immediately.
- **Files:** `src/intelligence/`, `src/agents/orchestrator.ts`
- **Effort:** L
- **Depends on:** None

---

## Priority Matrix

| Priority | Items | Theme |
|----------|-------|-------|
| P0 (Ship-blocking) | 1, 5, 6 | Agent streaming, TS cleanup, CI |
| P1 (Should have for 1.0) | 2, 3, 4, 7, 10, 12, 43 | Version sync, limits, tests, picker, errors, compaction |
| P2 (Nice for 1.0) | 8, 9, 11, 13, 14, 15, 37, 44 | Synthetic, health, progress, branching, diffs, costs, model routing, failover |
| P3 (Post-1.0) | 16-31, 36, 38-42, 45-51 | Full feature set, agent intelligence, collaboration, AST |
| P4 (Ongoing) | 20, 21, 22, 23 | Docs, coverage, perf, security |
| Done | 29 | Prompt caching (Anthropic, Gemini, OpenAI) |

## Effort Summary

| Size | Count | Estimated dev-days each |
|------|-------|------------------------|
| S | 5 | 0.5-1 day |
| M | 28 | 2-4 days |
| L | 12 | 5-8 days |
| XL | 3 | 10+ days |

**Total estimated effort to 1.0:** ~60-80 dev-days
**Total estimated effort to 1.1:** ~130-170 dev-days
**Total items:** 51 (1 done, 50 remaining)
