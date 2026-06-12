# Deep Dive: Agent Execution Substrate

**Generated**: 2026-06-11 ~21:10 | Scores: lifecycle 8, observability 7, control 5, cost accuracy 4, tests 8

## Headline findings
- **F-COST-01 (HIGH)**: `getCostFromCatalogForPanel` is a dead stub returning {input:0, output:0} — the "catalog" pricing tier never resolves; everything falls to a hardcoded MODEL_PRICING table; unknown/new models silently cost $0.
- **F-CTRL-01 (HIGH)**: cancel exists end-to-end in the SDK and is correct — but reachable from ONLY the WRFC panel. Agents spawned via automation/shared-session/direct are observable but uncancellable from any UI.
- **F-OBS-01 (MED)**: agent-detail-modal fabricates token counts (`toolCallCount * 400`) while the cost-tracker holds REAL per-agent token counts — two sources of truth, one invented.
- **F-WATCH-01 (MED)**: stall detection is WRFC-chain-only; bare runaway agents have no watchdog anywhere (cf. the 326MB runaway log incident).
- **F-COCKPIT-01 (MED)**: UiCockpitSnapshot has no per-agent roster, no cost/token aggregate, no action bindings — the three things F2 most needs. Cockpit is a dashboard, not a control surface.

## F2 cockpit readiness
Overwhelmingly read-model + UI wiring, NOT new machinery: SDK already exposes list/getStatus/cancel + runtime-bus events. Gap table: roster slice (missing, source exists), per-agent tokens (siloed in cost-tracker), session cost (computed, unsurfaced), stalled-agent count (logic exists for chains only), action bindings (none).

## F2 track (prioritized)
1. Agent roster + cost/token aggregate into UiCockpitSnapshot (read-model slice) | HIGH
2. Fix cost attribution first (implement catalog lookup or delete dead tier + document table as authoritative) — else cockpit shows $0 | HIGH
3. Generalize cancel: inspector + cockpit action bindings | HIGH
4. Unify token reporting (kill the *400 estimate) | MED
5. Per-agent stall watchdog + stalledAgentCount in snapshot | MED
6. Cockpit action keys (inspect/cancel) | MED
7. Tests: pricing fallback + per-agent stall | LOW

Surfaces: services.ts (read-models), cockpit-panel.ts, ui-read-models.ts, agent-inspector-panel.ts, cost-tracker-panel.ts, agent-detail-modal.ts.
