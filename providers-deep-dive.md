# Deep Dive: Provider & Model Subsystem (synthetic models, intelligent failover)

**Generated**: 2026-06-11 ~20:50 | Read-only architecture dive

## Headline
Best-in-class infrastructure and display, with the failover decision NEVER CONNECTED TO EXECUTION. E11 (provider failover policy) is ~70% built and ~0% executed on the live turn path.

## Scores
| Dimension | Score |
|-----------|-------|
| Abstraction coherence | 8/10 (clean SDK boundary, narrowed Pick<> interfaces; docked for two parallel health-status type models) |
| Synthetic feature completeness | 7/10 (picker thoughtful ×6 special-cases; headless CLI ×0; intra-synthetic failover unsurfaced) |
| Failover correctness + UX | **3/10** (optimizer constructed enabled:false; TURN_ERROR → red badge only, no recovery) |
| Picker UX | 8/10 (family detection, benchmark sort, synthetic sub-grouping; 798-line file) |
| Test coverage | 8/10 (dense SDK-unit suites; zero integration tests asserting the turn path triggers failover — because it doesn't) |

## What a synthetic model actually is
A real model served through the SDK SyntheticProvider (synthetic.new-style aggregator): tier-scoped (free/paid), resolves to a sorted ladder of real backends (context desc, then maxOutput), skips keyless backends, and fails over to the next backend in-tier on 429 — INSIDE the SDK, working and tested. The picker handles synthetic correctly six ways (availability-bypass, sub-grouping "Top Models"≥.65 composite, catalog-score lookup instead of ZeroEval, etc.). Gaps: `goodvibes models` headless CLI has ZERO synthetic awareness (looks like a normal model), and the fallback-chain UI renders synthetic as one opaque node — the most interesting failover behavior in the product is invisible.

## The failover truth
Two disconnected mechanisms:
1. **Intra-synthetic (SDK): real and working** — 429 → next backend in tier.
2. **Cross-provider optimizer (SDK built, TUI displays, never fires):** `services.ts:533` constructs ProviderOptimizer with **enabled:false**. `/provider route auto` prints "no-op until optimizer is enabled" — and there is no discoverable enable besides `/provider pin`. On a live TURN_ERROR the entire response is a status badge with a 60s cooldown (`provider-health-tracker.ts:45`). No route(), no chain advance, no retry, no cost notice. Composite degradation data (`degradedCount`, `hasUnhealthyNode`) is computed and display-only. Zero turn-path consumers of optimizer/fallback anywhere in runtime/** or shell/** — verified by exhaustive grep.

## Confirmed unfinished decisions (the session pattern, 6 more instances)
1. Optimizer built/tested, constructed disabled, never consulted at turn time — CONFIRMED
2. `/provider route auto` is a documented no-op — CONFIRMED
3. Context-window resolution computed (ModelLimitsService) but never enforced/rerouted on oversized turns — PARTIAL
4. Health enrichment displayed, never consulted by any failover choice — CONFIRMED
5. Fallback chains visualized, not executable from the TUI — CONFIRMED
6. Synthetic parity: picker 6 special-cases vs headless CLI 0 — PARTIAL

## Findings
1. HIGH `services.ts:533` — optimizer enabled:false, no turn-path call site. Fix: wire optimizer.route()/next-chain-node into turn dispatch. Effort L.
2. HIGH `provider-health-tracker.ts:45` — TURN_ERROR → badge only. Fix: on error with optimizer enabled, attempt next viable node before surfacing. Effort M.
3. MED `provider.ts:90` — dead-end no-op route command. Fix: `/provider optimizer on|off` + panel state. Effort S.
4. MED `management.ts` — zero synthetic columns headless. Fix: tier/backends/composite columns. Effort S.
5. LOW `fallback-visualizer.ts:42` — synthetic = opaque node. Fix: nest resolved backend ladder. Effort M.
6. MED `provider-health/types.ts:131` — degradation data display-only. Fix: failover consults composite health. Effort M.
7. LOW `provider-health-tracker.ts:1` — duplicate ProviderStatus union vs SDK. Fix: converge. Effort S.

## Execution track (slots after Wave 2 lands — builds on TASK-009's TURN_ERROR handler)
E11-1: optimizer enable + visibility (S) → E11-2: turn-path failover wiring (L) → E11-3: failover event notice w/ cost delta (S-M) → E11-4: synthetic CLI parity (S) → E11-5: context-window enforcement (M) → E11-6: nested synthetic chain UI (M) → E11-7: health type convergence (S).

## Note
The dive agent received stray runtime <gv> directives mid-analysis (a complete + a spawn-reviewer against its read-only run) and correctly declined to act — logged as further plugin-noise evidence (not TUI scope).
