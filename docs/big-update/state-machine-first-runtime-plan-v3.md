# goodvibes-tui — State-Machine-First Runtime Blueprint (v3)

Date: 2026-04-02

This expands your ideas into a complete architecture program. Your examples are directionally correct; this version deepens them into explicit contracts and implementation strategy.

### Changelog (v2 → v3)

- **Section 15** replaced: flat sprint board → tiered execution strategy with sprint gates
- **Section 16** updated: first 10 tasks aligned to tiered execution
- **Section 17** updated: expanded success criteria
- **Section 20** updated: OTel phased to Tier 4-6 (correlation IDs from day one)
- **Section 23** added: Cross-machine error propagation model
- **Section 24** added: Domain interaction matrix
- **Section 25** added: Testing strategy for state machines
- **Section 26** added: Devtools / state inspector
- **Section 27** added: Migration cutover strategy
- **Section 28** added: Subscription batching and event replay

---

## 1) Strategy in one sentence

Make runtime discipline first-class (state machines + typed contracts + invariants) while explicitly investing in differentiated UX surfaces so goodvibes becomes both safer and more distinctive.

## 2) Product principles (non-negotiable)

1. Preserve differentiated surfaces
- Panel-first operator UX, WRFC workflows, local model ergonomics, terminal-native polish remain core.

2. Runtime correctness over convenience
- Protocol/lifecycle correctness should beat short-term implementation shortcuts.

3. Explicitness over implicit coupling
- Lifecycle transitions must be represented in types and reducers, not hidden in scattered booleans.

4. Bounded side effects
- Side effects run through explicit effect handlers; reducers stay pure.

5. Diagnosability as a feature
- Every critical decision emits typed traceable events.

## 3) Expanded target runtime model

Your proposed domains are right. Expand to this canonical runtime envelope:

```ts
interface RuntimeState {
  session: SessionDomainState;
  model: ModelDomainState;
  conversation: ConversationDomainState;
  overlays: OverlayDomainState;
  panels: PanelDomainState;
  permissions: PermissionDomainState;
  tasks: TaskDomainState;
  agents: AgentDomainState;
  providerHealth: ProviderHealthDomainState;
  mcp: McpDomainState;
  plugins: PluginDomainState;
  daemon: DaemonDomainState;
  acp: AcpDomainState;
  integrations: IntegrationDomainState;
  telemetry: TelemetryDomainState;
  git: GitDomainState;
  discovery: DiscoveryDomainState;
  intelligence: IntelligenceDomainState;
  uiPerf: UiPerfDomainState;
}
```

Add explicit domain metadata:
- `revision`: monotonic state version
- `lastUpdatedAt`: per-domain timestamp
- `source`: subsystem origin of last mutation

## 4) State-machine catalog (expanded)

### 4.1 Turn lifecycle machine
States:
- `idle`
- `preflight`
- `streaming`
- `tool_dispatch`
- `post_hooks`
- `completed`
- `failed`
- `cancelled`

Events:
- `TURN_SUBMITTED`, `PREFLIGHT_OK`, `PREFLIGHT_FAIL`, `STREAM_DELTA`, `TOOL_BATCH_READY`, `TOOLS_DONE`, `POST_HOOKS_DONE`, `TURN_ERROR`, `TURN_CANCEL`

Guards:
- no concurrent turn in same session unless explicitly queued
- abort signal cannot be ignored after `TURN_CANCEL`

### 4.2 Tool execution machine
States:
- `received`, `validated`, `prehooked`, `permissioned`, `executing`, `mapped`, `posthooked`, `succeeded`, `failed`, `cancelled`

Notes:
- every tool call has phase timestamps
- phase timeout policy is tool-class-specific

### 4.3 Permission decision machine
States:
- `collect_rules`, `normalize_input`, `evaluate_policy`, `evaluate_runtime_mode`, `evaluate_session_override`, `final_safety_checks`, `decision_emitted`

Outputs:
- `PermissionDecision` + `PermissionDecisionReason` + `sourceLayer`

### 4.4 Task lifecycle machine (unified)
States:
- `queued`, `running`, `blocked`, `completed`, `failed`, `cancelled`

Task kinds:
- `exec`, `agent`, `acp`, `scheduler`, `daemon`, `mcp`, `plugin`, `integration`

### 4.5 Agent lifecycle machine
States:
- `spawning`, `running`, `awaiting_message`, `awaiting_tool`, `finalizing`, `completed`, `failed`, `cancelled`

### 4.6 Plugin lifecycle machine
States:
- `discovered`, `loading`, `loaded`, `active`, `degraded`, `error`, `unloading`, `disabled`

### 4.7 MCP server lifecycle machine
States:
- `configured`, `connecting`, `connected`, `degraded`, `auth_required`, `reconnecting`, `disconnected`

### 4.8 ACP/daemon transport lifecycle machine
States:
- `initializing`, `authenticating`, `connected`, `syncing`, `degraded`, `reconnecting`, `disconnected`, `terminal_failure`

### 4.9 Session recovery machine
States:
- `loading`, `repairing`, `reconciling`, `ready`, `failed`

### 4.10 Compaction lifecycle machine
States:
- `checking_threshold`, `microcompact`, `collapse`, `autocompact`, `reactive_compact`, `boundary_commit`, `done`, `failed`

## 5) Strong typing contracts (beyond current EventBus)

Current EventBus is typed but too centralized and stringly in usage patterns.

### 5.1 Domain event modules
Create:
- `src/runtime/events/session.ts`
- `src/runtime/events/turn.ts`
- `src/runtime/events/tools.ts`
- `src/runtime/events/tasks.ts`
- `src/runtime/events/plugins.ts`
- `src/runtime/events/mcp.ts`
- `src/runtime/events/permissions.ts`
- `src/runtime/events/transport.ts`

### 5.2 Emission wrappers
No direct raw string emissions from business logic.

Use wrappers:
- `emitTurnStarted(ctx)`
- `emitToolPhaseChanged(ctx)`
- `emitPermissionDecision(ctx)`
- `emitTaskStatusChanged(ctx)`

### 5.3 Event envelope standard

```ts
interface RuntimeEventEnvelope<TType extends string, TPayload> {
  type: TType;
  ts: number;
  traceId: string;
  sessionId: string;
  turnId?: string;
  agentId?: string;
  taskId?: string;
  source: string;
  payload: TPayload;
}
```

### 5.4 Compile-time guarantees
- discriminated unions per domain
- no `unknown` payloads for internal events
- schema validation at boundaries (daemon/acp/plugin ingress)

## 6) First-class tool runtime contract (expanded)

Your list is correct. Add these missing surfaces:
- feature flags for tool execution behavior
- deterministic idempotency key per tool call
- budget context (token/time/cost)
- output policy (truncate/ref/file spill)
- capability context (local/remote/subagent mode)

```ts
interface ToolRuntimeContext {
  runtime: RuntimeStoreAccess;
  ids: {
    sessionId: string;
    conversationId: string;
    turnId: string;
    toolCallId: string;
    traceId: string;
  };
  permission: PermissionInterface;
  hooks: HookInterface;
  tasks: TaskHooks;
  resources: {
    fileCache: FileStateCache;
    projectIndex: ProjectIndex;
  };
  provider: {
    providerId: string;
    modelId: string;
    contextWindow: number;
  };
  agent?: {
    agentId: string;
    parentAgentId?: string;
    isolationMode: 'shared' | 'worktree' | 'remote';
  };
  budget: {
    maxMs?: number;
    maxTokens?: number;
    maxCostUsd?: number;
  };
  cancellation: {
    signal: AbortSignal;
    reason?: string;
  };
  executionMode: 'interactive' | 'background' | 'remote';
}
```

## 7) Permissions v2 (serious mode)

Your direction is right. Expand further:

### 7.1 Command normalization pipeline
1. tokenize
2. segment compound shell commands
3. canonicalize command prefix
4. classify read/write/network/destructive/escalation
5. evaluate against layered policy
6. run bypass-immune safety checks

### 7.2 Rule models
- `prefix` rules (`["git","status"]`)
- `arg-shape` rules (e.g. disallow `rm -rf /` class)
- `path-scope` rules (project-only, allowlist paths)
- `network-scope` rules (host allow/deny)
- `mode constraints` (more strict in background or remote)

### 7.3 Suggested permission modes
- `default`
- `plan`
- `allow-all`
- `custom`
- `background-restricted`
- optional: `remote-restricted`

### 7.4 Decision observability
Emit structured reason codes like:
- `RULE_ALLOW_USER`
- `RULE_DENY_MANAGED`
- `PROMPT_ALLOW_ONCE`
- `SAFETY_DENY_DESTRUCTIVE_PREFIX`
- `MODE_DENY_BACKGROUND`

## 8) Task semantics (expanded canonical model)

Your model is correct. Add missing operational fields:
- retry policy
- deadlines/timeouts
- parent/child relationships
- persistence/sync markers

```ts
interface RuntimeTask {
  id: string;
  type: TaskType;
  title: string;
  startTime: number;
  status: TaskStatus;
  outputHandle?: OutputHandle;
  progressSummary?: string;
  owner: { sessionId: string; agentId?: string };
  cancellable: boolean;
  notification: NotificationState;
  retry?: { attempts: number; maxAttempts: number; backoffMs: number };
  deadlineMs?: number;
  parentTaskId?: string;
  childTaskIds?: string[];
  persisted?: boolean;
  syncState?: 'local_only' | 'pending_sync' | 'synced' | 'sync_failed';
}
```

## 9) Plugin architecture maturity (expanded)

Add a normalized contribution contract:

```ts
interface PluginContributionContract {
  commands?: NormalizedCommandContribution[];
  tools?: NormalizedToolContribution[];
  panels?: NormalizedPanelContribution[];
  hooks?: NormalizedHookContribution[];
}
```

### 9.1 Capability manifests
Capabilities should be explicit and deny-by-default.
- `filesystem.read`
- `filesystem.write`
- `network.outbound`
- `shell.exec`
- `register.tool`
- `register.provider`
- `register.panel`
- `register.hook`

### 9.2 Safe hot reload protocol
- request reload
- quiesce inflight operations
- unregister contributions
- unload module
- reload module
- re-register contributions
- run plugin health checks
- transition to `active` or `degraded`

### 9.3 UI surfacing
- plugin status panel row with lifecycle + last error
- plugin contribution inspector
- `/plugin diagnostics` machine-readable output

## 10) ACP + daemon + remote substrate (expanded)

### 10.1 Durable identity model
- globally unique `sessionId`, `taskId`, `agentId`
- stable across reconnects and transport changes

### 10.2 Reconnect semantics
- handshake tokens + epoch
- replay from last acknowledged event offset
- idempotent command submission keys

### 10.3 Transport contract package
- typed messages for control/data/ack/failure
- retry/backoff policy per message class
- explicit terminal vs retryable failure taxonomy

### 10.4 Runtime store sync
- remote task states mirrored into `tasks` domain
- remote health mirrored into `daemon/acp/providerHealth` domains

## 11) MCP evolution (expanded)

Beyond tool calls:
1. resource listing and resource reading as first-class runtime operations
2. schema freshness states (`fresh`, `stale`, `unknown`, `fetch_failed`)
3. per-server permissions and trust levels
4. reconnect and auth-required UI with remediation actions
5. MCP work represented in unified task model

## 12) Invariant set (must be enforced)

1. No tool call enters `executing` without a permission decision.
2. No task can be `completed` while marked `running` in process registry.
3. No agent can be `running` without an owning session.
4. No plugin can be `active` if capability checks failed.
5. No event emitted without trace/session IDs at runtime core boundaries.
6. No resume can complete without reconciliation pass.
7. No destructive exec command bypasses final safety checks in any mode.

## 13) Anti-regression UX guardrails

To avoid "safer but blander":
- every hardening sprint includes one explicit UX improvement item in:
  - model/provider control surfaces
  - panel depth
  - WRFC control/visibility
  - local model workflow ergonomics
  - operator introspection

## 14) Parallel-agent execution topology

### Workstream A: Runtime store + event contracts
- `src/runtime/store/*`
- `src/runtime/events/*`
- `src/main.ts` integration seams

### Workstream B: Tool runtime + permissions v2
- `src/runtime/tools/*`
- `src/permissions/*`
- `src/tools/exec/*`
- migrated core tools

### Workstream C: Task/agent unification
- `src/runtime/tasks/*`
- `src/tools/shared/process-manager.ts`
- `src/acp/*`, `src/tools/agent/*`, `src/scheduler/*`

### Workstream D: Plugin/MCP hardening
- `src/plugins/*`
- `src/mcp/*`
- plugin/mcp UI status surfaces

### Workstream E: Session/compaction/recovery
- `src/core/context-compaction.ts`
- `src/core/conversation.ts`
- `src/sessions/manager.ts`

### Workstream F: UX reinvestment
- model picker/provider health
- panels/WRFC/renderer polish

## 15) Tiered execution strategy (with sprint gates)

> This tiered model supersedes the flat CSV sprint board from v2. Each tier has a concrete gate that must pass before the next tier begins.

### Tier 0 — Foundation (blocks everything)

Work items:
- Runtime store skeleton + domain slices + typed selectors
- Main.ts decomposition → `src/runtime/bootstrap.ts` composition root
- Event contracts + domain event maps + emitter wrappers
- Correlation IDs (traceId, sessionId, turnId) baked into event envelope standard (Section 5.3)

**Sprint gate:** RuntimeState compiles. Selectors consumed by orchestrator. main.ts is bootstrap-only wiring. Domain events emitting through typed wrappers. Correlation IDs present in all event envelopes.

### Tier 1 — Core Runtime (blocks feature work)

Work items:
- Tool runtime context (Section 6) + phased executor
- Tool migration: read/write/edit/exec routed through phased executor
- UI state contracts: selector/intent rewiring (Section 18)
- Kill switches + feature flags (Section 21.3) for all subsequent subsystems

**Sprint gate:** All migrated tools execute through phased executor with cancellation. UI reads from RuntimeState selectors. Feature flags gate all new subsystems. Kill switches operational.

### Tier 2 — Policy + Contracts

Work items:
- Permissions v2 core: layered evaluator + reason codes (Section 7)
- Permissions v2 exec: command normalization + segmentation (Section 7.1)
- Background-restricted mode (Section 7.3)
- Compatibility contracts + schema versioning (Section 21.1)
- Cross-machine error propagation rules (Section 23)

**Sprint gate:** All permission decisions have source + reason. Command normalization covers compound shell commands. Error cascade rules declared and tested. Schema versioning in place for runtime state and event envelopes.

### Tier 3 — Unified Semantics

Work items:
- Task unification core: RuntimeTask model (Section 8)
- Task unification integrations: ACP/agents/scheduler adapted (Section 8)
- Conversation noise routing to panels (Section 18.2)
- Contract tests for cross-subsystem boundaries (Section 21.6)

**Sprint gate:** All task types represented in unified RuntimeTask. Conversation remains high-signal under burst load. Contract tests passing for event payloads, tool context invariants, permission decisions, and task transitions.

### Tier 4 — Subsystem Hardening

Work items:
- Plugin lifecycle + capability manifests (Section 9)
- Plugin hot reload protocol (Section 9.2)
- MCP lifecycle + per-server permissions + health (Section 11)
- Diagnostics panel (Section 18.3)
- OTel foundation: initialize tracer/meter, emit interaction and llm spans (Section 20)

**Sprint gate:** Plugin and MCP state machines visible in runtime store. Diagnostics panel operational. OTel spans emitting for turn/tool/task lifecycles.

### Tier 5 — Remote + Resilience

Work items:
- Remote substrate: transport contracts + reconnect (Section 10)
- Remote observability: panel introspection
- OTel lifecycle instrumentation across all domains (Section 20)
- Security review pack (Section 21.5)
- Chaos tests (Section 21.2)
- Perf budgets + CI regression gates (Section 21.4)

**Sprint gate:** Transport survives disconnect/reconnect. Chaos tests pass for all fault scenarios. Perf budgets enforced in CI. Security review complete.

### Tier 6 — Session + Observability

Work items:
- Session compaction: boundary commit, reactive compact, resume repair (Section 4.10)
- OTel export reliability: fail-safe queue + retry (Section 20)
- Ops playbooks (Section 21.7)

**Sprint gate:** Prompt-too-long recovers gracefully. Export failures don't block runtime. Runbooks cover common failure classes (stuck turns, reconnect failures, permission deadlocks, plugin degradation).

### Tier 7 — UX Differentiation

Work items:
- Model picker / provider health surfaces
- Panel / WRFC / renderer polish
- OTel UX: telemetry diagnostics panel
- Anti-regression UX test matrix (Section 18.5)
- State inspector / devtools panel (Section 26)

**Sprint gate:** Differentiated surfaces measurably improved. Anti-regression matrix passing. State inspector available in dev mode.

### Tier dependency summary

```
Tier 0 ──→ Tier 1 ──→ Tier 2 ──→ Tier 3 ──→ Tier 4 ──→ Tier 5 ──→ Tier 6 ──→ Tier 7
  │                      │           │           │
  │                      │           │           └── OTel foundation
  │                      │           └── Contract tests gate subsystem work
  │                      └── Error propagation rules before task unification
  └── Kill switches in Tier 1 gate everything after
```

## 16) First 10 concrete tasks (immediate — aligned to Tier 0 and early Tier 1)

1. Scaffold `src/runtime/store` with domain slices and root `RuntimeState`.
2. Create typed selectors for RuntimeState domains.
3. Create `src/runtime/bootstrap.ts` composition root, decompose `src/main.ts`.
4. Create `src/runtime/events` with envelope standard and domain event maps.
5. Build typed emission wrappers for turn/tool/task/permission/plugin events.
6. Implement `RuntimeHealthAggregator` with composite health derivation.
7. Add feature flag / kill switch infrastructure in config layer.
8. Add phased tool executor module skeleton.
9. Define `CascadeRule[]` table and wire error propagation.
10. Begin tool migration: route exec tool through phased executor.

## 17) Success criteria

You are done when:
- runtime behavior is explainable from typed state + event logs
- dangerous command paths are policy-hardened and auditable
- task/agent/process/acp/daemon semantics are unified
- plugin/MCP lifecycle behavior is explicit and recoverable
- differentiated UX surfaces improve, not degrade, after hardening
- cross-machine error propagation is declared, tested, and enforced
- domain interaction boundaries are enforced (no unauthorized cross-domain reads)
- state machine transitions are property-tested for invariant preservation
- migration cutover is reversible per-domain via feature flags
- UI subscriptions batched to prevent render storms under burst load
- event replay can reconstruct runtime state deterministically


## 18) UI/UX Refactor Is In-Scope (Required)

This refactor explicitly includes UI architecture changes to prevent state bugs.

### 18.1 Runtime/UI contract rules

1. UI does not own canonical runtime state.
2. UI reads state only through typed selectors from `RuntimeState`.
3. UI emits typed intents/actions; it does not mutate cross-subsystem state directly.
4. Conversation, panels, overlays, and notifications must derive from the same domain snapshots.
5. Event streams (`tool`, `agent`, `task`, `diagnostic`) route into runtime domains first, then to UI.

### 18.2 Conversation noise control model

- Main conversation remains high-signal.
- Operational noise is routed to dedicated panels by default.
- Inline conversation only gets:
  - critical failures
  - explicit user-facing milestones
  - condensed summaries with jump actions into panels

### 18.3 Required panel expansions

- Dedicated `Tool Calls` panel: phase timeline, filters, latency/failures, call detail drilldown.
- Dedicated `Agents/Cohorts` panel: state, ownership, blockers, progress, cancellation controls.
- Dedicated `Tasks` panel: unified runtime tasks across process/agent/ACP/scheduler/daemon.
- Dedicated `Events/Diagnostics` panel: typed event timeline with trace/session/turn/task IDs.

### 18.4 Notification routing and policy

- Per-domain verbosity settings: `minimal | normal | verbose`.
- Per-surface routing: `conversation | status bar | panel only`.
- Quiet-while-typing policy to reduce prompt-area interruption.
- Batch/summarize repeated operational updates.

### 18.5 UI anti-regression test matrix (required)

- Simultaneous streaming + tool burst + agent burst + panel switching.
- Cancellation during heavy tool/agent updates.
- Resume/recovery with open overlays and active panels.
- Plugin reload while panels subscribed to plugin-provided streams.
- MCP reconnect/failure storms with notification throttling.


## 19) State Management Strategy: Zustand-First, XState-Ready

Decision:
- Start with Zustand-only for the unified runtime store.
- Design every critical domain with machine-shaped contracts so selective XState adoption is low-risk later.

### 19.1 Why this strategy

- Fast initial delivery and low ceremony (Zustand).
- Preserves ability to harden complex protocols later (XState where needed).
- Fits Bun + TypeScript execution model without adding early architectural drag.

### 19.2 Required constraints (non-optional)

1. No ad hoc direct `set` from arbitrary modules.
2. All runtime mutations go through typed domain dispatch APIs.
3. Transition logic remains pure and isolated from side effects.
4. Side effects run in explicit effect handlers.
5. Critical domains must maintain explicit state/event/guard/effect tables even before XState.

### 19.3 Stable domain dispatch API

Use stable entry points so engine internals can swap later:
- `dispatchTurnEvent(event)`
- `dispatchToolEvent(event)`
- `dispatchPermissionEvent(event)`
- `dispatchTaskEvent(event)`
- `dispatchAgentEvent(event)`
- `dispatchPluginEvent(event)`
- `dispatchMcpEvent(event)`
- `dispatchTransportEvent(event)`

### 19.4 XState migration triggers (when to promote a domain)

Promote a domain from custom transition engine to XState when any are true:
1. transition table exceeds maintainability threshold (e.g., >12 states or >30 transitions)
2. repeated async race bugs appear in the same domain
3. invariant violations persist despite typed reducers
4. reconnect/retry/backoff logic becomes multi-branch and hard to reason about
5. team velocity slows due to protocol ambiguity

### 19.5 Candidate domains for earliest XState adoption

- transport/session reconnect (ACP/daemon/remote)
- plugin lifecycle + hot reload
- MCP server lifecycle/auth/reconnect
- turn/tool execution protocol if race complexity rises

### 19.6 Migration mechanics (no API break)

- Keep domain dispatch API unchanged.
- Replace domain transition internals with XState interpreter.
- Preserve envelope/event types and selectors.
- Keep UI/components unaware of engine swap.

### 19.7 Sprint integration

- Tier 0-1: Zustand-first implementation with machine-shaped contracts.
- Tier 4-5: selective XState introduction for highest-complexity protocol domains.


## 20) OpenTelemetry Is a Core Workstream

OTel integration is now a first-class requirement in the runtime refactor.

### 20.1 Required outcomes

1. End-to-end traceability across turn/tool/permission/hook/task/agent/plugin/MCP/transport.
2. Correlation IDs propagated through all runtime events and domain transitions.
3. Local durable event ledger + optional OTLP export.
4. Telemetry health and diagnostics visible in TUI.

### 20.2 Architectural coupling

- Runtime store domains emit telemetry through typed wrappers.
- Protocol state machines emit transition spans and metrics.
- Export failures cannot block runtime behavior.

### 20.3 Implementation reference

- See `otel-integration-plan.md` in this directory for the concrete span/metric/export design.

### 20.4 Phased delivery (aligned to tiered execution)

OTel is delivered incrementally to avoid rewriting instrumentation as the runtime shape stabilizes:

- **Tier 0**: Correlation IDs (traceId, sessionId, turnId) baked into the event envelope standard (Section 5.3) from day one. This provides traceability with zero OTel dependency.
- **Tier 4**: OTel foundation — initialize tracer provider and meter provider. Emit interaction spans (turn lifecycle) and llm spans (provider calls). Wire into existing event wrappers.
- **Tier 5**: Full lifecycle instrumentation across all domains. Every state machine transition emits a span. Cross-machine correlation via parent-child span relationships.
- **Tier 6**: Export reliability — fail-safe local queue with retry and backoff for OTLP export. Export failures never block runtime behavior.
- **Tier 7**: OTel UX surfaces — telemetry diagnostics panel, span viewer, metric dashboards integrated into TUI.

Rationale: Deferring the full OTel setup until the runtime store shape stabilizes (post-Tier 3) avoids rewriting spans during early iterations. Correlation IDs in the event envelope provide traceability from day one without the instrumentation overhead.


## 21) Completion Tracks (Required Before "Done")

### 21.1 Compatibility and migration contracts

Add explicit versioning for:
- runtime state snapshots
- event envelope schemas
- session persistence format
- plugin manifest/capability schemas
- task record schemas

Rules:
- backward compatibility for at least one previous schema version
- migration registry with deterministic transforms
- downgrade-safe behavior for unsupported versions

### 21.2 Failure injection and chaos testing

Required fault scenarios:
- provider timeout and 429/5xx bursts
- hook hang and partial hook failures
- MCP reconnect flaps and auth-expiry loops
- ACP/daemon disconnect and replay mismatch
- plugin crash during reload and mid-turn
- session partial write and corrupted record recovery

### 21.3 Feature-flag rollout and kill switches

Gate high-risk areas:
- permissions-v2
- unified RuntimeTask adoption
- plugin lifecycle v2
- MCP lifecycle v2
- OTel remote export

Each gate needs:
- enable/disable at runtime config layer
- emergency kill switch behavior
- telemetry on gate state and rollbacks

### 21.4 Performance budgets and regression gates

Define measurable budgets for:
- frame latency under operational load
- event throughput and queue depth
- tool executor overhead
- memory growth in long sessions
- compaction latency and effectiveness

Fail CI on sustained budget regressions.

### 21.5 Security review framework

Maintain explicit threat model for boundaries:
- plugin contributions and capabilities
- daemon/http ingress
- ACP delegation channel
- MCP tool/resource calls
- permission parser and command normalization

Add security test packs for bypass attempts and malformed payloads.

### 21.6 Cross-subsystem contract tests

Add contract suites for:
- event payload and envelope validity
- tool runtime context invariants
- permission decision reason coverage
- task/agent transition legality
- transport message contract compatibility

### 21.7 Operational playbooks

Create runbooks for:
- stuck turn/task diagnosis
- reconnect failure diagnosis
- permission deadlock resolution
- plugin degradation handling
- telemetry/export pipeline recovery

### 21.8 UX quality gates

Define required UX guardrails per hardening sprint:
- conversation remains high-signal under burst load
- panel introspection remains usable at scale
- WRFC visibility/control is not degraded
- local model workflows remain first-class

## 22) Claude-Inspired Behaviors to Adopt (Styled for goodvibes)

1. Stop-reason taxonomy everywhere
- Every terminal path emits explicit reason enums for user visibility and debugging.

2. Compaction/session boundary semantics
- Boundary objects/messages and replay-safe slicing with lineage tracking.

3. First-class decision audit model
- Permission and policy decisions always include source + reason + mode context.

4. Retry classification policy
- Typed distinction between retryable/transient and terminal failures across providers/transports/hooks.

5. Deterministic transport lifecycle
- Explicit connection states, reconnect phases, and failure terminals for ACP/daemon/remote channels.

6. Guard-first safety invariants
- Final safety checks that cannot be bypassed by mode shortcuts.

7. Slow-phase diagnostics
- Phase-level latency instrumentation with warnings and remediation hints.

8. Continuation prevention semantics
- Hook/policy paths can deliberately prevent continuation with explicit typed outcome.


## 23) Cross-Machine Error Propagation Model

State machines do not operate in isolation. When one machine fails or degrades, dependent machines must respond predictably. This section defines the propagation model.

### 23.1 Error cascade rules

Cascade effects are declared in a typed `CascadeRule[]` table — not scattered in business logic:

| Source Machine | Source State | Cascade Target | Effect |
|---|---|---|---|
| Turn lifecycle | `failed` | Tool execution (active) | Cancel all in-flight tools |
| Tool execution | `failed` | Turn lifecycle | Transition to `tool_dispatch` error path (not automatic turn `failed`) |
| MCP server | `disconnected` | Tool execution (MCP tools) | Block MCP tool dispatch; queue or fail based on retry policy |
| Agent lifecycle | `failed` | Task lifecycle (owned tasks) | Mark child tasks `failed`; notify parent task |
| Plugin lifecycle | `error` | Tool execution (plugin tools) | Deregister plugin tools; fail in-flight plugin tool calls |
| ACP/daemon transport | `disconnected` | Task lifecycle (remote tasks) | Mark remote tasks `blocked`; start reconnect |
| Session recovery | `failed` | All machines | Emit `SESSION_UNRECOVERABLE`; surface to user |
| Compaction | `failed` | Turn lifecycle | Block new turns until compaction resolves or user intervenes |

### 23.2 Propagation mechanics

1. **Health-gated dispatch**: Each domain dispatch function checks upstream health before executing. If a required upstream is `failed` or `degraded`, the dispatch either queues (retryable) or rejects (terminal) with a typed reason.

2. **RuntimeHealthAggregator**: A composite health derivation service that:
   - Subscribes to all domain state machines
   - Computes per-domain health: `healthy | degraded | failed | unknown`
   - Computes aggregate system health from domain health
   - Exposes `canExecute(domain, operation)` guard for dispatch functions

3. **Declarative cascade table**: The `CascadeRule[]` is the single source of truth for cross-machine effects. Adding a new cascade is a data change, not a code change.

4. **Recovery-first policy**: When a source machine enters a failure state, the cascade engine:
   - Checks if the source has a retry/recovery policy
   - If yes: waits for recovery attempt before cascading
   - If no (or recovery fails): applies cascade effects to targets
   - Emits a `CASCADE_APPLIED` event with full trace context

### 23.3 Partial degradation model

Machines support a `degraded` state (not just binary healthy/failed):

- **Degraded** means reduced capability, not dead. Example: MCP tools unavailable but local tools work. Plugin providing 3 of 5 tools after partial reload failure.
- **Degraded propagation**: When a source is degraded, targets receive a `DEPENDENCY_DEGRADED` event. They can:
  - Continue with reduced capability (preferred)
  - Block operations that depend on the degraded capability
  - Surface degradation status to the user
- **UI degradation surfaces**: Each domain's health state is surfaced in the diagnostics panel. Degraded domains show which capabilities are reduced and what remediation is available.
- **Automatic recovery monitoring**: The health aggregator watches degraded domains for recovery events and automatically lifts cascade effects when the source recovers.


## 24) Domain Interaction Matrix

Explicit boundaries on which domains can read which other domains' state. This prevents implicit coupling from creeping back in.

### 24.1 Read access matrix

| Domain | Can Read |
|---|---|
| `turn` | model, permissions, tasks |
| `tool_execution` | permissions, tasks, mcp, plugins |
| `permissions` | session, model (for mode context) |
| `tasks` | agents (for ownership) |
| `agents` | tasks (for child tracking), session |
| `plugins` | mcp (for tool discovery) |
| `mcp` | providerHealth, session |
| `panels` | ALL (read-only view layer) |
| `telemetry` | ALL (observability layer) |
| `overlays` | session, conversation, permissions |
| `conversation` | session, model |
| `providerHealth` | model, session |
| `daemon` | session, acp |
| `acp` | session, daemon, tasks |
| `git` | session |
| `discovery` | session, git |
| `intelligence` | model, conversation, discovery |
| `uiPerf` | panels, overlays |
| `integrations` | session, plugins, mcp |

### 24.2 Interaction rules

1. **Read access is explicit**: Domains not listed as readers of another domain MUST NOT access that domain's state. Violations should be caught by lint rules or architectural tests.

2. **Write access is always through the owning domain's dispatch API**: No cross-domain direct mutation. `dispatchTaskEvent()` is the only way to mutate task state, regardless of caller.

3. **Read-only consumers**: `panels` and `telemetry` are pure read-only layers. They observe all domains but never dispatch mutations.

4. **Enforcement strategy**:
   - TypeScript module boundaries: each domain exports only selectors and dispatch functions
   - Architectural test: scan imports to verify no domain imports another domain's internal state
   - Runtime assertion (dev mode): log warnings when a domain selector is called from an unauthorized context


## 25) Testing Strategy for State Machines

### 25.1 Property-based testing for transition tables

Each state machine's transition table is a pure function `(state, event) → state`. This makes them ideal for property-based testing:

- **Invariant preservation**: "From any reachable state, applying any valid event sequence, no invariant (Section 12) is violated."
- **No dead states**: "Every state is reachable from the initial state via some event sequence."
- **No stuck states**: "From every non-terminal state, at least one event produces a transition."
- **Determinism**: "The same (state, event) pair always produces the same next state."

Use `fast-check` or equivalent property-based testing library. Generate random valid event sequences and verify properties hold across thousands of runs.

### 25.2 Contract tests between machines

Verify cross-machine behavior defined in Section 23:

- **Cascade correctness**: When source machine enters failure state, target machines receive the correct effect within the same event loop tick.
- **Partial degradation**: When a machine is degraded, dependent machines adjust behavior correctly (reduced capability, not full failure).
- **Recovery propagation**: When a machine recovers from failure/degraded, dependents resume normal operation. No stale cascade effects remain.
- **Interaction matrix compliance**: Verify that runtime access patterns match the declared matrix (Section 24).

### 25.3 Deterministic replay testing

- **Record**: During integration tests, record the full sequence of typed events emitted by all domain machines.
- **Replay**: Feed recorded event sequences into state machines from initial state. Verify the final state matches the recorded final state.
- **Regression**: Use recorded sequences as regression tests when transition tables change. If a table change alters replay outcomes, the test fails and forces explicit review.
- **Shrinking**: When a replay test fails, use property-based shrinking to find the minimal event sequence that reproduces the failure.


## 26) Devtools / State Inspector

A runtime state inspection capability for development and production debugging.

### 26.1 Capabilities

- **Live domain state viewer**: Shows current state of all 18 domain machines. Updated in real-time as transitions occur.
- **Transition history log**: Timestamped log of every state transition across all domains. Filterable by domain, event type, and time range.
- **Active subscription viewer**: Shows which UI components subscribe to which selectors. Helps diagnose render storms and unnecessary re-renders.
- **"Raw state" mode**: Full RuntimeState JSON snapshot, searchable and copyable. Useful for bug reports.
- **Health dashboard**: Composite health from RuntimeHealthAggregator (Section 23.2) with per-domain breakdown.

### 26.2 Integration

- Implemented as a tab within the diagnostics panel (Section 18.3), not a separate surface.
- Available in development mode by default.
- Optionally enabled in production via config flag for operator introspection.
- Reads state through the same typed selectors as UI (Section 18.1) — no special access paths.

### 26.3 Performance constraints

- State inspector must not degrade runtime performance when inactive.
- When active, transition history buffer is bounded (configurable, default 1000 entries).
- Subscription viewer uses sampling, not continuous monitoring.


## 27) Migration Cutover Strategy

How to get from the current codebase to the new runtime without a flag day.

### 27.1 Dual-write period

During migration, both old and new code paths run in parallel:

1. **Feature flags** (from Tier 1 kill switches) control which path is active for each domain.
2. **Comparison mode** (dev/staging only): Run both paths, compare outputs, log divergences. Old path remains source of truth.
3. **Gradual cutover**: Flip domains one at a time from old to new as confidence builds.

### 27.2 Per-domain cutover checklist

Each domain migrates independently behind its feature flag:

1. New domain state machine implemented and tested (unit + property-based)
2. Typed selectors wired and consumed by at least one UI component
3. Old code path wrapped with feature flag conditional
4. Dual-write comparison passing for N sessions (configurable, default 10)
5. Feature flag flipped to new path
6. Old path code removed and dead code cleaned
7. Tests updated to exercise new path only

### 27.3 Rollback safety

- **Every cutover must be reversible** by flipping the feature flag back to old path.
- **State must be reconstructable** from either path. No migration-only state that can't be derived from the old path.
- **Rollback is tested** as part of the cutover checklist: flip to new, run N sessions, flip back to old, verify no data loss or corruption.
- **Escape hatch**: If a domain's new path causes issues in production, the kill switch immediately reverts to the old path without restart.

### 27.4 Cutover sequencing

Recommended domain migration order (least risk first):

1. `telemetry` (read-only, no side effects)
2. `git`, `discovery` (isolated, low coupling)
3. `tasks`, `agents` (unified model, well-tested)
4. `permissions` (high impact, needs extensive dual-write comparison)
5. `turn`, `tool_execution` (critical path, migrate last)


## 28) Subscription Batching and Event Replay

### 28.1 Subscription batching

With 18 domains and multiple panels, naive selector subscriptions cause render storms during burst operations (e.g., tool dispatch firing 50 events in 100ms).

**Solution: `batchedSubscribe`**

- Coalesces state updates within a configurable batch window.
- For TUI rendering: batch window aligned to render frame (typically 16ms for 60fps or configurable for terminal refresh rate).
- Zustand's `subscribeWithSelector` provides per-selector granularity; `batchedSubscribe` adds temporal coalescing on top.

**Per-subscription configuration:**

| Surface | Batch Window | Rationale |
|---|---|---|
| Conversation panel | 0ms (immediate) | User-facing text must stream without delay |
| Status bar | 100ms | Aggregate status, doesn't need per-event updates |
| Tool calls panel | 50ms | Batch tool phase updates during bursts |
| Agents panel | 100ms | Agent state changes are less frequent |
| Diagnostics panel | 200ms | High-volume event stream, batching essential |

**Implementation notes:**
- `batchedSubscribe(selector, callback, { batchMs })` wraps Zustand subscribe
- During batch window, only the latest state snapshot is delivered (no intermediate states)
- If a subscriber needs every intermediate state (e.g., event ledger), use unbatched subscribe

### 28.2 Event replay for debugging

Every domain transition emits a typed event. These events form a replayable ledger.

**Design requirements:**

1. **Deterministic event ordering**: Monotonic revision counter per domain. Global ordering via lamport-style logical clock across domains.
2. **Pure transition functions**: Reducers must be side-effect-free. Given the same initial state and event sequence, the output state is identical.
3. **Serializable event payloads**: No functions, no circular references, no non-serializable types in event payloads. Enforced by compile-time type constraints.

**Replay modes:**

- **Full replay**: Reconstruct complete RuntimeState from initial state + event history. Used for bug reproduction from exported event logs.
- **Domain replay**: Reconstruct single domain's state from its event subsequence. Faster, useful for focused debugging.
- **Time-travel**: Step forward and backward through event history. Integrated with state inspector (Section 26) for visual debugging.

**Integration with OTel:**

The OTel event ledger (Section 20) can serve as the replay source when OTel is active (Tier 4+). Before Tier 4, the runtime maintains its own lightweight event buffer for replay (bounded, configurable size).

**Storage:**

- In-memory ring buffer (default 10,000 events) for live replay/time-travel.
- Optional file export for post-mortem analysis (JSON lines format).
- Export triggered manually via diagnostics panel or automatically on session crash.
