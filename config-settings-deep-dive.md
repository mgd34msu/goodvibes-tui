# Deep Dive: Config & Settings

**Generated**: 2026-06-11 ~21:20 | Scores: precedence 6, validation 7, live-apply honesty 5, settings UX 6, tests 7

## The live-review question, answered
Does the showTokenSpeed default-flip respect explicit user false? YES for GLOBAL settings — main.ts:140 uses applyRuntimeConfigDefault (not Value), which re-reads raw settings.json from disk and yields to any present key. Correct, well-commented. BUT: it only checks the GLOBAL configPath — a PROJECT-scoped explicit false IS silently overridden (config-overrides.ts:79). Real precedence bug.

## Findings
1. Project-scoped explicit values ignored by default-flips (config-overrides.ts:79) | HIGH | check both persisted files | S
2. Two un-unified provenance systems: SDK deepMerge destroys layer origin; settings-sync layer (effectiveSource default/local/synced/managed) reconstructs it separately — modal knows, startup code doesn't | MED | track provenance at merge | M (SDK)
3. Restart-required detection is a keyword heuristic on the dot-path's 2nd segment (host/port/hostMode/enabled) — lies for anything else (settings-modal.ts:757) | MED | requiresRestart field on ConfigSetting schema | M
4. isDefault uses reference equality (settings-modal.ts:641,748,779) — modified ◇ indicator always-on for object/array defaults | MED | deep equality | S
5. NO SEARCH in settings modal — 40+ categories, exact-match selectTarget only. Biggest UX gap | HIGH | fuzzy filter across key+label+description | M
6. No reset-all/reset-category (SDK reset() exists unwired) | LOW | confirm-gated affordance | S
7. Stray top-level keys in settings.json silently kept-then-ignored | LOW | warn on unknown keys | S
8. display.* vocabulary accretion: show* prefix consistent except display.stream; theme mixed in | LOW | rename pass pre-1.0 | S

## Genuinely good
Source/modified/lock indicators exceed VS Code in provenance surfacing; real validation (typo'd CLI key → ConfigError); live-apply genuinely works; rich per-setting docs; network restarts surfaced honestly.
