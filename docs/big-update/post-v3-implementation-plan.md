# Post-v3 Implementation Plan

Date: 2026-04-02
Source: `post-v3-deepdive.md`
Baseline: v0.12.2 (state-machine-first runtime complete)

---

## Execution Phases

### Phase 0 — v3.1 Completion (blocks everything)

6 items from Section 7. These close gaps in the existing runtime before new features land.

| ID | Item | Primary Files | Est. Complexity | Parallelizable |
|---|---|---|---|---|
| V31-1 | SLO gates | `runtime/perf/*`, `runtime/telemetry/spans/*`, `runtime/diagnostics/panels/health.ts` | Medium | Yes |
| V31-2 | Unified tool output policy | `runtime/tools/{types,phases/map-output,adapter}.ts` | Medium | Yes |
| V31-3 | Permissions simulation mode | `runtime/permissions/{evaluator,index}.ts`, `runtime/feature-flags/*` | High | Yes |
| V31-4 | Idempotency and dedupe | `core/orchestrator.ts`, `runtime/tools/phased-executor.ts`, `runtime/tasks/*`, `sessions/manager.ts` | High | No (touches core paths) |
| V31-5 | Snapshot retention/pruning | `runtime/compaction/*`, `sessions/manager.ts` | Medium | Yes |
| V31-6 | Provider capability registry | `providers/{interface,model-catalog,registry}.ts`, `runtime/store/domains/provider-health.ts` | High | Yes |

**Sprint gate:** All 6 items have diagnostics visibility, feature flags, contract tests, and reversible rollout.

**Parallel plan (4 agents max):**
- Agent 1: V31-1 (SLO gates)
- Agent 2: V31-2 (tool output policy)
- Agent 3: V31-3 (permissions simulation)
- Agent 4: V31-6 (provider capabilities)
- Then: V31-4 (idempotency — sequential, touches orchestrator)
- Then: V31-5 (snapshot retention)

---

### Phase 1 — P0 Hardening (blocks feature work)

3 hardening tracks from Section 6.

| ID | Item | Scope |
|---|---|---|
| P0-1 | Command/tool safety hardening | Strict segmentation verdicts, fetch sanitization, policy provenance |
| P0-2 | Deterministic side-effect control | Idempotency keys at command + tool layers, dedupe across replay/reconnect |
| P0-3 | Orchestrator invariants | Unresolved tool-result reconciliation, stop-reason consistency |

**Maps to execution packets:** GC-EXEC-005, GC-FETCH-006, GC-PERM-011, GC-ORCH-015

**Parallel plan:**
- Agent 1: GC-EXEC-005 (shell AST normalization)
- Agent 2: GC-FETCH-006 (fetch sanitization + host trust)
- Agent 3: GC-PERM-011 (policy signing + provenance)
- Agent 4: GC-ORCH-015 (unresolved tool-result reconciliation)

---

### Phase 2 — Architecture Hardening (parallel with Phase 3)

Internal reliability improvements from Section 7.8.

| Packet | Item | Files |
|---|---|---|
| GC-ARCH-001 | Domain import boundaries | `runtime/store/domains/*`, architecture tests |
| GC-ARCH-002 | Typed emission enforcement | `runtime/events/*`, `runtime/emitters/*`, lint rules |
| GC-HEALTH-003 | Cascade SLO + remediation | `runtime/health/*`, `runtime/diagnostics/panels/health.ts`, `runtime/ops/playbooks/*` |
| GC-TOOL-004 | Runtime budget enforcement | `runtime/tools/phases/*`, `runtime/tools/context.ts` |
| GC-TOOL-007 | Output schema fingerprints | `tools/{find,analyze,inspect}/index.ts` |
| GC-TOOL-008 | Overflow backend + retention | `tools/shared/overflow.ts`, `runtime/tools/phases/map-output.ts` |
| GC-PERM-009 | Divergence dashboard | `runtime/permissions/*`, `runtime/diagnostics/panels/events.ts` |
| GC-PERM-010 | Tokenizer fuzz + guards | `runtime/permissions/normalization/tokenizer.ts` |

**Parallel plan (2 batches of 4):**
- Batch 1: GC-ARCH-001, GC-ARCH-002, GC-HEALTH-003, GC-TOOL-004
- Batch 2: GC-TOOL-007, GC-TOOL-008, GC-PERM-009, GC-PERM-010

---

### Phase 3 — Feature Group A: Operator Control + HITL (parallel with Phase 2)

From Section 5: Operator Control Plane (5.1), Adaptive Planner (5.5), HITL UX Modes (5.11).

| Feature | Commands | Panel | Key Integration Points |
|---|---|---|---|
| Operator Control Plane | `/ops view`, `/ops task cancel/pause/resume/retry`, `/ops agent cancel` | `Ops` panel | `runtime/tasks/*`, `runtime/store/domains/agents.ts`, diagnostics panels |
| Adaptive Planner | `/plan mode`, `/plan explain`, `/plan override` | `Ops` strategy lane | `core/orchestrator.ts`, `scheduler/*`, turn/task events |
| HITL UX Modes | `/mode quiet/balanced/operator`, `/mode set-domain` | settings + status bar | `runtime/notifications/*`, `state/mode-manager.ts` |

**Parallel plan:**
- Agent 1: Operator Control Plane
- Agent 2: Adaptive Planner
- Agent 3: HITL UX Modes

---

### Phase 4 — Feature Group B: Replay + Forensics

From Section 5: Deterministic Replay (5.2), Failure Forensics (5.10).

| Feature | Commands | Panel | Key Integration Points |
|---|---|---|---|
| Deterministic Replay | `/replay load/step/seek/diff/export` | `Replay` panel | `core/event-replay.ts`, `runtime/diagnostics/panels/state-inspector.ts`, `runtime/telemetry/exporters/local-ledger.ts` |
| Failure Forensics | `/forensics latest/show/export` | `Forensics` panel | `runtime/ops/*`, health cascades, telemetry spans |

**Maps to packets:** GC-REPLAY-020, GC-COMP-019

**Parallel plan:**
- Agent 1: Deterministic Replay + GC-REPLAY-020
- Agent 2: Failure Forensics
- Agent 3: GC-COMP-019 (compaction quality scoring)

---

### Phase 5 — Feature Group C: Policy + Tool Contracts

From Section 5: Policy-as-Code (5.3), Tool Contract Verification (5.7).

| Feature | Commands | Panel | Key Integration Points |
|---|---|---|---|
| Policy-as-Code | `/policy load/simulate/diff/promote/rollback` | `Policy` panel | `runtime/permissions/*`, `runtime/feature-flags/*` |
| Tool Contract Verification | `/tool verify/verify-all/contract show` | `Diagnostics` panel | `tools/registry.ts`, `runtime/tools/registry-bridge.ts` |

**Parallel plan:**
- Agent 1: Policy-as-Code
- Agent 2: Tool Contract Verification

---

### Phase 6 — Feature Group D + E: Eval + Provider

From Section 5: Evaluation Harness (5.4), Provider Optimizer (5.6).

| Feature | Commands | Panel | Key Integration Points |
|---|---|---|---|
| Evaluation Harness | `/eval list/run/compare/gate` | `Eval` panel | `runtime/perf/*`, telemetry, new eval runner module |
| Provider Optimizer | `/provider route/explain-route/pin/fallback test` | `Provider` panel | `providers/{interface,registry,model-catalog}.ts`, provider health domain |

**Maps to packets:** GC-PROV-021

**Parallel plan:**
- Agent 1: Evaluation Harness
- Agent 2: Provider Optimizer + GC-PROV-021

---

### Phase 7 — Feature Group F + G: Memory + Sessions + Trust

From Section 5: Project Memory (5.8), Multi-session Orchestration (5.12), Extension Trust (5.9).

| Feature | Commands | Panel | Key Integration Points |
|---|---|---|---|
| Project Memory | `/memory add/search/link` | `Memory` panel | new memory store in `state/*`, `sessions/*`, orchestrator |
| Multi-session Orchestration | `/session link-task/handoff/graph/cancel` | `Sessions` panel | `runtime/tasks/*`, `sessions/manager.ts`, `runtime/remote/sync.ts` |
| Extension Trust | `/plugin trust/verify/capabilities/quarantine` | `Plugins` panel | `runtime/plugins/*`, `plugins/*`, runtime permissions |

**Maps to packets:** GC-PLUGIN-017, GC-HOOK-018, GC-AGENT-012, GC-TASK-013

**Parallel plan:**
- Agent 1: Project Memory
- Agent 2: Multi-session Orchestration + GC-TASK-013
- Agent 3: Extension Trust + GC-PLUGIN-017 + GC-HOOK-018
- Agent 4: GC-AGENT-012 (mailbox versioning)

---

### Phase 8 — P1 Hardening + Remaining Packets

From Section 6 P1 + remaining Section 7.8 packets.

| Packet | Item |
|---|---|
| GC-REMOTE-014 | Transport compatibility matrix |
| GC-MCP-016 | MCP schema drift quarantine |
| GC-NOTIF-022 | Adaptive notification suppression |
| GC-INT-023 | Integration delivery SLO + dead-letter |
| GC-SEC-024 | Token scope + rotation audits |
| GC-UI-025 | Panel resource contracts + health |
| GC-DIAG-026 | Actionable diagnostics controls |
| GC-INSPECT-027 | State inspector time-travel + hotspots |

**Parallel plan (2 batches of 4):**
- Batch 1: GC-REMOTE-014, GC-MCP-016, GC-NOTIF-022, GC-INT-023
- Batch 2: GC-SEC-024, GC-UI-025, GC-DIAG-026, GC-INSPECT-027

---

### Phase 9 — Release Gates

From Section 10. All 5 gates must pass.

| Gate | Criteria |
|---|---|
| Safety | Permission + tool safety paths auditable and fail-closed |
| Determinism | Replay + reconnect avoid duplicate side effects; orchestrator invariants hold |
| Performance | SLO + budget gates pass under representative load |
| Operability | Diagnostics, replay, forensics operator-usable |
| Product Quality | All post-v3 capabilities activatable + coherent; conversation high-signal under burst |

---

## Summary

| Phase | Description | Items | Depends On |
|---|---|---|---|
| 0 | v3.1 Completion | 6 items | — |
| 1 | P0 Hardening | 4 packets | Phase 0 |
| 2 | Architecture Hardening | 8 packets | Phase 0 |
| 3 | Operator Control + HITL | 3 features | Phase 0 |
| 4 | Replay + Forensics | 2 features + 2 packets | Phase 1 |
| 5 | Policy + Tool Contracts | 2 features | Phase 1 |
| 6 | Eval + Provider | 2 features + 1 packet | Phase 2 |
| 7 | Memory + Sessions + Trust | 3 features + 4 packets | Phase 3 |
| 8 | P1 Hardening | 8 packets | Phase 6, 7 |
| 9 | Release Gates | 5 gates | All |

**Phases 2+3 run in parallel. Phases 4+5 run in parallel. Phases 6+7 run in parallel.**

**Total: 12 features, 27 execution packets, 6 v3.1 items, 5 release gates.**
