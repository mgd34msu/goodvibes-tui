# Remediation Plan — UX-First

**Generated**: 2026-06-11T19:45:00-05:00 (regenerated 20:15 after unexplained deletion)
**Total Tasks**: 31 (zero-deferral mode)
**Ordering**: user pain per unit effort
**Execution**: WRFC chains, cap 12, min score 10 (zero issues), commits only on passing review / complete directive

## Status snapshot (2026-06-11 20:15)

| Task | Stage |
|------|-------|
| TASK-001+002 KeyName + dead keys | ✅ COMMITTED f39dbcf4 (10/10) |
| TASK-003 registry (redo after phantom-work FAIL 0/10) | review respawn owed (lost) |
| TASK-006/007/008 liveness bundle | ✅ COMMITTED 3081d67a; respawned review confirmed 10/10, zero issues (first reviewer died silently) |
| TASK-011 typed error nav | ✅ COMMITTED c6fe5184 (10/10 after fix cycle: JSDoc + undo-recycle registry desync) |
| TASK-015 atomic writes | ✅ COMMITTED e3415d4b (10/10 after fix1; input-history hunk rides with masked-pw chain) |
| TASK-018 CLI type extraction | ✅ COMMITTED e41666f0 (10/10, 4 cycles dead) |
| TASK-019 wizard type extraction | review in flight |
| TASK-020 handler interface | review in flight |
| TASK-022(+E14) term caps + synced output | review in flight |
| TASK-025/027 coverage + temp hygiene | ✅ COMMITTED 0b875411 (orchestrator takeover after 3/10: bunfig coverage=false override + table-render precondition, both A/B-proven; gate in CI; runtime complete directive) |
| TASK-026 UX regression tests | ✅ COMMITTED 5d1efd32 + 2343bd3b (fully clean, 10/10) |

## Wave 1 — Interaction correctness
- [~] TASK-001: Dead key comparisons (folded into TASK-002) | CRIT | S
- [~] TASK-002: KeyName union across panel contract | HIGH | M | work done, review in flight
- [~] TASK-003: Registry duplicate guard + renames + alias fixes + lint | HIGH | S | redo done, review in flight
- [x] TASK-004: Unified confirm/cancel (Enter/y · Esc/n) | MED | M | DONE — 10/10 after strike-3 orchestrator takeover (7-case gate tests), commit 33033717
- [x] TASK-005: Delete-key policy + confirm destructive clear | HIGH | M | DONE — 10/10, delete-key-policy.ts single source, commit 33033717

## Wave 2 — Liveness & error visibility
- [~] TASK-006/007/008: elapsed + TTFT + tool timers + real tok/s | HIGH/MED | S | work done, review in flight
- [ ] TASK-009: TURN_ERROR → transcript + formatUserFacingError | HIGH | M | blocked on main.ts free
- [ ] TASK-010: Stream-stall watchdog | LOW | M | blocked on main.ts free
- [~] TASK-011: Typed error navigation | LOW | M | work done, review in flight

## Wave 3 — First-run
- [~] TASK-012: Persist wizard progress + shown-on-apply + resume prompt | CRIT | M | work done (progress.ts + onStepChange threading, 18 tests; recovery after dead agent), nested review 10/10, binding reviews in flight
- [ ] TASK-013: Required-field pre-apply gate | HIGH | M
- [ ] TASK-014: "Apply & Continue" label honesty | LOW | S

## Wave 4 — Data integrity
- [~] TASK-015: Shared atomic-write helper + 4 stores | HIGH | S | work done, review in flight
- [x] TASK-016: Serialize acknowledgement writes | HIGH | M | DONE — O_EXCL lockfile, 10/10 after 1 fix cycle, commit 417e226e
- [x] TASK-017: readVersioned migration reader | MED | M | DONE — quarantine + stepwise migrations wired into state/markers, commit 417e226e

## Wave 5 — Architecture completions
- [~] TASK-018: CliCommandRuntime → cli/types.ts (4 cycles) | HIGH | S | review in flight
- [~] TASK-019: Wizard types extraction (7+ cycles) | HIGH | M | review in flight
- [~] TASK-020: InputHandler interface (3 cycles) | MED | M | review in flight
- [ ] TASK-021: eslint no-cycle + layer boundaries | MED | L

## Wave 6 — Rendering polish
- [~] TASK-022 (+E14 synced output): capability gate + DEC 2026 | HIGH | M | review in flight
- [ ] TASK-023: Theme tokens (light-theme readability) | HIGH | M | after 022 commits
- [ ] TASK-024: Streaming perf bundle (incremental md, finalize-only highlight, diff run-coalescing, resize debounce) | MED | M

## Wave 7 — Completeness sweep
- [~] TASK-025: Coverage instrumentation | HIGH | M | FIX cycle (real coverageThreshold)
- [x] TASK-026 (committed 5d1efd32): resize / raw-stdin / escape-contract tests | MED | S
- [~] TASK-027: Temp-dir hygiene | MED | S | FIX cycle (wipe race)
- [ ] TASK-028: CLI flag rationalization (--yes, output, host) | MED | M
- [ ] TASK-029: Command naming grammar + lint | LOW | M
- [ ] TASK-030: Markdown fences + ANSI-aware width utils | LOW | S
- [ ] TASK-031: God-file splits (settings controller, model-picker) | LOW | L

## Execution standard (zero-deferral)
- Min 10 review (zero issues, any severity) before commit; docs ship with behavior changes
- Fix loops: after 3 sub-10 attempts on a chain the ORCHESTRATOR implements the reviewer-prescribed fixes directly (still independently reviewed at min 10); escalate to owner only if that attempt also fails
- Every WORK completion must include git-diff evidence (phantom-work guard)
- Orchestrator backfills reviews when runtime directives don't arrive (user-authorized)
- Each completion logged to .goodvibes/logs/activity.md + memory

## Best-in-Class Program — subsystem dive coverage (owner mandate: EVERYTHING best in class)

| Subsystem | Dive status | Execution track |
|-----------|-------------|------------------|
| Full codebase (UX-first 10-dim) | ✅ done | 31 tasks, waves 1-7 in flight |
| WRFC (TUI) | ✅ done | 3 chains in review; SDK items → ../goodvibes-sdk handoff |
| Providers/models/failover | ✅ done | E11 7-step track, starts after Wave 2 commits (providers-deep-dive.md) |
| Panels/modals/subagent monitor | 🔄 design audit running | UI Redesign track on landing |
| Onboarding (product) | 🔄 dive running | merges with TASK-012/013/014 + F4 |
| Project/plan auto-detection | ✅ STRIP executed (owner-approved) | review PASS 10/10; coordinator + test deleted, /plan + work-plan store + submitPlanningAnswer seam kept, regression pin added; COMMIT PENDING main.ts entanglement (liveness hunks already in 3081d67a — rides with error-bundle verdict only) |
| Session lifecycle | ✅ done (session-lifecycle-deep-dive.md) | P0: recovery-delete footgun + registration split; then recovery fidelity, CLI --continue/--resume/--fork, schemaVersion, E13 WAL fold-in |
| Daemon/remote/auth | ✅ done (daemon-auth-deep-dive.md) | C1 trustProxy/tunnel limiter (top), TLS nudge, enforceCors wiring, masked passwords; SDK items → handoff Items 5-6 |
| Memory/knowledge duality | ✅ done (memory-duality-deep-dive.md) | Consolidation: fix scope-filter no-op, merge panels, fix naming inversion, auto-inject at spawn; UX clarity was 3/10 |
| Agent execution substrate | ✅ done (agent-substrate-deep-dive.md) | F2 track: roster+cost read-model, fix $0 cost stub, generalize cancel, kill fake token estimate, per-agent watchdog, cockpit actions |
| Config & settings | ✅ done (config-settings-deep-dive.md) | Project-scope default-flip bug (HIGH), settings search, schema-driven restart flags, isDefault deep-equality, provenance unification (SDK) |
| Context management UX | ✅ done (context-ux-deep-dive.md) | E7 7-step track — engine 80% built, three cut wires: auto-compact hardcoded off, threshold plumbed-but-unused on meter, recovery data with no UI |
| Audio/TTS coherence | ✅ done (audio-tts-deep-dive.md) | VERDICT: FINISH — best subsystem yet (robustness 9/10); 4 small polish items |
| Export & integrations | ✅ done (export-integrations-deep-dive.md) | Strongest subsystem (8-9s; inbound loop genuinely connected). E20 track: upload+link, cost passthrough, GitHub event narration, /channel cmd |
| Release/verification pipeline | ✅ done (release-pipeline-deep-dive.md) | P2 perf-gate reality (zero-snapshot fix, startup budget, frame bench), P1 golden frames, wire live-verifier, eval fail-closed, multi-platform smoke |

Gate standard for every track: dive → tasks → WRFC min 10 (zero issues) → commit → enhancement tier. Docs ship with changes.

## Dive-Derived Backlog (TASK-032+) — every finding from completed dives, numbered

### Session lifecycle (dive done; P0 footgun chain in flight)
- [ ] TASK-032: Finish /session registration+domain split (single registration, explicit routing; decide orchestration command) | HIGH | S-M | after registry commit
- [ ] TASK-033: schemaVersion on session+recovery files w/ read gating | HIGH | S
- [ ] TASK-034: CLI --continue / --resume [id] / --fork | HIGH | M | after cli commit

### Daemon/auth (dive done; masked-passwords in flight)
- [ ] TASK-035: Cloudflare wizard auto-configures trustProxy + CF-Connecting-IP trust (TUI side of C1) | CRIT | M | after wizard commit
- [ ] TASK-036: TLS hard-warn/require when hostMode≠local (wizard + startup banner) | HIGH | S
- [ ] TASK-037: Wire enforceCors+allowedOrigins into wizard for network/tunnel modes | MED | S
- [ ] TASK-038: TUI-side auth tests: limiter behavior, forwarded-IP spoofing, empty-password SDK regression | MED | S

### Memory/knowledge (dive done; precedes K-track)
- [x] TASK-039: Fix scope-filter no-op in /session-memory + /team-memory front-doors | HIGH | S | DONE — commit 69909081 (memory-front-doors chain)
- [ ] TASK-040: Merge memory+knowledge panels into one filtered panel; repoint 'knowledge' id to the graph | MED | M
- [ ] TASK-041: /recall discoverability (project-memory alias decision) + rename SessionMemoryStore scratch surface to 'notes' | LOW | S

### Agent substrate / F2 foundation (dive done)
- [ ] TASK-042: Fix $0 cost-catalog stub (implement lookup or delete tier + document table authoritative) | HIGH | S
- [ ] TASK-043: Generalize cancel beyond WRFC panel (inspector + detail modal) | HIGH | M
- [ ] TASK-044: Kill toolCallCount*400 token estimate; read real per-agent tokens (cost-tracker source) | MED | S
- [ ] TASK-045: Per-agent stall watchdog (generalize WRFC isStalled) + stalledAgentCount | MED | M
- [ ] TASK-046: Cockpit read-model: agent roster + cost/token aggregate slice | HIGH | M
- [ ] TASK-047: Cockpit action keys (inspect/cancel) | MED | S

### Config & settings (dive done)
- [~] TASK-048: Default-flip respects PROJECT-scoped explicit values | HIGH | S | likely DONE via liveness applyRuntimeConfigDefault (reviewer verified both global+project files read) — settings chain to confirm and close
- [ ] TASK-049: Settings modal fuzzy search across key+label+description | HIGH | M
- [ ] TASK-050: requiresRestart/liveApply schema field replacing keyword heuristic | MED | M
- [ ] TASK-051: isDefault deep-equality (fixes ◇ for non-scalar defaults) | MED | S
- [ ] TASK-052: Reset-category / reset-all (confirm-gated; SDK reset() unwired) | LOW | S
- [ ] TASK-053: Warn on unknown top-level settings.json keys | LOW | S

### Context UX / E7 (dive done)
- [ ] TASK-054: E7-1 unify three token estimators on SDK estimateConversationTokens | HIGH | S
- [ ] TASK-055: E7-2 compact threshold drawn on the meter; color switches at threshold | HIGH | S
- [ ] TASK-056: E7-4 promote suggest-compact/needs-repair to passive status hint | MED | S-M
- [ ] TASK-057: E7-3 compaction preview + before/after notice (may need SDK dry-run) | MED | M
- [ ] TASK-058: E7-5 behavior.autoCompact* config real (replace hardcoded 80/false); checkAndCompact behind flag | MED | M
- [ ] TASK-059: E7-6 compaction history + restore UI | LOW | M-L
- [ ] TASK-060: E7-7 pin/preserve-selection UI | LOW | M

### TTS finish-track (dive done — verdict FINISH)
- [x] TASK-061: always-speak toggle + /tts on|off | MED | S | DONE — commit a440dc6a (ui.voiceEnabled unified, labels honest)
- [ ] TASK-062: tts.speed surfaced through synth options + modal | LOW | S
- [ ] TASK-063: Explicit tts.* config defaults | LOW | S
- [ ] TASK-064: Wiring-seam integration smoke test | LOW | S

### Export / E20 (dive done; completions chain in flight)
- [ ] TASK-065: /share passes live session cost into exporters | MED | S
- [ ] TASK-066: Upload target + share-link generation (Gist/HTTP PUT) | HIGH | M
- [ ] TASK-067: --copy/--open flags + post-export hint | LOW | S
- [ ] TASK-068: Narrate inbound GitHub/integration events via SystemMessageRouter | MED | M
- [ ] TASK-069: /channel command (status/policy/route) | MED | M
- [ ] TASK-070: Rename integration-runtime.ts → plugin-runtime.ts | LOW | XS

### Release pipeline / P1+P2 (dive done)
- [ ] TASK-071: perf:check loads REAL recorded metrics (kill zero-snapshot) + perf-bench step | CRIT | M
- [ ] TASK-072: startup.cold.p95 budget measured in smoke:tui | HIGH | S
- [ ] TASK-073: Headless frame bench feeding frame.render.p95 | HIGH | M
- [ ] TASK-074: O(delta) streaming bench | MED | M
- [ ] TASK-075: Wire verification:live warn-only into release.yml | MED | S
- [ ] TASK-076: eval:gate fail-closed on missing baseline | MED | S
- [ ] TASK-077: release.ts runs full gate suite pre-tag | MED | S
- [ ] TASK-078: Multi-platform binary smoke (macOS runner; arm64 strategy) | MED | M
- [ ] TASK-079: P1 golden frames phase 1 (static surfaces, ANSI normalizer, linux-x64) | MED | M

### Providers / E11 (dive done; gated on Wave 2 commits)
- [ ] TASK-080–086: E11 steps 1-7 as specified in providers-deep-dive.md (optimizer enable+visibility → turn-path failover → failover notice w/ cost → synthetic CLI parity → context-window enforcement → nested synthetic chain UI → health-type convergence)

### K-Track (roadmap; gated on TASK-039/040/041)
- [ ] K1–K6 per enhancements-roadmap.md

### Suite health (triaged 2026-06-11 ~22:20)
- [ ] TASK-088: Eliminate the 5 single-process test-interference failures (whole-suite `bun test src/` mode; all pass per-file). Identified during the coverage-gate takeover — cross-file state leakage debt. | MED | M
- [ ] TASK-087: Fix 2 pre-existing test failures (reproduce at session-start commit 040d476e; all tonight's chains exonerated): new-event-domains.test.ts 'event vocabularies cover all first-class surfaces' + delivery-router.test.ts 'registers default concrete channel delivery strategies' — both toEqual enumeration mismatches, likely stale expected lists after an SDK bump | MED | S

### Pending dives → will append here on landing: onboarding (Path A/B/C spec), auto-detection (strip/fix verdict → owner sign-off), design audit (UI Redesign track)

## PLAN-TRACK — Best-in-Class Planning Function (capstone; owner-delegated to orchestrator)

Owner mandate (2026-06-11): after the auto-coordinator strip, design and build a NEW planning function — orchestrator has design authority; implementation begins ONLY after all other tracks land (it should build on the finished substrate, not race it).

Design principles locked now (lessons from the stripped coordinator's failure modes):
1. EXPLICIT, never implicit — invoked by the user (/plan, a palette entry, or an offer the model can make and the user accepts); NEVER regex-triggered, NEVER intercepts conversation, NEVER swallows a turn. Zero exceptions.
2. Plans are first-class durable objects — atomic-write persisted, schema-versioned, session-linked (survives restarts via the session/resume machinery; visible in returnContext).
3. Integrated, not bolted on — plan steps can spawn/track WRFC chains (the runtime already orchestrates work-review-fix); progress renders in the cockpit roster (UI-6/F2); decisions/constraints captured into durable memory feed K2's self-improving loop; /workplan absorbs or federates (one checklist concept, not two).
4. Honest UX — plan state always visible (status-line chip + panel), every mutation announced, cancel/pause/resume affordances per the confirm contract; docs ship with it.
5. Full design spec written by the orchestrator when the track opens, informed by the landed cockpit/session/K-track substrate; spec gets owner review before implementation; implementation runs through the same min-10 WRFC gates as everything else.

Sequencing: opens after waves 1-7 remainders + UI Redesign track + E7/E11/E20/F-tracks/K-track complete. It is the LAST feature track before the final re-dive sweep.

## DEFINITION OF DONE — "best in class" exit criteria (owner mandate: EVERYTHING) — program exit ships as v1.0.0

Owner decisions (2026-06-12): v1.0.0 is pinned to THIS gate, not a date; interim releases ship as 0.x minors (0.21.0 after the current batch lands + CI green + npm publish). Orchestrator runs the remainder autonomously ("work through everything and get me to 1.0.0").

The program is complete only when ALL of the following hold:
1. Every subsystem in the coverage table has a completed dive. No subsystem exempt — including audio/TTS, export, release pipeline, and anything discovered later (new subsystems found during dives get added to the table, not skipped).
2. Every finding from every dive — critical through nitpick — is either fixed at WRFC 10/10 and committed, or explicitly routed: SDK-rooted items → ../goodvibes-sdk handoff (Items 1-6+); plugin-rooted items → plugin evidence pile. No finding closed by assertion, deferral, or fatigue.
3. Every enhancement in enhancements-roadmap.md (F1-F5, E1-E21, P1-P5) is built and passes the same gate — including the UI Redesign track from the design audit.
4. RE-ASSESSMENT: after each track completes, its subsystem is re-dived; the program exits a subsystem only when the re-dive scores 10/10 on every dimension measured (or documents the precise SDK dependency capping it, with the cap recorded in the handoff). Baseline scores (5.3 overall, failover 3/10, durability 5/10…) exist to be re-measured, not remembered.
5. The final act: one full re-run of the original 10-dimension UX-first review. Target: 10/10 weighted. Anything short of it generates a new wave and the loop continues.

Known caps outside this repo's control (tracked, not forgotten): SDK items (phantom-pass, phantom-work verification, durable chains, secret-writer fsync, account lockout, CF-Connecting-IP validation, SessionManager atomicity) cap affected dimensions until the SDK session; the Claude-side plugin (directive reliability, vec.db leak, notification crossing) is explicitly out of scope per owner.

## Verify-close sweep verdict (2026-06-12, post-0.23.0)

Code-evidence audit of every open checkbox above (sweep agent, committed-state based):
- CLOSED (38): TASK-009, 010, 013, 014, 023, 024, 028, 033, 034, 035, 036, 039, 040, 041, 042, 043, 044, 045, 046, 047, 048, 049, 051, 052, 053, 054, 055, 056, 058, 071, 072, 073, 074, 076, 087, UI-4, UI-5, UI-6 (+F2 residual). Checkboxes above are stale; evidence per item in .goodvibes/logs/activity.md sweep entry.
- PARTIAL, SDK-capped (2): TASK-037 (enforceCors/allowedOrigins not in ConfigKey union — SDK handoff Item 5; wizard ships guidance), TASK-050 (requiresRestart still keyword heuristic — SDK ConfigSetting lacks the field, handoff Item 8).
- Remaining open engineering surface is therefore: wave-7 trio (TASK-029/030/031, in flight), TASK-075/077/078 (committed bf9eaef8), TASK-088 (in flight), E11-4..7 (in flight), E-track unbuilt items, F1/F3/F4/F5, UI-1/2/3/7/8, K1-K6, P4, planning capstone, re-dives, final UX re-run.
