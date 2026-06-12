# Deep Dive: Session Lifecycle

**Generated**: 2026-06-11 ~20:35 | Scores: data-model 6, durability 5, resume fidelity 6, command UX 5, tests 8

## Headline findings

### P0 — Recovery-delete footgun (DATA LOSS)
`src/shell/blocking-input.ts:91`: after a crash, ANY keystroke that isn't Ctrl+R/Esc/Ctrl+C silently DELETES the recovery file ("Ignored… starting new prompt" → deleteRecoveryFile()). One accidental keypress = permanent transcript loss. Fix: never delete on the ignore path; require explicit discard. Effort S.

### P0 — The /session duplicate registration is still structurally unfinished
commands.ts:110 registers session-workflow's command; commands.ts:127 registers session.ts's — last-write-wins meant the workflow registration was DEAD code, working only because session.ts's default: fallthrough delegates to handleSessionWorkflowCommand. The TASK-003 rename (session-mgmt) removed the collision but not the structural muddle: lifecycle ops reachable only via fallthrough, orchestration first-class. Proper fix: single registration with explicit routing, and decide whether the cross-session task DAG (link/handoff/graph — genuinely well-implemented, 40 tests, cycle detection) is its own command. Effort S-M.

### Other findings
- F3: Ctrl+R recovery restores messages ONLY — drops title + returnContext/panels that the snapshot captured; /session resume restores all. Unify hydrate paths. (S-M)
- F4: Session writes go through SDK SessionManager — NOT the TUI's atomicWriteFileSync; durability unverifiable from this repo. → SDK handoff. (M)
- F5: Zero schema versioning on session/recovery files (returnContext already evolving). (S)
- F6: NO CLI lifecycle flags — no --continue/--resume/--fork. Biggest parity gap vs Claude Code/Codex. (M)

## What survives each failure mode
- Crash between turns: last TURN_COMPLETED save + ≤60s recovery file. Lost: in-flight turn, running agents, daemon attachment.
- Crash + one stray keypress: EVERYTHING in recovery lost (P0).
- TUI restart, daemon alive: no reattach logic — resume rebuilds cold.

## Genuinely strong
returnContext design (panels, approvals, counts, worktrees); per-turn save cadence; export module (redaction, XSS-safe HTML, token/cost summation) — reuse directly for E20 /share; orchestration DAG real and tested.

## Recommended track
1. P0 footgun fix → 2. registration/domain split finish → 3. recovery=resume fidelity → 4. CLI flags (--continue/--resume/--fork) → 5. schemaVersion → 6. fold durability into E13 WAL (don't patch the 60s race) → 7. live-state capture (E8 overlap).
