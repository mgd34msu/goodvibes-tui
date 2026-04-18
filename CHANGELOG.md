# Changelog

All notable changes to GoodVibes TUI.

---

## [0.19.0] — 2026-04-18

### Changed
- Upgraded `@pellux/goodvibes-sdk` from 0.19.6 to 0.21.1 (soak-period release).
  TUI adaptations required:
  1. `docs/foundation-artifacts/operator-contract.json` — regenerated to match
     updated `buildOperatorContract()` output (`peer-contract.json`, knowledge
     artifacts unchanged).
  2. `scripts/perf-check.ts` — `platform/runtime/perf/index` barrel removed;
     `createPerfMonitor()` factory removed; migrated to `new PerfMonitor()` with
     imports split to `perf/monitor` and `perf/reporter` sub-paths.
  3. `scripts/eval-gate.ts` — `platform/runtime/eval/index` barrel removed;
     imports split to `eval/baseline`, `eval/format`, and `eval/scorecard`.

### Added
- Wave B panel migration: migrated 5 panels (knowledge, marketplace, memory,
  system-messages, orchestration) to `ScrollableListPanel<T>`/`SearchableListPanel<T>`
  generics; added `docs/panel-authoring.md` as the canonical panel authoring guide.
- Wave C-α reliability pass: F-perf-01 (trackedRender on 5 hot panels),
  F-perf-02 (async panel fs + skills-panel de-blocking), F-perf-03 (timer registry
  + 5-panel zombie-timer leak prevention), F-errors-02 (observable async failures —
  no silent `.catch(() => {})`), F-sec-02 (ANSI escape sanitization at
  tool-call untrusted-content entry points).
- `src/input/settings-modal-types.ts`: extracted `SettingsCategory`,
  `SETTINGS_CATEGORIES`, `SettingEntry`, `FlagEntry`, `McpEntry`,
  `SubscriptionEntry` type definitions out of the settings-modal module.

### Security
- Postinstall patcher from `@pellux/goodvibes-sdk@0.21.1` mitigates three
  minimatch ReDoS advisories in the consumer install tree.
- Added `overrides: { minimatch: ^10.2.5 }` to TUI's own `package.json`
  so `npm audit` reports clean for the TUI install tree independently.

### Fixed
- Foundation artifacts gate now passes: `operator-contract.json` updated to
  match SDK 0.21.1 `buildOperatorContract()` canonical output.

---

## [0.18.23] — 2026-04-16

### Wave 4α+β performance bundle + α review follow-ups + regression fixes

Bundles Wave 4α (conversation-rendering double-parse elimination) and Wave 4β
(feed-context object reuse) into a single release, adds documentation and test
follow-ups from the 4α review, and fixes two regressions surfaced during that
review.

### Performance (Wave 4α — conversation-rendering)

- **`src/core/conversation-rendering.ts`** — eliminates the legacy `renderMarkdown()`
  duplicate call used for `'code'` mode line counting. The 'all' mode retain its
  intentional measurement pass (see inline comment for rationale); the 'code' mode
  now derives its gutter width from the single `renderMarkdownTracked()` call.

### Performance (Wave 4β — feed-context object reuse)

- **`src/input/handler.ts`** — `InputHandler` now allocates a single `InputFeedContext`
  at startup (`initFeedContext()`) and mutates only the 14 mutable fields before
  each `feedInputTokens()` call via `syncFeedContextMutableFields()`. Stable service
  handles, closures, and callbacks are wired once and never re-assigned. Eliminates
  per-keystroke allocations on the hot input path.
- **`src/input/feed-context-factory.ts`** (new) — extracts `buildInitialFeedContext()`
  and the `FeedContextMutableInit` / `FeedContextStableRefs` / `FeedContextClosures`
  interfaces out of `handler.ts` to keep `handler.ts` under the 800-line architecture
  cap.

### Regression fixes

- **R1 — `handler.ts` architecture cap** — `handler.ts` was 830 lines after Wave 4β.
  Extracted factory functions into `src/input/feed-context-factory.ts`; `handler.ts`
  is now exactly 800 lines. `bun run architecture:check` passes.
- **R2 — `SearchableListPanel.buildFilterInputLine` cursor glyph** — the focused
  filter line (`[Label] query_`) was rendering the trailing `_` as the block cursor
  glyph `█` because `buildSearchInputLine` substitutes `_` → `█` when `active:true`.
  Fixed by passing `active:false` with explicit `inputBg`/`info` colors; the
  `[Label] ` bracket format provides the focused visual affordance without triggering
  the substitution. Fixes the pre-existing test failure from 0.18.22.

### Quality bumps (Wave 4α review follow-ups)

- **F1** — `src/test/input/feed-context-reuse.test.ts`: added mutable-field assertion
  verifying `ctx.prompt` and `ctx.cursorPos` update between feeds (feeds 'a' → 'b',
  asserts accumulated mutation).
- **F2** — `src/test/input/keybinding-lookup.test.ts`: replaced no-op reload test
  with a real temp-file config override (remaps `search` → Ctrl+G, verifies Ctrl+F
  returns null); added a second test for conflicting bindings (two actions mapped to
  same combo resolves to one of them, not null).
- **F3** — `src/input/handler-feed.ts`: added JSDoc to `InputFeedContext` interface
  documenting all mutable-per-feed fields vs. stable service handles and explaining
  the reuse rationale.
- **F4** — `src/input/feed-context-factory.ts`: `syncFeedContextMutableFields()` has
  full JSDoc listing every synced field and documenting intentional exclusions.
- **F5** — `src/core/conversation-rendering.ts`: added inline comment block explaining
  why 'all' mode requires a double-call to `renderMarkdownTracked` (Option B) and
  why single-pass is not feasible.

---

## [0.18.22] — 2026-04-16

### Wave 3b / Tier 2 TUI UX Consistency — Panel Migration Batch

Migrates 7 more BasePanel-direct panels to `ScrollableListPanel<T>`, restores
section-title text lost during prior migrations, and fixes 8 pre-existing test regressions.

### Migrated panels

- **`src/panels/hooks-panel.ts`** — `HooksPanel` → `ScrollableListPanel<HookEntry>`.
  Contracts/chains/managed/file stats in `header`; selected hook detail, activity (with `Recent Activity` label), authoring (with `Authoring` label) in `footer`. Empty state shows extra context via `header` parameter.
- **`src/panels/mcp-panel.ts`** — `McpPanel` → `ScrollableListPanel<McpServerSecurityEntry>`.
  Derived type via `ReturnType<McpRegistry['listServerSecurity']>[number]` since no named export exists.
  `MCP posture` label + stats + guidance in `header`; selected server detail, repair actions, decision log in `footer`.
- **`src/panels/approval-panel.ts`** — `ApprovalPanel` → `ScrollableListPanel<ApprovalRow>`.
  `Approval posture` label + approval counts + guidance + `Selected Lane` label + detail in `header`; nav hint in `footer`.
- **`src/panels/security-panel.ts`** — `SecurityPanel` → `ScrollableListPanel<TokenAuditResult>`.
  Governance + threat lines in `header`; selected detail + attack path findings in `footer`.
- **`src/panels/services-panel.ts`** — `ServicesPanel` → `ScrollableListPanel<ServicePanelEntry>`.
  `r` (refresh) and `t` (test selected) key overrides preserved; loading state handled via early return.
- **`src/panels/subscription-panel.ts`** — `SubscriptionPanel` → `ScrollableListPanel<SubscriptionRow>`.
  Fully overrides `handleInput` (uses `ArrowUp`/`ArrowDown`); logout confirm state preserved; empty state uses direct `buildPanelWorkspace` path.
- **`src/panels/tasks-panel.ts`** — `TasksPanel` → `ScrollableListPanel<RuntimeTask>`.
  `!readModel` early-exit preserved; `buildSummaryBlock` in `header`, `buildDetailBlock` in `footer`.
- **`src/panels/incident-review-panel.ts`** — `IncidentReviewPanel` → `ScrollableListPanel<FailureReport>`.
  `Action Rail` label added before action guidance lines in `footer`.
- **`src/panels/communication-panel.ts`** — `CommunicationPanel` → `ScrollableListPanel<CommunicationRecord>`.
  `Communication posture` label added to both posture line arrays (empty + populated states).

### Panels kept as BasePanel

- `PolicyPanel`, `RemotePanel`, `ProviderHealthPanel`, `PanelListPanel`, `OrchestrationPanel`,
  `MarketplacePanel`, `SchedulePanel`, `MemoryPanel`, `KnowledgePanel`, `SkillsPanel`,
  `SessionBrowserPanel` — all use `resolveScrollablePanelSection`, multi-line-per-item render,
  dual-mode browsing, `setInterval`, or `canRenderNow()` / `reportRenderDuration()` patterns
  incompatible with `ScrollableListPanel<T>`.

### Test fixes

Restored section-title strings (`'Approval posture'`, `'Communication posture'`, `'MCP posture'`,
`'Action Rail'`, `'Recent Activity'`, `'Selected Lane'`) dropped during migration, fixing 8
regressions across `approval-panel`, `communication-panel`, `hooks-panel`, `mcp-panel`, and
`incident-review-panel` test files.

---

## [0.18.21] — 2026-04-16

### Wave 3a / Tier 2 TUI UX Consistency Infrastructure — I5

Final item from Wave 3a: selection gutter and filter input UX consistency across list panels.

### I5 — Selection gutter + filter input label conventions

- **`src/panels/scrollable-list-panel.ts`** — `ScrollableListPanel`: added opt-in `protected showSelectionGutter = false`. When enabled, `renderList()` post-processes each item line to prepend a 2-column left gutter: `▸ ` (info color, bold) for the selected row, `  ` for all others. Line width is preserved by dropping the last 2 cells. Default off to avoid breaking panels with custom selection indicators.
- **`src/panels/scrollable-list-panel.ts`** — `SearchableListPanel`: added `protected buildFilterInputLine(width, label, focused)`. Renders the filter line with context-sensitive label formatting: `[Filter] query_` when `focused=true` (active, bold, cursor visible), `Filter: query` when `focused=false` (dim, no cursor). Delegates to `buildSearchInputLine` from `polish.ts`.
- **New test file `src/test/panels/scrollable-list-panel-i5.test.ts`**: 13 tests covering gutter on/off, column position of `▸`, line-width preservation, and filter label format in both focused/unfocused states.

---

## [0.18.20] — 2026-04-16

### Wave 3a / Tier 2 TUI UX Consistency Infrastructure

Six infrastructure items that make the TUI behave consistently across all panels.

### I1 — Reusable inline confirm dialog

- **New file `src/panels/confirm-state.ts`**: exports `ConfirmState<T>`, `handleConfirmInput<T>`, and `renderConfirmLines<T>`. Identical y/n UX across all panels: y confirms, n/Esc cancels, any other key is absorbed while confirm is active.
- **SkillsPanel**: 'd' key now shows an inline `Confirmation` section before surfacing the shell delete hint. Pressing Esc on the confirm panel cancels it via the generic helper.
- **KnowledgePanel**: 's' (stale) and 'c' (contradicted) now prompt confirm before calling `registry.review()`. Error from review mutation is surfaced via I2 `setError()`.
- **SubscriptionPanel**: 'n' and Escape now cancel a pending logout confirmation via the confirm helper.

### I2 — Error surface slot on BasePanel

- **`src/panels/base-panel.ts`**: added `protected lastError`, `setError()`, `clearError()`, `renderErrorLine(width)`. Auto-clear on next keypress in `ScrollableListPanel.handleInput()`.
- **`src/panels/scrollable-list-panel.ts`**: `renderList()` prepends the error line to the `effectiveFooter` — visible in both normal and empty states.
- **MarketplacePanel**: `refresh()` now wraps catalog load in try/catch and calls `setError()` on failure. Clears error on successful reload.
- **KnowledgePanel**: `registry.review()` call in confirm dispatch wrapped in try/catch, wired to `setError()`.

### I3 — Loading spinner slot on BasePanel

- **`src/panels/base-panel.ts`**: added `loadingState: 'idle'|'loading'|'error'`, `startLoading(label?)`, `stopLoading()`, `renderLoadingLine(width, frame)`. Uses `SPINNER_FRAMES` from `src/renderer/progress.ts`.
- **`src/panels/scrollable-list-panel.ts`**: `renderList()` short-circuits to a spinner-only view when `loadingState === 'loading'`.
- **GitPanel**: `openDiff()` now calls `startLoading('Loading diff...')` before the await and `stopLoading()` in both success and error paths. The `render()` method checks `this.loadingState === 'loading'` to show the spinner while the diff is being fetched.

### I4 — Accessible status tokens

- **New file `src/renderer/status-token.ts`**: exports `buildStatusToken(state, label, opts?)` → `Cell[]`. State map: `good=✓`, `warn=⚠`, `bad=✕`, `info=○`. Glyph + color together so colorblind users can distinguish states without relying on color alone.
- **ApprovalPanel**: recent approvals/denials/pending row now uses inline `✓ approvals (N)  ✕ denials (N)  ○ pending (N)` cells instead of bare color-only counts.

### I6 — Two-stage Escape in panel focus

- **`src/input/handler-feed-routes.ts`**: `handlePanelFocusToken()` now passes `'escape'` to the active panel's `handleInput()` BEFORE deciding to unfocus. If the panel returns `true` (e.g. dismisses a confirm dialog or clears a search), the panel stays focused. Only if the panel returns `false` does the router set `panelFocused = false`.

### Tests

- **`src/test/renderer/status-token.test.ts`** (8 tests): glyph/color/count/override coverage for `buildStatusToken`.
- **`src/test/panels/base-panel-ux.test.ts`** (16 tests): `setError`/`clearError`/`renderErrorLine` and `startLoading`/`stopLoading`/`renderLoadingLine` state transitions.
- **`src/test/panels/confirm-state.test.ts`** (13 tests): `handleConfirmInput` all four return values + `renderConfirmLines` width/content.
- **`src/test/panels/knowledge-panel.test.ts`**: updated to reflect I1 two-step confirm for `'s'` (stale) action.

### Tests & Checks

- Test suite: 441/441 passing (3 new test files)
- Architecture check: passing (298 non-test source files)
- Typecheck: clean

---

## [0.18.19] — 2026-04-16

### Quality bump — address sub-10 dimensions from 0.18.18 review

The 0.18.18 review scored 9.76/10 with three dimensions below 10 (Error Handling 9.5, Testing 9.0, Maintainability 9.5). This release lifts each back to 10 per the now-10.0 WRFC score threshold.

### Error Handling

- **Render coalescer wraps both paths in try/catch** (`src/runtime/bootstrap-core.ts`): the `setImmediate` callback and the throttled `setTimeout` callback each now guard `renderRequestRef.value()` with try/catch. A thrown render exception no longer wedges the scheduler — `renderScheduled` is cleared unconditionally, the error is logged at error level, and the next `requestRender()` can still schedule. Previously a single render exception could leave `renderScheduled = true` (if thrown inside the callback) and deadlock the TUI until restart

### Testing

- **Added R1 16ms throttle-branch test** (`src/test/renderer/render-perf.test.ts`): exercises the `setTimeout` gated branch that fires when two bursts land within the 16ms window. Uses a monotonic clock to make timing deterministic. The previous test suite only covered the `setImmediate` immediate branch
- **Added R3 Compositor buffer-identity test** (`src/test/renderer/render-perf.test.ts`): drives the `Compositor` through 10 frames with identical dimensions and asserts the set of observed `frontBuffer`/`backBuffer` instances has cardinality exactly 2. Filters nulls so the brief post-swap null doesn't inflate the count. Proves the "2 TerminalBuffer instances per session" R3 claim that the 0.18.18 review flagged as claimed-but-untested

### Maintainability

- **Documented mid-render invalidation hazard** (`src/renderer/panel-composite.ts`): added a JSDoc block above the `renderPanel` cache explaining the race where an event listener firing during a panel's `render()` that sets `needsRender = true` would be clobbered by the trailing `markRendered()`. Includes a deferred-fix proposal (snapshot `needsRender` before calling `render()`) and documents why the current simpler implementation is acceptable

### Tests & Checks

- Test suite: 438/438 passing (11/11 in the expanded render-perf suite)
- Architecture check: passing
- Typecheck: clean

---

## [0.18.18] — 2026-04-16

### Performance

- **R1 — Render coalescing** (`src/runtime/bootstrap-core.ts`): `requestRender()` is now wrapped in a `setImmediate`-based coalescer. A burst of N synchronous `requestRender()` calls in a single microtask produces exactly one render pass. A 16ms minimum-interval gate is applied to cap rendering at ~60fps during streaming (prevents hundreds of full pipeline runs per second on LLM token bursts).
- **R2 — Panel dirty-flag activation** (`src/renderer/panel-composite.ts`, `src/panels/base-panel.ts`, `src/panels/types.ts`): The existing `needsRender` field is now enforced. Added `invalidate(): void` and `markRendered(): void` to the `Panel` interface and `BasePanel`. `buildPanelCompositeData` routes all panel renders through a new `renderPanel()` helper backed by a per-panel `WeakMap` cache — panels that have not changed and whose dimensions are unchanged are skipped entirely. `ScrollableListPanel` and all 40+ panels that write `needsRender = true` on state mutation are compatible without changes (the contract was already partially in place; this activates it).
- **R3 — Buffer reuse** (`src/renderer/buffer.ts`, `src/renderer/compositor.ts`): `TerminalBuffer` gains a `reset(width, height): void` method that overwrites cells in-place instead of reallocating. `Compositor` now holds two long-lived `TerminalBuffer` instances (front/back). Each `composite()` call resets the back buffer, composites into it, diffs against the front buffer (the last-rendered frame), writes the diff, then swaps front/back. The `clone()` call that doubled allocation cost every frame is eliminated. `TerminalBuffer` constructor is called twice per session (once per buffer), not once per frame.

### Tests

- Added `src/test/renderer/render-perf.test.ts` with 10 new tests covering R1 coalescing logic, R2 dirty-flag skip/invalidate/markRendered contract, and R3 `TerminalBuffer.reset()` behavior.
- Extended `src/test/renderer/compositor.test.ts` with 3 new tests covering R3 double-buffer reuse correctness (buffer identity after swap, resetDiff clearing both buffers, resize handling).
- Updated mock `Panel` objects in `src/test/renderer/panel-navigation.test.ts`, `src/test/panels/panel-manager.test.ts`, `src/test/panels/panel-list-panel.test.ts`, and `src/test/daemon/server.test.ts` to implement the new `invalidate()`/`markRendered()` interface methods.
- Test suite: 438/438 passing, typecheck clean, architecture check green.

---

## [0.18.17] — 2026-04-16

### Bug Fixes

- **Companion pairing token registered with embedded daemon**: `src/runtime/bootstrap.ts` now loads the persistent companion-pairing token via `getOrCreateCompanionToken('tui')` and passes it as `sharedDaemonToken` to `startExternalServices`. The TUI's QR panel advertises this token as the bearer for phone pairing; before this fix, the embedded daemon was started with no shared token and rejected every scanned token with `authenticated: false, authMode: "invalid"`
- **QR code visual alignment**: `src/renderer/qr-renderer.ts` now uses `leftPad = 1` (down from 2) and prepends a single top quiet-band row. The QR's finder patterns now register symmetrically on both axes; previous rendering was mis-aligned by one cell horizontally and had no top quiet band

### Dependencies

- Bumped `@pellux/goodvibes-sdk` 0.18.36 → 0.18.37, picking up: `sharedDaemonToken`/`sharedHttpListenerToken` factory options on `startHostServices`, bootstrap credential drift detection that warns when `auth-bootstrap.txt` falls out of sync with `auth-users.json`
- Regenerated `docs/foundation-artifacts/*` against SDK 0.18.37

### Tests

- Updated `src/test/runtime/bootstrap-services.test.ts` `daemonEnable`/`listenerEnable` expectations to include the new second argument (`undefined` when no shared token is supplied)
- Test suite: 437/437 passing, typecheck clean, architecture check green

---

## [0.18.16] — 2026-04-16

### Bug Fixes

- **resolveToolLLM tests**: enabled `tools.llmEnabled` by default in `createTestManagers()` (`src/test/helpers/test-managers.ts`) so tool LLM resolution tests exercise the resolution logic directly; previously every test hit the gate and resolved to `null`
- **Domain boundary contract test (GC-ARCH-001)**: removed `'conversation'` and `'permissions'` from the `DOMAINS` array in `src/runtime/store/domains/domain-read-matrix.ts` — the files they referenced were deleted in 0.18.15 and the filesystem↔array consistency check was failing

### Architecture

- **settings-modal decomposition**: extracted 10 pure helpers (`formatValue`, `valueColor`, `flagStateColor`, `mcpTrustColor`, `subscriptionStateColor`, `inferSubscriptionRouteReason`, `CATEGORY_LABELS`, `SETTING_LABELS`, `getSettingLabel`, `describeUiRouting`) into `src/renderer/settings-modal-helpers.ts`. `settings-modal.ts` drops from 844 → 737 lines, back under the 800-line architecture cap

### Dependencies

- Bumped `@pellux/goodvibes-sdk` 0.18.33 → 0.18.36, picking up: daemon shutdown symmetry, event bus iteration fix, atomic session writes, rate limiter TTL + LRU + sweep, `fetchWithTimeout` helper, restored port honoring in `resolveHostBinding` for `local`/`network` hostModes, and restored constructor-injected port/host in `resolveDaemonFacadeRuntime`
- Regenerated `docs/foundation-artifacts/*` against the new SDK

### Tests & Checks

- Test suite: 437/437 passing (was 431/437 after 0.18.15)
- Architecture check: passing (was failing with `settings-modal.ts` 844 > 800-line cap)
- Typecheck: clean

---

## [0.18.15] — 2026-04-16

### Correctness Fix

- **daemon SIGINT/SIGTERM drain**: `src/daemon/cli.ts` — added AbortController signaling for in-flight requests, 15-second `Promise.race` shutdown deadline, hard `process.exit(1)` if deadline exceeded, debounced double-signal guard (`shutdownInFlight` flag)

### Dead Code Removal (Tier 3 items 15-17)

- Deleted 15 TUI mirror files with zero external importers:
  - `src/runtime/diagnostics/index.ts`, `provider.ts`, `actions.ts`
  - `src/runtime/diagnostics/panels/agents.ts`, `events.ts`, `health.ts`, `tasks.ts`, `tool-calls.ts`
  - `src/runtime/store/helpers/reducers.ts` (barrel) and 4 sub-reducers
  - `src/runtime/store/domains/permissions.ts`, `conversation.ts`
- Updated `src/runtime/diagnostics/panels/index.ts` to re-export deleted panels from SDK

### Config Re-export Shim Inlining (Tier 3 item 18)

- Deleted `src/config/service-registry.ts` and `src/config/subscription-providers.ts` (1-line SDK re-exports)
- Updated 29 call sites to import directly from `@pellux/goodvibes-sdk/platform/config/*`

### SDK Consolidation — UI Read Models (Tier 3 items 19-20)

- Converted 9 TUI mirror files to 1-line SDK re-exports (preserving all call-site import paths):
  - `ui-events.ts`, `ui-service-queries.ts`, `ui-read-model-helpers.ts`
  - `ui-read-models-observability.ts` and 4 observability sub-files (maintenance, options, remote, security, system)
- Skipped (TUI-specific divergence): `ui-services.ts` (uses TUI `SecretsManager` subclass), `ui-read-models.ts` (depends on TUI `RuntimeServices`)
- panel-resources drift: TUI version (119 lines) uses `panel-health-monitor.ts`; SDK version (152 lines) uses `component-health-monitor.js` — different monitor interfaces, TUI-specific binding kept

---

## [0.18.14] — 2026-04-16

### Panel Navigation Overhaul

- Created `ScrollableListPanel<T>` and `SearchableListPanel<T>` base classes in `src/panels/scrollable-list-panel.ts`
- Migrated 30 panels from hand-coded scroll/cursor management to the shared base classes
- All list panels now have consistent navigation: up/down/j/k, pageup/pagedown, home/end/g/G, enter to select
- Selection is always visible within the viewport — guaranteed by `getVisibleWindow()` from `surface-layout.ts`
- Removed ~150 lines of duplicated scroll boilerplate across panels

### Modal Viewport Fixes

- Fixed modal sizing: height is exactly 45% of viewport (both min and max — all modals same size), width is 50% with 25% minimum
- Fixed modal scroll/selection: 6 modal/overlay files updated to use shared `getVisibleWindow()` instead of inline scroll math
- Autocomplete overlay, file picker, bookmark modal, session picker, profile picker, and live tail modal all use the same viewport function

### Settings Modal: Tools Tab

- Added proper tools tab UI with "Tool LLM" and "Helper Model" section headers
- Helper config keys (`helper.enabled`, `helper.globalProvider`, `helper.globalModel`) now routed into the tools tab
- Boolean settings display as [on]/[off] toggles
- Selecting a provider/model setting opens the full model picker instead of a text field
- Model picker now supports 3 target modes: main, helper, and tool
- Selecting a helper/tool model auto-enables the feature (`helper.enabled: true` / `tools.llmEnabled: true`)

### QR Code Pairing for Companion Apps

- Added `/qrcode` command (aliases `/qr`, `/pair`) that opens a QR code panel
- QR panel displays connection info (daemon URL, token, username) + scannable QR code
- QR rendered using Unicode half-block characters (▀/▄/█) for compact terminal display
- Supports `r` to regenerate token (invalidates old one) and `c` to copy token to clipboard
- Daemon standalone mode (`goodvibes-daemon`) now prints QR + connection info to stdout on startup
- Companion tokens persist to `.goodvibes/tui/companion-token.json` with `gv_` prefix
- Built on SDK 0.18.30 pairing module

### Health Monitoring Rename

- Renamed `panelHealthMonitor` to `componentHealthMonitor` across 20 files to align with SDK 0.18.29's generic naming
- Deprecated `Panel*` type aliases preserved for backward compatibility

### SDK 0.18.30 Update

- Updated to `@pellux/goodvibes-sdk@0.18.30`
- Consumes new pairing module, `tools.llmEnabled` config, and all 0.18.29 boundary cleanup

### Verification

- Full typecheck passes: `bun x tsc --noEmit` — 0 errors

## [0.18.13] — 2026-04-16

### SDK/TUI Boundary Separation

Major cleanup of the SDK/TUI boundary. The TUI is now a thin rendering/input/wiring layer built on `@pellux/goodvibes-sdk@0.18.29`. Thousands of lines of duplicated, forked, and dead code have been removed and replaced with SDK imports.

#### Dead Code Removed

- Deleted 4 dead daemon files that nothing imported (`facade.ts`, `facade-composition.ts`, `surface-policy.ts`, `types.ts`) — 1,291 lines removed
- Deleted 2 dead UI read-model files (`ui-read-models-core.ts`, `ui-read-models-operations.ts`) — the barrel already delegates to SDK

#### Forks Replaced with SDK Imports

- Replaced `src/core/orchestrator.ts` (736 lines) with a 3-line re-export from SDK — the SDK's Orchestrator already includes `getSpinner()`
- Replaced `src/plugins/loader.ts` (305 lines) with re-exports from SDK — the SDK now supports `additionalDirectories` and `entryDefault` options
- Replaced `src/tools/index.ts` (187 lines) with re-export of SDK's `registerAllTools`
- Replaced `src/config/subscription-providers.ts` (128 lines) with `export *` from SDK
- Replaced `src/config/index.ts` API key functions with re-exports from SDK's new `config/api-keys.ts`
- Replaced `src/permissions/prompt.ts` type definitions with imports from SDK — kept `PermissionPromptUI` class (TUI-specific rendering)
- Replaced 4 store/runtime duplicate files with SDK re-exports (conversation domain, permissions domain, conversation reducers, lifecycle reducers)

#### ConversationManager Refactored

- Refactored `src/core/conversation.ts` from a 776-line standalone class to a ~450-line subclass extending SDK's `ConversationManager`
- Removed all duplicated message management methods (CRUD, branching, persistence, compaction, undo/redo) — now inherited from SDK
- Defined `TuiBlockMeta extends BlockMeta` with rendering fields (`blockIndex`, `startLine`, `lineCount`, `collapseKey`)
- Kept all TUI-specific rendering methods (history buffer, block registry, collapse state, display navigation)

#### Health Monitoring Renamed

- Renamed `panelHealthMonitor` to `componentHealthMonitor` throughout the TUI to align with SDK 0.18.29's generic naming
- Updated 20 files across runtime, panels, diagnostics, bootstrap, and tests
- Added deprecated `Panel*` type aliases for backward compatibility

#### RuntimeState Aligned with SDK

- Updated `store/state.ts` to use SDK's `surfacePerf: SurfacePerfDomainState` instead of `uiPerf: UiPerfDomainState`
- Updated `store/selectors/index.ts` to match SDK's selector shape
- Health monitoring perf files rewritten as SDK re-export shims

#### Clipboard Split

- Created `src/utils/clipboard.ts` with TUI-specific OSC 52 `copyToClipboard` function
- Platform clipboard paste functions remain in SDK

### Verification

- Full typecheck passes: `bun x tsc --noEmit` — 0 errors
- Updated to `@pellux/goodvibes-sdk@0.18.29`

## [0.18.12] — 2026-04-15

### SDK `0.18.28` Session-Persistence Boundary Fix

- Updated `goodvibes-tui` to consume the published canonical SDK line at `@pellux/goodvibes-sdk@0.18.28`
- Pulled in the SDK fix that threads `surfaceRoot` through the last-session pointer and crash-recovery helpers instead of silently falling back to the shared `.goodvibes/...` tree
- This closes the remaining TUI session-storage boundary leak that could still split a TUI-owned session across `.goodvibes/tui/...` and the unscoped shared root even after the broader SDK cutover

### TUI Validation Tail Cleanup

- Moved the remaining session, template, picker, plugin, bootstrap-service, and related test temp roots onto the repo-local `.test-tmp/...` path instead of `os.tmpdir()`, removing the local quota failures that were still breaking the TUI validation pass
- Updated the shell-control cutover gate to assert against the current TUI production surfaces and the intentional removal of old local platform files instead of reading deleted pre-cutover paths
- Removed the stale typed-emission allowlist entry for `src/runtime/health/effect-handlers.ts` after that file was deleted during the SDK cutover, so the enforcement gate now reflects the live tree again

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Full test runner passes: `bun run test` (`437` files passed / `0` failed)
- Architecture gate passes: `bun run architecture:check`
- Build passes: `bun run build`
- Targeted cutover regression band passes against the published SDK `0.18.28`

## [0.18.11] — 2026-04-15

### Version Boundary Cleanup

- Fixed the TUI foundation artifact export path so `docs/foundation-artifacts/operator-contract.json` is now built through the TUI contract wrapper instead of the raw SDK builder
- That keeps the checked-in operator artifact on the TUI product version instead of leaking the SDK package version into TUI-owned release artifacts
- Updated the release gate to enforce the same boundary, so future foundation artifact checks compare against the TUI contract surface instead of silently accepting SDK-version drift
- Moved the TUI version-surface sync and foundation-artifact generation behind a shared workspace lock so `prebuild`, artifact export, and package staging cannot race each other over release-owned files
- Made `publish:package` resync those surfaces before staging, so tarballs are built from the current TUI product version and current foundation artifacts instead of whatever happened to be on disk first
- Updated the release build job to run the same surface sync before compiling binaries, so fresh CI checkouts cannot embed stale contract/version files into release assets

### SDK `0.18.26` Update

- Updated `goodvibes-tui` to consume `@pellux/goodvibes-sdk@0.18.26`
- Pulled in the SDK fix that syncs the baked runtime version fallback from the package version and adds a workspace lock around build and staging so concurrent validate/release flows stop racing over `dist`
- This removes the stale embedded `0.18.14` SDK fallback string from rebuilt downstream binaries and closes the recurring pack/release race that was still showing up during SDK release validation
- Rebuilt the TUI against that SDK patch and confirmed the startup header now shows `v0.18.11` while the stale `0.18.14` leak is gone from the compiled binary

### Verification

- Foundation artifacts export passes: `bun run foundation:artifacts`
- Foundation artifact release gate passes
- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Full test runner passes: `bun run test`
- Architecture gate passes: `bun run architecture:check`
- Performance gate passes: `bun run perf:check`
- Eval gate passes: `bun run eval:gate`
- Build passes: `bun run build`
- Compiled binary startup passes: `./dist/goodvibes`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Diff hygiene passes: `git diff --check`

## [0.18.10] — 2026-04-15

### SDK `0.18.25` Startup Crash Fix

- Updated `goodvibes-tui` to consume the published canonical SDK line at `@pellux/goodvibes-sdk@0.18.25`
- Pulled in the SDK fix that removes startup-time top-level `@ast-grep/napi` imports from shared structural-find and `ast_pattern` edit paths
- Closed the compiled-binary startup regression where `./dist/goodvibes` could crash before any AST-backed tool was used simply because the full tool surface is registered during host boot

### Compiled Binary Revalidation

- Rebuilt the compiled TUI entrypoint against the published `0.18.25` SDK package instead of local SDK source
- Verified that `bun run build` followed by `./dist/goodvibes` now reaches a live running TUI session instead of dying during module initialization
- Kept the fix at the SDK boundary rather than adding a TUI-local workaround, so package consumers and future hosts get the same corrected startup behavior

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Full test runner passes: `bun run test`
- Architecture gate passes: `bun run architecture:check`
- Performance gate passes: `bun run perf:check`
- Eval gate passes: `bun run eval:gate`
- Foundation artifacts export passes: `bun run foundation:artifacts`
- Build passes: `bun run build`
- Compiled binary startup passes: `./dist/goodvibes`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Diff hygiene passes: `git diff --check`

## [0.18.9] — 2026-04-15

### SDK `0.18.24` Host-Boundary Cutover

- Updated `goodvibes-tui` to consume the published canonical SDK line at `@pellux/goodvibes-sdk@0.18.24`
- Fixed the TUI host/runtime boundary so SDK-owned services receive explicit TUI configuration instead of inheriting shared defaults
- Passed TUI-owned ecosystem catalog roots into SDK marketplace, skills, integration, and product surfaces so curated catalogs and receipts stay under `.goodvibes/tui/ecosystem/...`
- Passed `surfaceRoot: 'tui'` into the daemon service manager and `defaultSurfaceKind: 'tui'` into automation runtime setup so service files and automation target semantics stay product-owned
- Allowed the TUI runtime host to inject its own `localUserAuthManager` instead of letting the SDK bootstrap local auth storage implicitly

### Removed Remaining Local Ecosystem Duplication

- Removed the dead local `src/runtime/ecosystem/catalog.ts` implementation from the TUI
- Kept the TUI on package imports for ecosystem catalog/recommendation behavior instead of carrying a second local implementation beside the SDK
- Fixed the marketplace panel test and the built-in marketplace panel factory so they both use the same explicit TUI catalog-root wiring as the command/runtime host

### Foundation And Release-Path Corrections

- Regenerated checked-in foundation artifacts after the SDK `0.18.24` control-plane and contract updates so the TUI release gates stay aligned with the canonical runtime builders
- Cleared the remaining temp-root failure in the marketplace panel test by moving it onto the repo-local `.tmp-tests` path
- Revalidated the TUI end to end after the SDK boundary fixes instead of shipping on targeted checks alone

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Full test runner passes: `bun run test`
- Architecture gate passes: `bun run architecture:check`
- Performance gate passes: `bun run perf:check`
- Eval gate passes: `bun run eval:gate`
- Foundation artifacts export passes: `bun run foundation:artifacts`
- Build passes: `bun run build`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Diff hygiene passes: `git diff --check`

## [0.18.8] — 2026-04-15

### Canonical SDK Cutover Completion

- Switched the TUI to the canonical published SDK line at `@pellux/goodvibes-sdk@0.18.21`
- Removed the remaining local REPL and sandbox runtime implementations from the TUI and routed those flows through SDK-owned package imports instead
- Rewired command, MCP, panel, and runtime call sites that were still holding local platform copies so the TUI now consumes the shared SDK surface instead of carrying duplicate implementations

### TUI-Owned Configuration Boundary Fixes

- Kept product-owned storage and runtime identity at `.goodvibes/tui/...` by making the TUI pass explicit host configuration into SDK-owned services instead of inheriting SDK defaults
- Wired cross-session task graphs to the TUI-owned path under `.goodvibes/tui/sessions/task-graph.json`
- Instantiated the team and worklist tools with explicit `surfaceRoot: 'tui'` host configuration instead of relying on SDK defaults
- Aligned language-override and secret-store tests with the real TUI-owned configuration boundary

### Release-Path And Test Hardening

- Added per-file repo-local temp roots in `scripts/run-tests.ts` so the full TUI test suite no longer collides on shared temp filesystems
- Reworked tests that still wrote to `/tmp` or shared temp roots so they now use the active temp root or an explicit external directory when validating escape behavior
- Fixed the intelligence test helper to lazily initialize its runtime singletons, eliminating the module-init cycle that surfaced after the SDK cutover
- Improved the Skills panel detail path rendering so long skill origins keep the useful suffix visible instead of clipping away the selected file

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Full test runner passes locally: `bun run test`
- Architecture gate passes: `bun run architecture:check`
- Performance gate passes: `bun run perf:check`
- Eval gate passes: `bun run eval:gate`
- Foundation artifacts export passes: `bun run foundation:artifacts`
- Build passes: `bun run build`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Local package install smoke passes through `postinstall` with staged release artifacts
- Diff hygiene passes: `git diff --check`

## [0.18.7] — 2026-04-14

Superseded before successful public registry release. The release workflow got past the package-install fix, but the REPL tool and REPL test harness were still allocating temp state under constrained temp filesystems, which failed the test phase before publish. The corrected release shipped in `0.18.8`.

### Release Workflow Install Fix

- Fixed the TUI package postinstall path so source checkouts no longer try to download release binaries during `bun install`
- This unblocks CI and release validation jobs, which install repo dependencies before the GitHub Release assets exist
- Kept the actual packaged install behavior unchanged: published npm and GitHub Packages installs still download the matching TUI and standalone daemon binaries during `postinstall`

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Local package install smoke passes through `postinstall` with staged release artifacts
- Diff hygiene passes: `git diff --check`

## [0.18.6] — 2026-04-14

Superseded before successful public registry release. The repo checkout still ran the binary-download `postinstall` during CI `bun install`, which blocked the tagged release before publish. The corrected release shipped in `0.18.7`.

### Public Package Delivery Fix

- Replaced the oversized bundled-binary npm package model with a smaller package that installs the matching TUI and standalone daemon binaries during `postinstall`
- Kept the package identities as `@pellux/goodvibes-tui` on npmjs and `@mgd34msu/goodvibes-tui` on GitHub Packages while keeping the installed CLI surface as `goodvibes` and `goodvibes-daemon`
- Kept the runtime fallback path so installs can still run from Bun + source if a platform binary is unavailable, but made the intended install path the version-matched release binaries

### Release Workflow Correction

- Reordered the release workflow so the GitHub Release and binary assets are created before npmjs and GitHub Packages publishing, ensuring package installs can fetch release assets immediately after publish
- Reworked install-smoke validation so the packed npm tarball is tested through the real `postinstall` path that installs both the TUI and daemon binaries for the current platform
- Hardened publish validation so registry tarballs fail if they accidentally include vendored binaries again or exceed the package-size guardrail

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Local package install smoke passes through `postinstall` with staged release artifacts
- Diff hygiene passes: `git diff --check`

## [0.18.5] — 2026-04-14

Superseded before successful public registry release. The bundled-binary tarball for this version exceeded npmjs and GitHub Packages size limits, and the corrected public package model shipped in `0.18.6`.

### Public Package And Release Correction

- Corrected the public packaged release path after the initial `0.18.4` cutover so the shipped npm distribution now matches the actual intended install model
- Published the TUI on npm as `@pellux/goodvibes-tui` and mirrored the same release to GitHub Packages as `@mgd34msu/goodvibes-tui`
- Kept the installed CLI surface as `goodvibes` and `goodvibes-daemon` while moving the package identity to the scoped release names
- Added both launcher bins to the packaged distribution so global installs expose the interactive TUI and the standalone daemon directly on the user path

### Bundled Binary Delivery

- Bundled the compiled TUI binaries directly into the npm package for:
  - Linux x64
  - Linux arm64
  - macOS x64
  - macOS arm64
- Bundled the standalone daemon binaries directly into the npm package for:
  - Linux x64
  - Linux arm64
  - macOS x64
  - macOS arm64
- Removed the prior install-time binary download behavior so npm installs now use the packaged binaries already present in `vendor/`
- Added packaged release checksums through `vendor/SHA256SUMS.txt` and release-asset `SHA256SUMS.txt`

### Release Automation And Publish Path Hardening

- Added staged vendor-binary packaging so npm and GitHub Packages publishes are built from the same explicit bundled-binary package shape
- Added a dedicated publish-packaging path for registry release publishing instead of depending on raw repo copies during publish
- Added a GitHub Packages publish job alongside the npmjs publish job in the release workflow
- Fixed staged publish rehearsal so local dry-runs validate the real publishable package shape without tripping registry version conflicts or temporary-filesystem quota failures
- Extended release validation and install smoke coverage to require both launcher bins and both bundled binary families

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Performance gate passes: `bun run perf:check`
- Eval gate passes: `bun run eval:gate`
- Full test runner passes: `bun run test`
- Build passes: `bun run build`
- Foundation artifact export passes: `bun run foundation:artifacts`
- Vendored binary staging passes: `bun run vendor:stage --clean`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Diff hygiene passes: `git diff --check`

## [0.18.4] — 2026-04-14

### First Public Distribution And Delivery

- Published the TUI under the Pellux scope as `@pellux/goodvibes-tui` while keeping the installed CLI commands as `goodvibes` and `goodvibes-daemon`
- Added a GitHub Packages mirror as `@mgd34msu/goodvibes-tui`
- Bundled the compiled TUI and standalone daemon binaries directly into the npm package instead of relying on install-time downloads
- Added both `goodvibes` and `goodvibes-daemon` launcher bins to the package so global npm installs expose both commands on the user path
- Expanded the release asset set to ship compiled binaries for:
  - Linux x64
  - Linux arm64
  - macOS x64
  - macOS arm64
- Expanded the release asset set to ship standalone daemon binaries for:
  - Linux x64
  - Linux arm64
  - macOS x64
  - macOS arm64
- Added `SHA256SUMS.txt` checksums for the published release binaries

### Canonical SDK Cutover

- Switched `goodvibes-tui` from the temporary beta line to the canonical `@pellux/goodvibes-sdk@0.18.14` package and rewired imports to the canonical SDK entrypoints
- Removed the duplicated local platform implementation that had already been extracted into the SDK, including large portions of contracts, daemon route handlers, runtime transports, state/runtime helpers, tools, utilities, and other shared platform code
- Cut the remaining local state-inspector implementation over to the SDK-owned surface so the TUI now consumes the shared runtime inspection code instead of carrying its own duplicate copy

### CI And Release Path Fixes

- Fixed the TUI eval gate to use the SDK-backed eval baseline, formatting, and scorecard exports after the platform extraction removed the old local files
- Fixed the TUI performance gate to build CI snapshots against the SDK-backed `surfacePerf` domain shape instead of the pre-extraction local `uiPerf` shape
- Fixed the architecture check so it tolerates removed migration targets on clean checkouts instead of crashing when extracted directories no longer exist
- Fixed the package publish path so release packaging stages vendored binaries deterministically instead of depending on install-time binary download behavior
- Fixed the release workflow to publish both npmjs and GitHub Packages distributions from the same bundled-binary package shape
- Fixed the staged publish rehearsal so it packs the final publishable package locally without tripping registry version conflicts or `/tmp` quota issues

### Verification

- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Performance gate passes: `bun run perf:check`
- Eval gate passes: `bun run eval:gate`
- Full test runner passes: `bun run test`
- Build passes: `bun run build`
- Foundation artifact export passes: `bun run foundation:artifacts`
- Vendored binary staging passes: `bun run vendor:stage --clean`
- Publish packaging check passes: `bun run publish:check`
- Staged npm package rehearsal passes: `bun run publish:dry-run`
- Staged GitHub Packages rehearsal passes: `bun run publish:dry-run:github`
- Diff hygiene passes: `git diff --check`

## [0.18.3] — 2026-04-14

### SDK-Ready Transport And Contract Seams

- Added source-owned foundation contract types plus generated typed operator, peer, and runtime-event client maps so remote clients consume stable typed daemon surfaces instead of inferring them from route behavior
- Split the runtime transport layer into explicit HTTP auth/retry/json, SSE/reconnect, direct-client, contract-route, operator remote-client, peer remote-client, and runtime/domain-event modules instead of leaving those concerns in a few broad transport files
- Expanded runtime event domain metadata, distributed runtime contracts, and shared event-envelope wiring so remote clients and future companion surfaces can subscribe to named domains with stable payload semantics
- Fixed the extracted HTTP JSON transport so explicit `Authorization` and `Content-Type` headers are preserved through request construction, keeping remote operator and peer clients aligned with their contract tests and downstream SDK copies

### Daemon Route Extraction And Artifact Hardening

- Broke reusable daemon route logic into packageable channel, integration, knowledge, media, system, telemetry, and shared route-helper contexts while moving TUI-specific host adapters into dedicated router route-context builders
- Hardened operator, peer, remote, and telemetry route contracts around narrowed route types, shared auth/error helpers, and explicit runtime route semantics rather than deep TUI-only internal dependencies
- Refreshed the checked-in operator and peer foundation artifacts, added generated foundation client types, and extended release-gate coverage so the extracted daemon and transport surfaces stay frozen as the source tree evolves
- Fixed daemon contract and gateway catalog responses to serialize recursive JSON-schema structures safely instead of failing at runtime when `Response.json()` encountered cyclical schema references

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test`
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.18.2] — 2026-04-13

### Panel Navigation And Global Shortcut Recovery

- Restored the intended panel workspace navigation model so `Tab` swaps focus between the prompt and panel area while `Ctrl+P`, `Ctrl+[`, and `Ctrl+]` remain the global panel workspace controls
- Fixed extended-keyboard punctuation decoding and shortcut routing so `Ctrl+[`, `Ctrl+]`, and other punctuation-based global bindings continue to work even when panel focus is active
- Corrected global `Ctrl+C` handling so prompt content clears first and empty-prompt cancel or exit behavior still works consistently from input, panel, and modal focus states

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test`
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.18.1] — 2026-04-13

### Conversation Follow-Ups And Panel Workspace UX

- Added lightweight assistant follow-up acknowledgements in the main conversation for agent completion/failure, cohort completion, and WRFC pass/fail milestones instead of forcing users to infer those transitions from secondary surfaces
- Reworked the panel workspace around retained preloaded panels, a workspace tab strip, clearer system-message presentation, and startup prewarming so important panel data is already loaded before the panel is opened
- Updated panel workspace behavior so `Tab` swaps focus between the prompt and panel area while `Ctrl+P`, `Ctrl+[`, and `Ctrl+]` remain global workspace controls

### Input Routing And Shortcut Reliability

- Fixed extended-keyboard decoding and shortcut routing so global controls continue to work while panel focus is active, including correct handling for `Ctrl+[`, `Ctrl+]`, and prompt/panel focus transitions
- Fixed `Ctrl+C` so it is truly global across the shell: if the prompt has content it clears it first, otherwise it falls through to generation cancel and exit-notice behavior regardless of panel or modal focus
- Corrected feed-path state synchronization so imperative shortcut handlers no longer lose prompt, focus, or modal state changes when the input context is written back after a token pass

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test`
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.18.0] — 2026-04-13

### Provider Routing And WRFC Reliability

- Fixed explicit-provider routing so reviewer and fixer flows stay pinned to the selected concrete provider instead of falling through to another provider that happens to expose the same model id
- Added provider request and stream-phase diagnostics so provider-boundary failures preserve upstream request ids, provider codes, and routing context instead of collapsing into misleading local errors
- Tightened WRFC reviewer payload shaping so review tasks carry compact structured context rather than unnecessarily large embedded engineer reports

### Descriptive Errors And Telemetry Foundation

- Reworked the shared error model so provider, daemon, transport, and automation failures now preserve structured categories, sources, guidance, retry hints, request ids, and upstream metadata instead of flattening to raw status text
- Added a first-class telemetry API with snapshot, events, errors, traces, metrics, SSE streaming, and OTLP-shaped export documents, with safe-by-default redaction and elevated raw access controls
- Normalized the daemon’s dynamic JSON error responses around the same structured error surface so external consumers can reason about failures without string-matching ad hoc messages

### SDK-Facing Control-Plane Contract Hardening

- Added typed telemetry DTOs to the operator contract, method catalog, and checked-in foundation artifacts so future SDK generators can consume stable telemetry schemas rather than infer them from route behavior
- Added public current-principal/auth-introspection endpoints and transport support so SDK consumers can inspect effective auth mode, scopes, and operator identity through the same contract surface they use for product APIs
- Extended release-gate and transport coverage around the new telemetry and control-plane auth surfaces so the contract stays frozen as the server and foundation layers evolve

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test`
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.17.4] — 2026-04-13

### Final Domain Splits For Shell, Runtime Views, And Server Composition

- Split the remaining broad shell/runtime composition seams into explicit domain modules for shell command bootstrap parts, shell command service families, runtime bootstrap composition, daemon facade composition, runtime session routes, runtime automation routes, and UI read-model families instead of keeping those responsibilities in a few broad adapter hubs
- Broke the old UI read-model monolith into core, operations, base, and observability families with explicit subdomains for remote, security, system, maintenance, and options surfaces so the first-party shell now tracks future package seams more closely
- Tightened panel and command wiring around those explicit read-model and service families so the TUI remains a consumer of shaped runtime surfaces rather than a privileged owner of broad runtime state

### Contract Hardening And Explicit Schema Semantics

- Replaced the remaining semantically important raw generic-object contract pockets with named typed JSON record or document schemas across operator, knowledge, media, channels, permissions, and admin surfaces so the control-plane contract is explicit where semantics matter instead of relying on raw `JSON_OBJECT_SCHEMA`
- Added explicit login request and response DTO schemas to the operator contract, tightened artifact list output typing, and updated channel, knowledge, and media method catalogs to consume the new named schema surfaces consistently
- Strengthened the route and execution intent release gate to lock in explicit enum-backed route delivery semantics instead of accepting plain strings

### Final Bootstrap Ownership Cleanup

- Removed the remaining silent manager construction from tool and orchestrator registration by requiring explicit file-undo, mode, process, message-bus, and workflow dependencies from the owned runtime graph
- Updated runtime bootstrap and tests so tool registration, state tooling, and orchestrator dependencies now fail explicitly when required owned services are missing rather than reconstructing local fallback ownership

### Architecture Enforcement

- Added an architecture rule that blocks raw `JSON_OBJECT_SCHEMA` usage in contract schema modules so future contract evolution must go through named typed DTO or document schemas instead of generic object placeholders
- Refreshed the checked-in operator contract artifact to match the stricter explicit schema surface and domain-split runtime view model

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test` (`7047` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.17.3] — 2026-04-13

### Explicit Intent Surfaces For Sessions, Routing, And Execution

- Added explicit shared-session intent modeling for `submit`, `steer`, and `follow-up` flows, including durable input records, lifecycle-state tracking, correlation and causation IDs, explicit cancellation, and stable operator-surface semantics instead of inferring continuation behavior from session forwarding alone
- Extended the operator/session and daemon runtime surfaces so session message submission, explicit steering, deferred follow-up, and spawned continuation work all carry one typed routing model with stable lifecycle events that are suitable for future SDK extraction
- Added explicit execution-intent propagation across automation runs, task spawning, and agent records so risk class, approval posture, network policy, and filesystem policy travel through the runtime as deliberate semantics instead of implicit internal assumptions

### Explicit Route, Artifact, Knowledge, And Provider Intent

- Added typed route-binding semantics for `sessionPolicy`, `threadPolicy`, and `deliveryGuarantee` so automation and channel routing can express whether to create, bind, continue, detach, preserve, replace, or require existing conversation state instead of relying on route-manager defaults alone
- Hardened artifact and knowledge intent surfaces with stable fetch-policy propagation and release gates so remote fetch posture, trust framing, and routed ingestion behavior stay aligned with the canonical operator contract and knowledge foundation artifacts
- Tightened agent/provider routing semantics so WRFC and spawned-agent flows preserve explicit provider, model, helper, and execution metadata instead of falling back to broader inference paths

### Release Gates And Verification

- Added release-gate coverage for session intent state, route/execution intent schema stability, and knowledge/artifact intent behavior so the newly explicit foundation surfaces stay frozen and extractable
- Updated the checked-in operator contract artifact and foundation-surface certification expectations to include the new explicit session, routing, and execution semantics

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test` (`7047` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.17.2] — 2026-04-13

### Canonical Foundation Artifacts And Consumer Examples

- Added a checked-in foundation artifact export flow with canonical operator-contract, peer-contract, knowledge GraphQL, and knowledge SQL outputs under `docs/foundation-artifacts`, plus a release gate that keeps those artifacts in sync with the runtime builders
- Added minimal in-process and HTTP reference consumers under `examples/reference-operator-client` and `examples/reference-http-client` so future SDK and shell work can validate the intended builder-facing programming model against real code instead of repo-local knowledge
- Exposed canonical knowledge SQL and GraphQL export helpers from the knowledge foundation surface so the current repo can lock those shapes intentionally before extraction

### Transport Parity And Future Package Boundary Enforcement

- Added a transport parity release gate that exercises shared operator and peer workflows plus event delivery across direct, HTTP, and realtime transports, and fixed HTTP session fetch behavior so transport consumers see the same session shape as the in-process path
- Expanded architecture enforcement to simulate future `foundation`, `server`, and shell package boundaries by blocking shell or daemon imports from the stable in-process consumer surfaces that will carry into the SDK monorepo
- Updated TypeScript project coverage and docs indexing so the checked-in examples and foundation artifacts are part of the normal release verification path

### Server Adapter Cleanup

- Unified transport-aware server auth and route policy handling behind shared HTTP auth and policy helpers so control-plane, system, knowledge, media, and listener routes now resolve principals, scope denials, and private-host fetch policy through one server-side path instead of per-route variants
- Added regression coverage for the shared server auth and policy layer to keep cookie-or-bearer operator auth, route policy evaluation, and private-host fetch enforcement stable as the server surface moves toward extraction

### Verification

- Foundation artifact export passes: `bun run foundation:artifacts`
- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test` (`7036` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.17.1] — 2026-04-12

### Auth, Transport, And Ingress Hardening

- Added shared operator HTTP auth handling with local session cookies, explicit `Authorization` bearer support, login-set cookies, and control-plane WebSocket auth frames so REST, SSE, and WS auth now follow one model without query-token leakage
- Removed control-plane token query-parameter auth from runtime transports and generated operator links, and fixed an async event-stream disconnect race so abandoned SSE connects do not leak background connections
- Fixed Microsoft Teams ingress authentication to require the configured secret exactly, split WhatsApp verify-token and signing-secret handling, and added signed or token-backed POST verification plus bounded body parsing for the webhook adapters that previously accepted unbounded payloads

### Private-Host Fetch Policy And Prompt Trust Boundaries

- Split private-host remote fetch access from normal media and knowledge operations with the new `network.remoteFetch.allowPrivateHosts` runtime policy, explicit request flags, and elevated-route checks instead of implicitly allowing internal URL fetches through multimodal analysis or knowledge ingest
- Extended the same private-host fetch policy to knowledge batch ingest flows, GraphQL mutations, and control-plane method schemas so bookmarks, connector imports, and artifact-backed ingest all follow the same config-gated behavior
- Hardened orchestrator knowledge and memory prompt injection boundaries by framing injected source material as untrusted technical reference content that may inform implementation details but must not override runtime policy, permissions, or secrecy rules

### Verification

- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test` (`7025` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.17.0] — 2026-04-12

### Consumer-Shaped Foundation Surfaces

- Added explicit operator and peer client surfaces plus direct, HTTP, SSE, and WebSocket transport layers so future shells and companion clients can target one typed foundation instead of reaching into runtime internals
- Added stable shell-facing service queries, read models, and API façades for providers, hooks, MCP, knowledge, peer/runtime operations, and shell paths so commands and panels consume product semantics rather than raw store or event-bus layout
- Split provider-health aggregation into domain/tracker modules and expanded foundation-surface, transport-parity, and operator-surface release gates so client-shaped runtime access is enforced by CI

### Ownership Cleanup, Shell De-Privileging, And Extension Seams

- Removed the remaining privileged command and panel reach-throughs into provider registries, knowledge services, memory registries, and peer/runtime internals by routing those paths through shaped runtime APIs
- Replaced more fallback-owned managers and ambient path discovery with explicit bootstrap-owned home, project, config, storage, and service roots across config, secrets, subscriptions, automation, sessions, bookmarks, profiles, daemon services, and tool registration
- Tightened plugin, hook, MCP, discovery, provider, automation, and runtime integration seams around explicit ownership so future extraction can happen without legacy shims or hidden bootstrap shortcuts

### Stability, UX, And Release-Gate Fixes

- Fixed an approval callback ordering race so daemon approval completion cannot drop callbacks under CI or fast local runs
- Fixed slash-command/modal handoff regressions that blocked modal selection actions and left the slash menu latched after exiting nested modals
- Expanded regression coverage around provider migration paths, remote/runtime commands, knowledge flows, panel read models, transport behavior, and foundation-surface certification

### Verification

- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test` (`7011` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.16.0] — 2026-04-12

### V1 Architecture Hardening And SDK Readiness

- Replaced ambient runtime ownership with an explicit app-scoped `RuntimeServices` graph built at bootstrap and threaded through the daemon, control-plane, command surfaces, panels, automation runtime, knowledge runtime, and shell integrations
- Removed retired cross-boundary singleton/global shortcuts, including the old adaptive-planner and plan-manager instance modules, runtime integration-context fallbacks, and other ambient access patterns that blocked clean service ownership
- Split the remaining high-gravity runtime files into coherent domain modules across daemon routing, channel builtins and delivery, automation manager internals, orchestrator helpers, panel registration families, remote runtime coordination, knowledge store/service helpers, and tool runtimes while preserving public entrypoints
- Standardized extension-family wiring across providers, channels, hooks, panels, and tools so runtime registration, ownership, and metadata flow through one model instead of per-family singleton-style seams

### Contracts, CI Enforcement, And Strong Typing

- Hardened the operator and peer contracts with dedicated operator schema modules by domain, explicit distributed-runtime peer contracts, and a fully typed method catalog with no remaining generic-object operator method schemas
- Added architecture enforcement in CI and release workflows for file-size caps, banned ambient runtime access, banned explicit `any`, and contract-schema regressions
- Updated runtime and command tests to use real owned services and real hook, subscription, provider, and policy contract shapes rather than legacy shims or incomplete mocks
- Tightened release-gate coverage around operator surfaces, runtime substrate ownership, hooks authoring, and architecture expectations so future regressions fail fast

### UX And Runtime Fixes

- Fixed prompt input rendering so typed characters appear on the same keystroke instead of lagging one character behind
- Restored builtin `ops` strategy panel registration after the panel-family split so the operator surface remains complete
- Fixed settings-modal subscription loading, managed-hooks command/workbench usage, recall policy capture wiring, and guidance maintenance context lookups under the stricter ownership model
- Updated release/build scripts so README version badges stay in sync and explicit minor/major release bumps are supported without hand-editing scripts

### Verification

- Full typecheck passes: `bunx tsc --noEmit --pretty false`
- Architecture gate passes: `bun run architecture:check`
- Full test runner passes: `bun test` (`6963` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.15.8] — 2026-04-11

### TLS Transport Controls And Certificate Handling

- Added a shared runtime network layer for inbound TLS, outbound HTTPS trust, forwarded-header trust handling, and certificate path resolution instead of scattering transport concerns across daemon, listener, and provider code
- Added inbound TLS configuration for both the control-plane daemon and the HTTP listener with explicit `off`, `proxy`, and `direct` modes, proxy trust controls, and direct-TLS support through Bun server TLS
- Added default direct-TLS certificate discovery from `~/.goodvibes/certs/fullchain.pem` and `~/.goodvibes/certs/privkey.pem`, along with startup inspection and key-permission checks for operator-facing health/reporting
- Added centralized outbound HTTPS trust controls with `bundled`, `bundled+custom`, and `custom` trust modes, custom CA file/directory support, and a scoped `allowInsecureLocalhost` escape hatch for local development
- Installed the outbound transport wrapper at runtime bootstrap and daemon startup so fetch-based provider, search, artifact, webhook, download, telemetry, and integration traffic inherits one trust policy by default
- Extended daemon status and integration health surfaces to report inbound and outbound network posture, including active TLS mode, trust strategy, configured CA material, and direct-versus-proxied endpoint shape
- Hardened startup and test behavior by fixing global fetch wrapping so network transport installation composes cleanly under parallel test runs instead of leaking stale global transport state

### Documentation And Docs Layout Cleanup

- Updated the README and deployment guide to document inbound TLS modes, direct certificate paths, reverse-proxy deployment, outbound CA trust configuration, and the compiled-binary versus source daemon transport behavior
- Removed the archived docs set from the repository now that the new focused docs set owns the current product documentation

### Verification

- Full typecheck passes: `bunx tsc --noEmit`
- Full test runner passes: `bun test` (`6983` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.15.7] — 2026-04-11

### Knowledge, Memory, And Multimodal Runtime Depth

- Added a structured knowledge system with SQL-backed sources, nodes, edges, issues, extractions, job runs, connector manifests, bookmark import, URL-list ingest, and artifact-linked compile/lint/reindex flows
- Added knowledge GraphQL and projection surfaces so external clients can query canonical knowledge state, render markdown/wiki projections, materialize derived artifacts, and integrate without a frontend living inside the TUI repo
- Added deeper knowledge runtime behavior including richer projections, GraphQL query/mutation depth, live knowledge events, background jobs, TS-only document extractors, and connector setup/doctor metadata
- Added memory and knowledge lifecycle automation with usage ledgers, consolidation candidates, deterministic consolidation reports, freshness policies, graph-aware packet scoring, scheduled light/deep consolidation, and promotion of repeatedly useful context into durable memory
- Added a unified multimodal runtime for image, audio, video, and document analysis with token-efficient packets and write-back into the structured knowledge store

### Providers, Channels, Voice, Search, And Attachment Expansion

- Added provider/runtime wiring for Bedrock, Bedrock Mantle, Anthropic Vertex, GitHub Copilot, Microsoft Foundry, Perplexity search, expanded OpenAI-compatible capability discovery, and the supporting provider catalog and registry posture surfaces
- Added channel surfaces for Microsoft Teams, BlueBubbles, Mattermost, and Matrix with builtin runtime registration, setup contracts, doctor hooks, route binding, and delivery wiring
- Expanded voice support with OpenAI TTS/STT/realtime, Google STT, Deepgram STT, ElevenLabs TTS/STT/realtime, and the shared provider registration/types needed to negotiate those capabilities cleanly through daemon APIs
- Added generation/media provider registry breadth and search/provider registry breadth needed by the expanded backend integrations
- Hardened artifact storage and type inference, including safer SQLite path handling and cleaner structured attachment handling across daemon and delivery flows

### Domain And File Architecture Cleanup

- Split the daemon server into route-family modules for remote, knowledge, and media handling while keeping the daemon transport surface stable
- Extracted control-plane web UI rendering out of the gateway transport file and split the method catalog into domain-specific modules instead of one monolithic catalog
- Split configuration schema construction into domain-specific schema modules and shared helpers
- Split builtin voice providers into provider-specific modules and reduced the runtime store to thin store wiring plus externalized reducer helpers without weakening the domain-boundary contract
- Split automation manager internals, knowledge-service internals, and builtin channel runtime support into smaller domain modules while preserving the existing public entrypoints
- Deferred automation cron-helper initialization so scheduler imports no longer create a module-load cycle through `TaskScheduler`
- Added and updated regression coverage for the new domain boundaries, daemon routing, knowledge commands, multimodal runtime, channel delivery, voice providers, and expanded control-plane/provider behavior

### Verification

- Full typecheck passes: `bunx tsc --noEmit`
- Full test runner passes: `bun test` (`6971` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.15.6] — 2026-04-10

### Gateway, Channels, Providers, Search, And Media Rollout

- Expanded the control-plane method catalog into the authoritative external gateway contract with stable daemon, operator, automation, remote, memory, provider, media, and artifact method coverage, schema metadata, event catalog exposure, and enforced HTTP/WebSocket scope checks
- Added a shared channel reply pipeline that normalizes assistant text, reasoning, tool lifecycle, plan updates, approvals, command output, patches, compaction, and model selection into consistent Slack, Discord, ntfy, webhook, and web/operator delivery behavior
- Added channel-owned setup, doctor, repair, secret-target, lifecycle migration, and allowlist edit/resolve contracts and moved more channel posture logic out of bespoke daemon handlers
- Added built-in Telegram, Google Chat, Signal, WhatsApp, and iMessage channel adapters/plugins with setup metadata, doctor checks, target resolution, and provider-side setup guidance
- Added provider-owned runtime metadata and plugin SDK breadth for auth posture, repair hints, model normalization/suppression, usage/cost reporting, embeddings posture, and stream/reasoning/cache policy reporting
- Added provider-backed memory embeddings for OpenAI, OpenAI-compatible and LM Studio, Ollama, Gemini, and Mistral plus sqlite-vec-safe async rebuild/reindex flows and memory doctor diagnostics
- Added the provider-backed `web_search` domain and tool with DuckDuckGo Lite + Instant Answer as the default no-key provider plus Brave, Exa, Firecrawl, SearXNG, and Tavily adapters, normalized result shaping, verbosity control, and bounded evidence attachment through `fetch`
- Added a durable artifact/attachment store for arbitrary files with remote URI ingest, SSRF-aware host blocking, MIME/size validation, retention metadata, structured attachment publication, and attachment-aware daemon/control-plane delivery
- Added concrete artifact-backed image-understanding providers for OpenAI, Gemini, Anthropic, generic multimodal routing, and local OpenAI-compatible multimodal backends
- Added a Bun/TS reference node-host client covering pair, verify, heartbeat, work pull/complete, generic invoke flows, reconnect/backoff, scoped operation, and command allowlists

### Fetch, Local Provider, And Stability Hardening

- Added URL-encoded `body_data` form support to the low-level `fetch` tool so provider adapters can POST form data without manual encoding
- Removed config/runtime initialization-cycle hazards from the memory vector store and artifact store defaults so search/media/artifact startup paths do not deadlock on eager imports
- Hardened local-provider coverage around LM Studio and OpenAI-compatible multimodal/runtime detection, including regression coverage for the newer provider-specific behaviors
- Expanded deterministic tool/channel/provider/plugin regression coverage to include the new `web_search`, artifact, image-understanding, secret-ref, runtime-metadata, and daemon integration surfaces

### Verification

- Full typecheck passes: `bunx tsc --noEmit`
- Full test runner passes: `bun test` (`6932` pass, `0` fail)
- Build passes: `bun run build`
- Diff hygiene passes: `git diff --check`

## [0.15.5] — 2026-04-10

### Automation Gateway Runtime: SDK, Voice, Media, Memory, And Runtime Contracts

- Added a first-class control-plane gateway method catalog with typed method descriptors, builtin method discovery, plugin method registration, HTTP method listing/invocation routes, and WebSocket `methodId` invocation support for remote clients
- Added plugin SDK contribution hooks for gateway methods, channel plugins, delivery strategies, memory embedding providers, voice providers, and media providers, with unload cleanup wired through the active registries
- Added TS-only voice provider contracts and daemon APIs for status, provider discovery, voice listing, TTS synthesis requests, STT transcription requests, and realtime voice session negotiation without adding native mic/audio dependencies
- Added TS-only media provider contracts and daemon APIs for provider discovery, media analysis, transforms, and generation so web or companion clients can supply captured attachments while the TUI owns orchestration and policy
- Added memory embedding provider registration, a deterministic hashed fallback embedding provider, sqlite-vec vector normalization, memory vector rebuild/default-provider APIs, and a memory doctor report for provider/vector-store health
- Added automation `next-heartbeat` wake semantics so scheduled jobs can queue until an explicit daemon heartbeat trigger, with heartbeat inspection and trigger APIs
- Added distributed node/device host contract APIs describing pairing, scoped heartbeat/pull/complete endpoints, supported peer kinds, work types, scopes, and operator snapshot surfaces

### Verification

- Added regression coverage for gateway method catalog dispatch, plugin SDK extension cleanup, voice/media provider registries, memory embedding provider behavior, automation heartbeat wake queuing, daemon API routes, and WebSocket gateway method invocation
- Typecheck passes: `bunx tsc --noEmit -p tsconfig.json`
- Build passes: `bun run build`
- Full test runner passes: `bun test` (`6888 pass, 0 fail`)
- Diff hygiene passes: `git diff --check`

## [0.15.4] — 2026-04-10

### Automation, Control Plane, And Channel Gateway Rollout

- Added the first-class automation runtime with durable jobs, runs, schedules, delivery policies, source records, target semantics, manual run/retry/cancel controls, telemetry capture, legacy scheduler migration, and background reconciliation
- Added route bindings as a shared channel/session targeting layer with deterministic natural-key upserts, thread/channel/session continuity, reply-target capture, and route-domain event emission
- Added the control-plane gateway API with authenticated snapshots, event streaming, WebSocket transport for API clients, browser-consumable SSE-over-fetch streaming, control-plane messages, method-call support, and shared session/approval/task operations
- Added shared-session brokering so webhooks, channel events, automation jobs, and remote surfaces can continue live agents or spawn/bind new agents against the same routed session
- Added watcher support with persistent polling/manual watchers, control-plane watcher APIs, heartbeat/degraded state, start/stop/run/delete operations, and overlap prevention
- Added daemon CLI/service-management foundations, service status APIs, and startup cleanup so failed or timed-out daemon/listener starts do not leak partial servers or provider/watchers state

### Slack, Discord, ntfy, Generic Webhooks, And Channel Product Surfaces

- Added channel adapter/plugin infrastructure for Slack, Discord, ntfy, generic webhooks, web control-plane delivery, policy checks, target resolution, lifecycle hooks, account posture, channel tools, operator actions, and direct agent tools
- Added Slack integration support for signed event/interactive webhooks, approvals, bot/webhook replies, OAuth/setup helpers, account inspection, target resolution, policy bypass controls, and thread-aware route binding
- Added Discord integration support for signed interaction webhooks, bot/webhook replies, interaction follow-ups, setup helpers, account/capability surfaces, target resolution, and route binding
- Added ntfy integration support for authenticated inbound webhooks, topic routing, outbound delivery, and token-backed setup through config/service registry/environment sources
- Added generic webhook ingress and delivery with shared-secret or HMAC verification, correlation metadata, callback replies, callback signing, route binding, and public-URL validation
- Added channel policy APIs and enforcement for mention gating, conversation kinds, group/channel/user allowlists, authorized control-command bypasses, directory/status/audit surfaces, and group-specific overrides
- Added TUI panels for automation control, control plane, routes, and watchers, plus broader schedule/remote panel updates for the new automation and distributed-runtime state

### Local Provider Detection And Streaming UX

- Added discovered local provider support for LM Studio, llama.cpp, and Ollama on top of the OpenAI-compatible fallback path
- Added provider trait discovery and custom provider factories so GoodVibes can promote a detected local server from generic OpenAI-compatible behavior to provider-specific behavior when possible
- Added LM Studio, llama.cpp, and Ollama model metadata tests and provider wiring for richer local-model capability/context handling
- Fixed OpenAI-compatible streaming delta parsing for LM Studio-style `event: ...` SSE frames and reasoning/content separation so reasoning goes to the thinking panel and final response text goes to the conversation
- Hardened local provider streaming against malformed or partial tool-call diffs from local LLMs so invalid chunks no longer break the client with raw diff parser errors

### Runtime Domains, Remote Runtime, And Integration Helpers

- Added automation, routes, deliveries, surfaces, watchers, and control-plane runtime domains with typed events, emitters, store state, read-matrix entries, and domain-map coverage
- Added distributed remote runtime support for pair requests, approvals, challenge verification, peer tokens, scoped remote heartbeat/pull/complete APIs, work queueing/claiming/completion, token rotation/revocation, disconnect/requeue behavior, and remote runtime panels/API state
- Added runtime integration helpers so daemon/control-plane/channel code can inspect panels, review state, task visibility, continuity, and runtime task records through stable API surfaces
- Added deferred startup coordination so heavier provider/control-plane/automation startup work can be scheduled without blocking the initial TUI render path
- Added feature flags for the automation, control-plane gateway, channel, watcher, and local provider rollout points

### TUI UX, Git Quit Flow, Copying, And Splash Rendering

- Added `:wq` shared quit handling that checks for a Git repo, stages all changes, creates an appropriate commit message, waits for commit completion, and exits; non-Git projects still quit normally
- Fixed startup/splash resize behavior so terminal-size changes refresh the splash, preserve the full-size splash instead of swapping to a compact fallback, and horizontally center it when it fits
- Fixed code-block selection/copy behavior so intended leading indentation inside code blocks is preserved while visual gutters/margins are not copied
- Fixed conversation block lookup so actions/copying prefer the block containing the selected line instead of the nearest later block start
- Added daemon/startup script wiring and shell-command extraction updates needed by the new shared quit and daemon flows

### Security, Safety, And Correctness Hardening

- Required explicit generic webhook and ntfy ingress configuration before inbound requests can spawn agents, with shared-secret/HMAC verification for generic webhooks and token checks for ntfy
- Added public webhook URL validation for generic callbacks and outbound webhook delivery, blocking non-HTTPS URLs, credentials, localhost, metadata hosts, loopback/private/link-local/multicast IPv4, and unsafe IPv6 or IPv4-mapped IPv6 hosts
- Enforced remote peer token scopes on heartbeat, pull, and complete endpoints instead of only storing scopes on issued tokens
- Added admin checks to mutating control-plane/operator APIs for channel actions/tools/policies/authorization, watcher mutation, service lifecycle, route binding mutation, and config mutation
- Removed control-plane web shell token storage in `localStorage`, stopped putting browser stream tokens in WebSocket/EventSource URLs, escaped HTML attributes, safely serialized inline JSON, and replaced dynamic `innerHTML` rendering with DOM/textContent construction
- Hardened path safety against symlink escapes by validating real paths for the project root, nearest existing ancestor, and existing targets
- Treated non-dry-run `inspect scaffold` as a write operation, normalized scaffold module names, and resolved scaffold writes through the project path-safety layer
- Fixed diff-panel Git commands to use argument-vector spawning instead of shell-string construction
- Fixed the exec import-rewrite regex escaping bug and watcher polling overlap races

### Verification

- Added regression coverage for webhook/ntfy auth, unsafe callback rejection, public webhook URL validation, symlink path escapes, route binding idempotency, remote token scopes, channel delivery URL safety, daemon/control-plane/channel APIs, code-block lookup, splash sizing, local provider discovery, automation domains, distributed runtime, and bootstrap cleanup
- Full typecheck passes: `bunx tsc --noEmit -p tsconfig.json`
- Full test runner passes: `370 test files, passed: 370, failed: 0`

## [0.15.3] — 2026-04-09

### Streaming, Usage, And Provider Delta Handling

- Fixed reasoning-heavy streaming so live output/token indicators continue advancing even when OpenAI-compatible providers emit reasoning deltas instead of plain text chunks
- Added shared OpenAI stream-delta normalization for `delta.content`, typed content arrays, `delta.reasoning`, `delta.reasoning_content`, and reasoning-summary shapes
- Fixed live token/output visibility with streaming disabled so the thinking strip keeps moving while the provider is still producing output
- Corrected live input accounting so the per-turn request estimate appears during the turn and cache-read tokens are not double-counted into fresh input display

### Local Runtime, Multi-Instance, And Lifecycle Hygiene

- Hardened daemon/listener bootstrap so a second `goodvibes-tui` instance skips already-owned default ports instead of hanging while trying to start duplicate local services
- Added startup timeout fallback for local bootstrap services so stalled service startup no longer blocks the TUI indefinitely
- Fixed a late async watcher race in custom provider loading so shutdown cannot accidentally recreate a file watcher after close
- Added explicit orchestrator and orchestration-registry disposal hygiene for replay listeners, timers, and process-exit handlers
- Removed unreleased process-level signal/rejection handlers during shutdown to avoid lifecycle leaks in tests, embedding, and restart flows

### Panel Live Updates, Agent Visibility, And Background Process UX

- Fixed live panels that were detaching subscriptions or timers on blur, so switching to another panel no longer freezes updates until reopen
- Restored background-process strip agent visibility by sourcing active agents from both `AgentManager` and the runtime agents domain
- Kept the background-process strip as the fast access surface while promoting the detailed live agent-session view into the dedicated `Agents` panel
- Reworked process-strip focus styling so:
  - the prompt loses focus visually and hides its cursor
  - the selected process row uses a brighter bounded highlight
  - the highlight no longer bleeds into outer margins or floods the entire row

### Conversation, Panels, And Tool Rendering Fixes

- Fixed WRFC replay notices so they route through the system-message path instead of spamming the main conversation
- Fixed tool-call row alignment so tool output blocks no longer collide with or begin underneath compact tool status labels
- Fixed tracked markdown table rendering for assistant content and added tolerant handling of slightly malformed alignment rows from model output
- Fixed Explorer -> Preview, Preview -> Symbols, and Symbols -> Preview panel handoff paths so cross-panel browsing actions execute instead of only advertising the action
- Fixed approval-panel activation so selecting an approval row and pressing `Enter` executes the review action path

### Modal And Settings Interaction Fixes

- Reworked toggleable selection-modals so rows that should toggle/adjust do so through the correct modal contract rather than leaking help text into conversation
- Added per-row numeric adjustment metadata for modal rows, including decimal step/clamp/precision support
- Fixed config/settings adjustments so `wrfc.scoreThreshold` now changes by `0.1`, clamps to `0.0–10.0`, and uses `Shift+Left/Right` for larger jumps
- Fixed slash-command modal dismissal so pressing `Esc` fully closes the `/` menu, clears the slash prompt, and only reopens it when `/` is typed again

### Verification

- Renderer, panel, orchestrator, provider-stream, bootstrap-service, and orchestration lifecycle regressions were expanded to lock the new behavior
- Full suite passes in release state
- Full typecheck passes: `bun x tsc --noEmit --pretty false`

## [0.15.2] — 2026-04-08

### UI System Rollout And Panel Layout Centralization

- Continued the shared UI design-system rollout across renderer, panel workspace, and modal surfaces with stronger shared glyph, tone, and posture/list/detail presentation rules
- Centralized common panel scroll-budget logic into the shared workspace layer so panels stop guessing visible rows with panel-local `height - N` math
- Migrated the broader panel set onto shared budgeting and fixed bottom-row clipping so the selected final row remains visible instead of disappearing beneath the footer

### Modal Stack, Search Focus, And Toggle Behavior

- Repaired nested modal backstack behavior so `Esc` unwinds to the previously open modal instead of flattening the stack
- Fixed slash-command modal restoration so modal handoffs launched from `/` return to the actual slash-command menu
- Fixed slash-command close behavior so pressing `Esc` on the `/` menu fully dismisses command mode, clears the slash prompt, and keeps later typing in normal prompt mode
- Reworked searchable modal focus ownership so search/filter rows can be explicitly focused and typable hotkeys continue working when list focus owns input
- Added real row-level adjustable modal behavior for toggleable selection modals:
  - `Space` / `Enter` perform the selected row's primary action
  - `Left` / `Right` adjust booleans, enums, and numeric values in place
  - `Shift+Left` / `Shift+Right` change numeric values in steps of `10`
- Fixed settings/config and other toggleable modals so they no longer dump help text into the main conversation when a row should toggle inline

### Panel Integration Wiring

- Wired Explorer -> Preview so selecting a file in the file explorer can open it in the preview pane directly from panel focus
- Wired Preview -> Symbols synchronization so the symbol outline updates from the active previewed file
- Wired Symbols -> Preview jumps so selecting a symbol can move the preview pane to the symbol location
- Wired approval-panel activation so `Enter` on the selected approval row executes the actual review action instead of only describing it

### Markdown And Transcript Rendering

- Fixed tracked assistant-message markdown rendering so pipe tables render in the main conversation path, not just in the standalone markdown renderer
- Added tolerant table parsing for slightly malformed LLM-generated alignment rows, allowing real-world model output to render as tables instead of falling back to plain text

### Token Accounting And Streaming Visibility

- Fixed live thinking-strip output token growth so it continues to advance even when `display.stream` is disabled
- Added immediate current-turn input estimation for the thinking strip so live `in` values do not remain `0` until the provider response completes
- Normalized provider usage at the orchestrator boundary so fresh input tokens and cache-read tokens are separated correctly for UI display
- Fixed footer/token-surface accounting so cache-read traffic is no longer double-counted inside `Input` while context occupancy still reflects the full prompt footprint

### Verification

- Typecheck passes: `bun x tsc --noEmit --pretty false`
- Focused orchestrator/shell/token suites pass after the token-accounting changes

## [0.15.1] — 2026-04-08

### UI Systems, Routing, And Renderer Hardening

- Added an explicit shared Unicode glyph registry for renderer primitives, including canonical frame, surface, navigation, status, and meter glyphs
- Added shared low-level text/layout helpers for hanging-indent wrapping and label/detail column fitting, with width-band overlay behavior and more deterministic modal geometry
- Restored and locked the intended Unicode-heavy visual language across shared shell, conversation, modal, process, and panel renderer paths
- Restored half-height message surfaces, block cursors, modal/search glyphs, and canonical status/selection markers after ASCII/raw-character regressions
- Added a UI release-gate test to lock canonical glyphs, routing defaults, panel focus behavior, transcript-event navigation, and overlay width-band behavior

### Conversation, Routing, And Navigation

- Added transcript event-family navigation so the conversation surface can jump to the next or previous matching event line instead of acting like raw scrollback only
- Improved conversation rendering around event rows, collapsed fragments, footer posture, and line-number behavior
- Added routing defaults so non-conversational system and operational chatter can land in dedicated workspaces instead of always polluting the main transcript
- Added line-number modes `all`, `code`, and `off`, with clipboard stripping so copied content does not carry visual gutters
- Fixed stale active-plan leakage so ordinary turns stop inheriting old plans across sessions
- Reworked startup/system-message routing so discovery and other low-priority runtime chatter has a proper panel destination

### Panels, Modals, And UI Focus Behavior

- Reworked panel open/focus behavior so shell-driven panel opens show and focus the panel workspace immediately
- Added deterministic modal focus restoration back to prompt, panel, or indicator regions after closing the last modal
- Added explicit modal search/list focus behavior so typable hotkeys remain available while list/body focus owns input
- Added shared overlay width bands and stable overlay metrics for narrow, medium, and wide terminal classes
- Improved heavy operational panels to lead with posture, issues, next actions, and detail sections instead of dumping raw inventories first
- Expanded the `System Messages` panel so startup and runtime operational messages have a proper panel destination and routing posture summary

### Settings Control Plane, Accounts, And Auth

- Deepened the settings control plane with effective-source review, managed staging/review, conflict reporting, failure reporting, and rollback history surfaces
- Added commands and panel support for staged managed changes, settings conflicts, sync failures, rollback history, and review-first application of managed settings
- Added richer provider-account posture surfacing, including active route, preferred route, freshness, fallback risk, route records, usage-window hints, and recommended actions
- Added auth inspection surfaces for provider auth/subscription posture and route visibility
- Added local-auth management surfaces and command/runtime integration for reviewing local users, bootstrap posture, auth-store state, password rotation, and auth-session state
- Fixed the shared daemon/listener auth bootstrap flow so both services use one shared local auth manager instead of generating conflicting bootstrap passwords

### Sandbox, Remote, And Session Continuity

- Productized the sandbox control plane around secure presets, doctor/probe flows, session-backed execution, guest bundle import/export, and QEMU setup/bootstrap/apply/inspect flows
- Added QEMU setup helpers including wrapper scaffolding, image creation support, guest bootstrap manifests, session recovery, and guest validation commands
- Deepened remote operator flows with capabilities, recovery, export/import of review artifacts, pool-aware dispatch, and control-room presentation
- Expanded session continuity with return-context metadata for tasks, approvals, remote contracts, worktrees, and open panel state

### Tasking, Intelligence, Health, And Guidance

- Expanded task/archetype productization with validation/review flows, richer metadata, and stronger task-panel surfacing
- Improved intelligence entry points with diagnostics, repair commands, and more explicit readiness/recovery presentation
- Continued deepening Health as the operator repair workspace across providers, auth, local services, remote, sandbox, and settings posture
- Added contextual guidance and session-maintenance posture tied to Health and token/return-context workflows

### Documentation, Verification, And Release

- Substantially rewrote the README to cover the current renderer architecture, operator control rooms, routing model, sandbox/QEMU flows, local auth, remote/runtime surfaces, line-number modes, return-context settings, guidance modes, and secret-storage policy
- Updated slash-command and architecture documentation to match the current product shape rather than the older pre-roadmap surfaces
- Renamed the `brief`, `question`, and `mcp_resource` tool surfaces to `packet`, `query`, and `mcp`, including the durable storage-file renames for `packet` and `query`, and removed the `powershell` tool from the built-in tool inventory
- Added regression coverage for modal focus restoration, UI primitives, shell panel openers, selection-copy behavior, transcript event navigation, and updated panel/control-room expectations
- Re-ran full typecheck and full test suite for the release state

### Verification

- Full suite passes: `6672 pass, 0 fail`
- Full typecheck passes: `bun x tsc --noEmit --pretty false`

## [0.14.2] — 2026-04-05

### Roadmap Completion

- Completed the full post-comparison roadmap implementation across hooks, MCP hardening, orchestration, operator surfaces, self-hosted remote, knowledge, and product breadth
- Finished the remaining Claude-led breadth gaps in a GoodVibes-specific way instead of copying hosted-service assumptions
- Ended the cycle with the codebase fully wired, type-clean, and release-gate clean

### Hooks, MCP, And Security

- Added canonical hook point contracts, broader lifecycle coverage, recent hook activity tracking, and managed hook workflow authoring surfaces
- Added per-server MCP trust modes, role/coherence review, quarantine and approval flow, settings-gated `allow-all`, and programmatic attack-path analysis
- Expanded proactive security tooling with policy lint, simulation, preflight review, richer permission prompt specialization, and a unified security control room

### Orchestration, WRFC, And Communication

- Added live orchestration graph state, bounded recursive spawn policy, graph/subtree cancellation, cockpit visibility, and richer task control surfaces
- Integrated WRFC loops into orchestration graphs and added explicit Gather / Plan / Apply evidence to engineer completion reporting
- Replaced the old lightweight agent bus assumptions with structured communication lanes, routing policy, runtime/store evidence, and operator-facing communication review

### Remote, Knowledge, And Product Breadth

- Added typed remote runner contracts, runner pools, portable remote replay/review artifacts, pool-aware dispatch, remote task sync, and broader `/remote` and `/tasks` command surfaces
- Expanded durable knowledge with typed scopes, policy/MCP/plugin/incident capture, review queue workflows, handoff/export flows, and explainable task-time knowledge injection
- Added broader setup, services, plugin, skill, incident, and security product operations including setup transfer bundles, curated ecosystem publish/install/update flows, incident export/capture, and auth-review/operator support flows

### Verification

- Full suite passes: `6404 pass, 0 fail`
- Full typecheck passes: `bun x tsc --noEmit --pretty false`
- No new production `any` typing was introduced
- No roadmap items remain from this implementation cycle

## [0.14.1] — 2026-04-05

### Runtime Hardening And Evidence Model

- Completed the `v6` runtime hardening program on top of the post-migration runtime substrate
- Added explicit terminal stop reasons, stricter turn lifecycle handling, guarded runtime transitions, and stronger replay confidence
- Added phase-ledger evidence, richer forensic bundles, replay mismatch triage metadata, and release-gate coverage for substrate, policy/budget, certification, and operator surfaces

### Operator Surfaces And Policy Tooling

- Added the shared runtime policy surface and operator-facing policy panel
- Expanded panel layout controls for placement, split visibility, focused pane switching, and pane resizing
- Strengthened runtime evidence and operator-facing controls without reintroducing compatibility layers or legacy runtime choreography

### Refactors And Cleanup

- Refactored the largest shell and runtime files into clearer modules:
  - extracted shared session persistence and crash-recovery helpers
  - decomposed bootstrap composition and background setup
  - reduced `commands.ts` to a thin registrar backed by focused command modules
  - split `handler.ts` into modal, routing, prompt-buffer, and shortcut helpers
  - split orchestrator responsibilities into cleaner turn, tool, and context helper layers
- Followed up with targeted cleanup in provider/model and tool modules, reducing duplication and tightening ownership boundaries
- Removed remaining internal compatibility debt that only preserved old shapes, stale migrations, and rollout-era wording

### Quality And Verification

- Eliminated remaining production `any` usage and restored a fully clean `tsc --noEmit` surface
- Fixed real issues uncovered by full-suite execution, including config reset contamination and several stale or flaky post-migration tests
- Finished the release in a state where the full suite and full typecheck both pass cleanly

---

## [0.13.1] — 2026-04-04

### Runtime Bus Migration Completed

The legacy runtime `EventBus` migration is now fully complete.

- Removed the legacy runtime bus from active production flow
- Deleted `src/core/event-bus.ts` and the legacy bus test surface
- Cut shell control flow over to store-backed state, typed runtime events, and direct controller callbacks
- Cut orchestrator turn, streaming, tool, agent, WRFC, provider, planner, permission, replay, plugin, notifier, and webhook flows over to `RuntimeEventBus`
- Removed compatibility relays for legacy runtime event families including submit, cancel, permission, session resume, plan activation, WRFC, and subagent lifecycle
- Reworked replay and notification plumbing to use typed runtime event names and typed runtime subscriptions only
- Completed runtime context cleanup so production composition is `RuntimeEventBus` + store based

### Store And Runtime Substrate Hardening

- Made `DomainDispatch` concrete and store-owned instead of placeholder-only
- Wired real typed runtime domains into dispatch and reducer paths
- Removed ad hoc runtime `store.setState()` mutation patterns from migrated runtime consumers
- Added enforcement coverage for typed emission rules, shell-control cutover, and store-write discipline

### Panels, Providers, And Workflow Wiring

- Migrated turn-observing panels to typed turn/tool/provider/planner/workflow subscriptions
- Moved WRFC, provider fallback, provider discovery, planner override, and monitoring panels onto typed runtime contracts
- Removed legacy render-loop invalidation from migrated panels in favor of shell-owned render callbacks and state-driven updates

### Docs Updated To Final State

- Updated the `docs/big-update` migration package to reflect the completed end state
- Marked older EventBus migration inventories as historical references
- Updated architecture and README documentation to describe the current runtime model accurately

### Verification

- Focused migration and regression suites passed during the cutover
- Documentation now matches the production runtime architecture

---

## [0.12.3] — 2026-04-03

### State Machine Runtime v3 — Complete Implementation

Full implementation of the post-v3 runtime blueprint across 9 phases, ~52,000 lines.

#### Phase 0: v3.1 Completion
- SLO gates with p95 metric collection and budget tracking
- Tool output policy with size limits and truncation
- Permissions simulation dry-run mode
- Idempotency store with SHA-256 keys, TTL eviction, deterministic turn/tool dedup
- Snapshot retention with 3-class pruning, injectable clock/pruner, path traversal protection
- Provider capability registry with routing decisions

#### Phase 1: P0 Hardening
- Shell AST normalization with recursive-descent parser, per-segment verdicts, 8 obfuscation detectors
- Fetch sanitization with host trust tiers, SSRF detection, response sanitizer modes
- Policy signing with HMAC-SHA256 composite signatures, provenance on every PermissionDecision
- Unresolved tool result reconciliation with synthetic error results and stop-reason enforcement

#### Phase 2: Architecture Hardening
- Domain import boundary enforcement with read matrix and bidirectional drift detection
- Typed emission enforcement blocking raw bus.emit() outside approved wrappers
- Cascade SLO with timing instrumentation, severity derivation, playbook-to-cascade mapping
- Runtime budget enforcement with monotonic timing, time/token/cost limits
- Output schema fingerprints with SHA-256/FNV-1a hashing, canonical shape IDs
- Overflow backend retention with pluggable spill backends, path traversal guards
- Divergence dashboard with enforce gate threshold and trend history
- Tokenizer fuzz guards with MAX_INPUT_LENGTH (64K) and MAX_TOKEN_COUNT (1024)

#### Phase 3: Operator Control + HITL
- Operator Control Plane with task cancel/pause/resume/retry, agent cancel, typed audit events
- Adaptive Execution Planner with strategy scoring, /plan commands, OpsStrategy panel
- HITL UX Modes with quiet/balanced/operator presets, per-domain verbosity, status bar badge

#### Phase 4+5: Replay, Forensics, Policy, Tool Contracts
- Deterministic Replay engine with load/step/seek/diff/export, path traversal guard
- Failure Forensics with auto-classification, causal chain builder, bounded tracker maps
- Compaction Quality Scoring with weighted composite, auto-strategy escalation
- Policy-as-Code with versioned bundle registry, simulation-gated promotion pipeline
- Tool Contract Verification with 5-dimension checker, fail-closed registration

#### Phase 6: Eval + Provider
- Evaluation Harness with 5-dimension scorecard, deterministic benchmarks, CI gate
- Provider Optimizer with capability-contract-driven routing, auto/manual/pinned modes

#### Phase 7: Memory, Sessions, Trust
- Project Memory Substrate with SQLite store, 4 durable classes, provenance links, /recall commands
- Multi-session Orchestration with cross-session task graph, BFS cycle detection, scoped cancellation
- Extension Trust Framework with trust tiers, HMAC-SHA256 timing-safe signatures, quarantine

#### Phase 8: P1 Hardening
- Transport compatibility matrix with version negotiation and downgrade reason codes
- MCP schema drift quarantine blocking tool execution on stale schemas
- Adaptive notification suppression with mode-context and burst policies
- Integration delivery SLO with retry/backoff, dead-letter queue
- Token scope and rotation audits with managed-mode blocking
- Panel resource contracts with two-tier throttle/degrade escalation
- Actionable diagnostics controls with permission-gated dispatch
- State inspector time-travel with circular timeline buffer and hotspot sampler

#### Phase 9: Release Gates
- 5 release gate suites (Safety, Determinism, Performance, Operability, Product Quality) with 130+ integration tests
- Runner script for CI gate enforcement

### Context Window Discovery
- Multi-provider context window discovery with verbose-first endpoint probing
- LM Studio, Ollama, vLLM, llama.cpp, TGI support
- Agent orchestrator context window awareness with proactive compaction at 85% threshold
- Model picker context cap UI: press Space on local models to set custom context window

### Bug Fixes
- Fixed cancelled agent respawn race condition (cancelled agents no longer re-trigger WRFC chains)
- Fixed multi-line input history navigation (up-arrow on line 0 now navigates to previous entry)
- Fixed duplicate model switch confirmation message
- Fixed /provider command collision (optimizer renamed to /provider-opt)
- Fixed /panel list to open picker instead of printing to conversation

### System Message Routing
- SystemMessageRouter with high/low priority classification and auto-classification by content pattern
- SystemMessagesPanel with word-wrap, color-coded priority, keyboard scroll, 500-message cap
- All `addSystemMessage` calls in bootstrap.ts and main.ts routed through the router (WRFC→high, agent lifecycle→low, memory→high, model switches→high, errors→high, scan/discovery→low)
- `setPanel()` for late binding; `@internal classifyPriority` for testability
- High-value messages appear in both conversation and panel; low-value messages panel-only
- 32 tests covering classification, routing, auto-classify, panel push, null-panel edge cases

---

## [0.12.2] — 2026-04-02

### Cohort Completion Fix
- Cohort completion now waits for full WRFC chains to finish (review + fix cycles), not just the engineer agent
- Previously, cohort-complete fired as soon as the engineer agent finished, before the reviewer/fixer had run

### Test Fixes
- Fixed settings modal and input handler test suite failures introduced by modal navigation stack
- Fixed renderer/settings-modal test assertions after viewport overlay changes

---

## [0.12.1] — 2026-04-02

### Feature Flag Settings Modal
- `/settings` modal now includes a Feature Flags tab for all 8 runtime feature flags
- Toggle flags on/off at runtime; changes persist to `.goodvibes/config.json`
- Modal navigation stack: Escape now navigates back through modal history instead of immediately closing
- Settings modal viewport overlay fix: modal correctly fills viewport without layout bleed
- Modal-factory list item border fix: border rendering corrected for list items in all modals

---

## [0.12.0] — 2026-04-02

### Session Compaction v2 (Tier 6)
- 5 compaction strategies: microcompact, collapse, autocompact, reactive, and boundary commit with lineage
- Boundary commit strategy persists compaction lineage across sessions for traceable context history
- Resume repair pipeline: detects and repairs broken session state on resume

### OTel Export Reliability (Tier 6)
- ExportQueue with bounded ring buffer — telemetry spans are never lost under export backpressure
- OtlpExporter with batch export: spans are batched and exported on flush or queue threshold
- Combined with the lightweight tracer/meter from Tier 4: full OTel-compatible pipeline with no SDK dependency

### Ops Playbooks (Tier 6)
- 5 machine-readable runbooks covering provider outage, memory pressure, plugin crash, MCP disconnect, and compaction failure

### Model Picker Data Surface (Tier 7)
- Enriched model picker entries with live health status, latency percentile stats, and fallback chain visualization
- Health status sourced from RuntimeHealthAggregator; entries marked degraded or unavailable in real time

### State Inspector (Tier 7)
- New diagnostics panel: domain-filtered Zustand store snapshots
- Bounded transition log (last 200 entries) with timestamp, domain, and change summary
- Subscription tracking: shows which UI components are subscribed to each domain slice

### Event Contracts (Tier 7)
- 16 runtime event validators covering all domain event modules
- Validators enforce discriminated union invariants at the EventBus dispatch boundary

### UX Anti-Regression Tests (Tier 7)
- 55 tests across 5 suites covering modal navigation, settings persistence, model picker enrichment, state inspector rendering, and event contract validation

---

## [0.11.0] — 2026-04-02

### Plugin Lifecycle (Tier 4)
- 8-state plugin lifecycle machine: unloaded → loading → loaded → activating → active → deactivating → inactive → error
- Deny-by-default capability manifests: plugins declare required capabilities at load time; missing capabilities block activation
- Safe hot reload protocol: deactivate → unload → reload → activate with rollback on failure

### MCP Lifecycle (Tier 4)
- 7-state MCP server lifecycle machine: disconnected → connecting → connected → ready → degraded → reconnecting → failed
- Per-server permissions: MCP servers declare tool capability requirements in `mcp.json`
- Schema freshness tracking: detects and re-fetches stale tool schemas without full reconnect

### OTel Foundation (Tier 4)
- Lightweight tracer and meter implementing OTel-compatible interfaces — no OTel SDK dependency
- Turn spans, tool spans, and LLM request spans with structured attributes
- Local JSON lines ledger exporter for offline telemetry review

### Diagnostics (Tier 4)
- Data providers for 6 panel types: health, provider stats, plugin state, MCP state, task queue, and telemetry

### Remote Substrate (Tier 5)
- Transport contracts for remote agent connections with pluggable backend
- ReconnectEngine with exponential backoff and message replay on reconnect
- DurableIdentityManager: stable agent identity across disconnects
- RemoteStateSyncer: reconciles local Zustand store with remote state on reconnect

### OTel Lifecycle Instrumentation (Tier 5)
- 9 span creators covering session, tool, agent, MCP, plugin, compaction, LLM, permission, and task domains
- DomainBridge: automatically creates and closes spans from domain event emissions — no manual span management required

### Security Tests (Tier 5)
- 4 suites: permission bypass attempts, command injection vectors, plugin capability escalation, path traversal
- All 4 suites at 100% pass rate against the Tier 2 permission and Tier 4 plugin systems

### Chaos Tests (Tier 5)
- 5 suites: provider failures under load, hook execution failures, MCP reconnect under message loss, plugin crash and recovery, health cascade propagation
- Validates the CascadeEngine, ReconnectEngine, and plugin lifecycle machine under adversarial conditions

### Performance Budgets (Tier 5)
- 5 perf budgets: store update latency, event dispatch latency, tool execution overhead, compaction duration, and startup time
- PerfMonitor samples against budgets at runtime; CI gate script fails the build if any budget is exceeded

---

## [0.10.0] — 2026-04-02

### Zustand Runtime Store (Tier 0)
- Zustand vanilla store (no React dependency) as the single source of truth for all runtime state
- 19 domain slices: session, model, conversation, overlays, panels, permissions, tasks, agents, providerHealth, mcp, plugins, daemon, acp, integrations, telemetry, git, discovery, intelligence, uiPerf
- Typed selectors for all 19 domains with memoization

### Runtime Event System (Tier 0)
- 12 domain event modules with discriminated unions (no stringly-typed events)
- RuntimeEventBus with domain-scoped subscriptions and typed emission wrappers
- Immutable event envelope factory with correlation IDs for cross-domain tracing

### Runtime Health (Tier 0)
- RuntimeHealthAggregator: derives composite health from all domain slices
- CascadeEngine with 8 declarative cascade rules: health degradation in one domain can suppress or alter behavior in dependent domains
- Partial degradation model: the system continues operating in a reduced state rather than failing completely

### Bootstrap Composition Root (Tier 0)
- Extracted initialization logic from `main.ts` into a typed bootstrap composition root
- Initialization order is explicit and dependency-checked at startup

### Feature Flags (Tier 1)
- 8 feature flags: `phasedTools`, `layeredPermissions`, `unifiedTasks`, `notificationRouter`, `pluginLifecycle`, `mcpLifecycle`, `remoteSubstrate`, `otelExport`
- Each flag supports enable/disable/kill lifecycle — kill permanently disables a flag for the session
- `runtimeToggleable` enforcement: flags that cannot be toggled after initialization are locked on first use
- Subscriber pattern for reactive flag-change propagation
- Audit log: all flag changes recorded with timestamp and caller context

### Phased Tool Executor (Tier 1)
- 6-phase execution pipeline: validate → prehook → permission → execute → map → posthook
- AbortController-based cancellation at every phase boundary
- Per-phase timeouts with configurable defaults
- Execution records: every tool invocation produces a structured record with phase timings
- All 6 core tools wrapped with PhasedTool metadata; ToolRegistryBridge enables gradual rollout alongside existing tools

### Permissions v2 (Tier 2)
- LayeredPolicyEvaluator with 5-layer priority stack: safety → mode → session → policy → default
- 19 decision reason codes for auditability
- Safety layer is bypass-immune: deny decisions from the safety layer cannot be overridden by higher layers

### Command Normalization (Tier 2)
- Shell command tokenizer, segmenter, canonicalizer, and classifier
- Normalizes shell syntax variations before permission evaluation

### Compatibility Contracts (Tier 2)
- Schema versioning for 5 domains: config, session, agent, plugin, mcp
- MigrationRegistry with pathfinding: finds the shortest migration path between any two schema versions

### Error Propagation (Tier 2)
- HealthStoreWiring connects the RuntimeHealthAggregator to the CascadeEngine, effect handlers, and EventBus
- Health degradation automatically triggers cascade rules and emits typed health events

### Task Unification (Tier 3)
- UnifiedTaskManager: single lifecycle state machine for all task types (process, agent, ACP, scheduled)
- Retry with exponential backoff and configurable max attempts
- Parent/child task tracking for WRFC chain visibility
- 4 task adapters: ProcessTaskAdapter, AgentTaskAdapter, AcpTaskAdapter, SchedulerTaskAdapter

### Notification Router (Tier 3)
- NotificationRouter with 3-layer policy stack: global → domain → per-notification
- Per-domain verbosity configuration
- Batch collapsing: repeated notifications of the same type are collapsed into a single summary

### Contract Tests (Tier 3)
- 128 tests across 6 suites covering event contracts, permission contracts, task lifecycle contracts, tool phase contracts, notification routing contracts, and health cascade contracts

---

## [0.9.16] — 2026-04-01

### Provider Caching Strategy Layer
- Multi-breakpoint prompt caching for Anthropic: BP1 system+tools (1h TTL), BP2 conversation prefix (5m), BP3 largest tool result (5m), BP4 dynamic
- Prompt-caching beta header (`prompt-caching-2025-04-14`) auto-added when extended TTL breakpoints are placed
- Provider cache capability registry covering 13+ providers: explicit (Anthropic, Gemini), automatic (OpenAI, DeepSeek, Groq, Fireworks, Together), implicit (Ollama, LM Studio, vLLM, llama.cpp, SGLang), none (Mistral)
- Session affinity header injection for Fireworks (`x-session-affinity`) and compatible providers
- Shared CacheHitTracker across all providers with consistent hit rate formula
- CachePlanner with LLM-assisted strategy optimization via helper model
- Cache-aware context compaction: invalidates strategy on message restructuring
- Cache hit rate monitoring with configurable warning threshold
- `cache:metrics` and `helper:usage` events on the event bus

### Helper Model Foundation
- HelperRouter with 4-step resolution: per-provider helper → global helper → tool LLM → main model fallback
- HelperModel singleton with never-throw contract and separate usage tracking
- `helper.enabled` config properly gates helper routing (disabled = main model only)
- First use case: LLM-assisted cache breakpoint planning for explicit-caching providers
- Config: `cache.*` (enabled, stableTtl, monitorHitRate, hitRateWarningThreshold) and `helper.*` (enabled, globalProvider, globalModel)

---

## [0.9.15] — 2026-03-30

### Context Compaction v2
- Hybrid structured compaction: deterministic framework + targeted LLM extraction calls
- 10 discrete sections with per-section token budgets (handoff header, session memories, current task, running agents, recent conversation, tool results, agent activity table, older agent summary, resolved problems, plan progress, session lineage)
- Session memory system: `!#` prefix pins messages for the session, `/memory` command to list/add/remove
- Session lineage: append-only micro-log that survives compaction without degradation
- Context-window-aware thresholds: >=500k at 80%, 128k-500k at 75%, <128k at 65%
- LLM extraction calls parallelized with Promise.all
- Post-compaction validation checks critical sections
- Multi-turn coherence: user-assistant pairs kept together during filtering
- Empty sections omitted to save tokens
- Backward-compatible v1 legacy path preserved

### Provider System
- Provider alias mapping: catalog IDs that differ from registered names resolved via PROVIDER_ALIASES
- InceptionLabs/Mercury: 'inception' catalog ID maps to 'inceptionlabs' provider
- Alias fallback in registry.get() with 3 tests

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
