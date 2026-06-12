# Deep Dive: WRFC in goodvibes-tui

**Generated**: 2026-06-11 20:25 | Scope: the TUI's own WRFC system (SDK consumption layer) — NOT the Claude Code plugin

## Architectural boundary (decisive for everything below)
The WRFC ENGINE (state machine, score parsing, fix loops, gates, auto-commit) lives in the SDK (`@pellux/goodvibes-sdk/platform/agents` → WrfcController). The TUI owns only the consumption layer: wiring (runtime/services.ts:338), the input guard/router (tools/wrfc-agent-guard.ts), event→system-message surfacing (runtime/bootstrap-core.ts → system-message-router), and a READ-ONLY monitor panel (panels/wrfc-panel.ts).

## Lifecycle (as implemented)
agent tool invocation → wrfc-agent-guard normalizes (collapses role-decomposed batches into ONE authoritative owner chain; forces reviewMode wrfc) → SDK createChain → engineering → reviewing (threshold default 9.9, maxFixAttempts 3) → pass→gates→auto-commit→passed | fail→fixing→reviewing… → failed after max attempts. TUI surfaces WORKFLOW_* events as typed 'wrfc' system messages (error-navigable) + wrfc-panel (state, score sparkline, cycles, constraints, gates, issues).

## Subsystem Scores
| Dimension | Score |
|-----------|-------|
| Process correctness | 9.0/10 (SDK contract well-tested; guard's batch-collapse design is strong) |
| Reliability | 6.5/10 (no chain persistence; no TUI safety net for SDK-delegated triggers/watchdogs) |
| UX visibility | 6.0/10 (good observability; ZERO control affordances) |
| Test coverage | 8.0/10 (SDK contract excellent; TUI panel/wiring thin) |

## Findings
1. **CRITICAL — No chain persistence / crash recovery.** Chains are in-memory in WrfcController; atomic-write.ts exists but unused for WRFC. Crash mid-chain = chains vanish, no resume. Fix: snapshot on WORKFLOW_STATE_CHANGED via atomic-write; rehydrate on boot (surface "interrupted" even before full SDK resume support). Effort M (TUI) / L (SDK).
2. **MAJOR — No cancel/resume in any UI.** wrfc-panel handles only up/down/enter; controller dep is Pick<…,'listChains'>. SDK exposes resumeChain + agent cancel. Fix: widen deps; add c=cancel / r=resume with confirm. Effort M.
3. **MAJOR (SDK) — Phantom-pass vector.** extractPassedFromText returns true on "passed"/"approved" prose even when score < threshold (proven by SDK test fixtures). Fix in SDK: score≥threshold as hard precondition. Effort S.
4. **MAJOR (SDK) — Phantom-work trust.** Review trusts engineer-claimed filesModified; no disk verification anywhere (mirrors the failure we observed live in the plugin tonight). Fix in SDK: pre-review disk-stat/git-diff gate; TUI surfaces "claims unverified" badge. Effort M.
5. MINOR — Guard intent heuristics (regex isImplementationLikeTask) can silently mis-route tasks into/out of WRFC. Add telemetry message on every guard flip. S.
6. MINOR — wrfc-panel syncFromController catch{} masks real failures as "no chains". Distinguish uninitialized vs threw. S.
7. MINOR — Early-boot race: WORKFLOW_* events before router attach are dropped, not queued. Buffer + flush on attach. S.
8. MINOR — TUI surface tests thin (panel rendering, constraint badge, narrow-width). M.

## Best-in-class priority
1. Chain persistence + crash recovery (#1)
2. Cancel/resume affordances (#2)
3. SDK hardening: phantom-pass + phantom-work (#3, #4) — SDK repo work, queue for the next SDK session
4. Guard observability + early-event buffering (#5, #7)
5. Panel test coverage (#8)

## Immunity vs failure modes observed live tonight (in the plugin)
| Mode | TUI verdict |
|------|-------------|
| Missed review triggers | Largely immune (SDK synchronous bus, tested) — add staleness watchdog for belt+suspenders |
| Phantom-work acceptance | NOT immune (#4) |
| Silent agent death | Partially immune (explicit AGENT_FAILED handled; silent hangs have no watchdog) |
| Runaway logs | Immune (MAX_MESSAGES=500 bounded buffer) |
