# Deep Dive: Context Management UX

**Generated**: 2026-06-11 ~21:15 | Scores: visibility 7, predictability 3, control 3, recovery 2, tests 7

## Headline: the engine is ~80% built; THREE wires are cut
1. `autoCompactEnabled` HARDCODED false in evaluateSessionMaintenance + SDK `checkAndCompact` never called in production (0 grep hits outside tests) — the entire auto-compaction machine exists and is dead-wired off. Every status message appends "Auto-compact is currently disabled; use /compact".
2. `compactThreshold` is plumbed main.ts:538 → ui-factory:143 … and never used — the meter's color thresholds are unrelated hardcoded 60/85, so the user can't see where compaction would trigger.
3. Compaction events + lineage (branchReason 'compaction', lastCompactedAt, counts) are fully persisted — with NO UI to browse or restore. Recovery substrate exists, recovery UX doesn't.

Plus: THREE independent token estimators (main.ts display counter, SDK estimateConversationTokens for maintenance, context-inspector's own walker) that can disagree on screen.

## What's already good
Persistent status-line context meter (bar + tokens + % with color grading) — ahead of expectations; rich per-message Context Inspector; 6-level maintenance ladder (stable→watch→suggest-compact→90% needs-repair) with solid engine tests (900+ lines).

## E7 track (recommended order)
E7-1 unify the three estimators onto SDK estimateConversationTokens (S) → E7-2 draw the compact threshold ON the meter, color switches at threshold (S) → E7-4 promote suggest-compact/needs-repair to passive status-line hint (S-M) → E7-3 compaction preview + before/after notice w/ confirm (M, may need SDK dry-run surface) → E7-5 make threshold+auto-compact real & configurable (behavior.autoCompact*), wire checkAndCompact behind flag (M, coordinate with E11-5) → E7-6 compaction history + restore UI (M-L, SDK branch/restore) → E7-7 pin/preserve selection UI (M, SDK pin API).
