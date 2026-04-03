# goodvibes Post-v3 Deep Dive (Integrated Execution Plan)

Date: 2026-04-02
Scope: Post-v3 only. This document integrates feature expansion, interaction design, implementation shape, and gap-closure hardening into one cohesive plan.

## 1) Purpose and outcomes

This plan exists to do three things together:

1. ship post-v3 product features that improve operator power and UX
2. complete remaining hardening/completeness work so runtime discipline matches ambition
3. preserve goodvibes differentiators (panels, local workflows, WRFC, operator introspection)

Success means post-v3 features are fully usable, safety/determinism are hardened, and UX remains high-signal under load.

## 2) Product interaction model (single rule)

- Conversation: high-signal narrative, milestones, critical failures, concise summaries
- Panels: operational detail, diagnostics, historical timelines, intervention controls
- Commands: scriptable and explicit control path
- Config: default policy/mode behavior and rollout switches

Every capability must expose the same action through:
1. command
2. panel control
3. typed runtime dispatch API

No separate behavior per surface. One behavior, multiple entry points.

## 3) Capability map (what users see and where)

| Capability | Primary Surface | Command Surface | Why this surface split |
|---|---|---|---|
| Operator Control Plane | `Ops` panel | `/ops ...` | high-frequency operations + task/agent intervention |
| Deterministic Replay | `Replay` panel | `/replay ...` | timeline-heavy debugging |
| Policy-as-Code | `Policy` panel | `/policy ...` | simulation/diff/promote workflow |
| Evaluation Harness | `Eval` panel | `/eval ...` | benchmark runs + trend comparison |
| Adaptive Planner | `Ops` panel (strategy lane) | `/plan ...` | strategy decisions need operational context |
| Provider Optimizer | `Provider` panel | `/provider ...` | routing/fallback visibility |
| Tool Contract Verification | `Diagnostics` panel | `/tool verify...` | validation and failure evidence |
| Project Memory | `Memory` panel | `/memory ...` | searchable provenance and references |
| Extension Trust | `Plugins` panel | `/plugin trust|verify...` | capability and trust posture management |
| Failure Forensics | `Forensics` panel | `/forensics ...` | root-cause and remediation workflows |
| HITL UX Modes | settings + status bar | `/mode ...` | quick control over signal routing |
| Multi-session Orchestration | `Sessions` panel | `/session ...` | cross-session graph + control |

## 4) Implementation contracts (apply to all capabilities)

For each feature, implementation must include:

1. User surfaces
- command handlers
- panel controls
- optional keybindings
- config keys and defaults

2. Runtime contracts
- typed event definitions
- dispatch entry points
- guard rules
- reason codes

3. State wiring
- domain state fields
- selectors for UI
- migration/version handling for persisted fields

4. Safety and determinism
- permission path integration
- cancellation semantics
- idempotency/replay semantics documented and tested

5. Test coverage
- contract tests
- lifecycle transition tests
- failure/degradation tests
- integration tests for command+panel parity

## 5) Detailed capability specs

## 5.1 Operator Control Plane

User experience:
- panel: `Ops`
- commands: `/ops view`, `/ops task cancel <id>`, `/ops task pause <id>`, `/ops task resume <id>`, `/ops task retry <id>`, `/ops agent cancel <id>`
- keybind: `ctrl+o`

Implementation:
- task and agent control actions wired through runtime dispatch only
- controls rendered only when state machine allows action
- every intervention emits audit event with reason code

Core integration points:
- `src/runtime/tasks/*`
- `src/runtime/store/domains/agents.ts`
- `src/runtime/diagnostics/panels/tasks.ts`
- `src/runtime/diagnostics/panels/agents.ts`

Acceptance:
- no illegal action appears in UI
- intervention latency meets operational SLOs

## 5.2 Deterministic Replay

User experience:
- panel: `Replay`
- commands: `/replay load <runId>`, `/replay step [n]`, `/replay seek <rev>`, `/replay diff`, `/replay export <path>`
- keybind: `ctrl+r`

Implementation:
- replay engine consumes snapshot + typed event ledger
- stepwise transitions update replay-local state tree
- diff mode reports expected vs replayed mismatch with classifier

Core integration points:
- `src/core/event-replay.ts`
- `src/runtime/diagnostics/provider.ts`
- `src/runtime/diagnostics/panels/state-inspector.ts`
- `src/runtime/telemetry/exporters/local-ledger.ts`

Acceptance:
- replay is deterministic for recorded runs
- mismatch reports are actionable, not raw dumps

## 5.3 Policy-as-Code

User experience:
- panel: `Policy`
- commands: `/policy load`, `/policy simulate`, `/policy diff`, `/policy promote`, `/policy rollback`

Implementation:
- versioned policy bundles
- simulation mode compares simulated vs actual decisions
- divergence report gates enforcement rollout

Core integration points:
- `src/runtime/permissions/*`
- `src/runtime/feature-flags/*`
- diagnostics panel integration

Acceptance:
- no enforcement without simulation evidence
- divergence trends visible by command class/prefix

## 5.4 Evaluation Harness

User experience:
- panel: `Eval`
- commands: `/eval list`, `/eval run <suite>`, `/eval compare <baseline>`, `/eval gate <suite>`

Implementation:
- scenario runner uses production runtime paths
- scorecard covers safety, quality, latency, token/cost, recovery
- CI gates regressions against baseline

Core integration points:
- `src/runtime/perf/*`
- telemetry metrics and span exports
- eval runner module (new)

Acceptance:
- stable benchmark suite available
- CI fails on agreed regression thresholds

## 5.5 Adaptive Execution Planner

User experience:
- panel: `Ops` strategy timeline
- commands: `/plan mode auto|single|cohort|background|remote`, `/plan explain`, `/plan override <strategy>`

Implementation:
- planner scores strategy candidates using risk/latency/capability inputs
- selected strategy emits typed reason codes
- user override path remains explicit and logged

Core integration points:
- `src/core/orchestrator.ts`
- `src/scheduler/scheduler.ts`
- turn/task event domains

Acceptance:
- strategy choice always explainable
- override behavior deterministic

## 5.6 Provider Optimizer (adapter-first)

User experience:
- panel: `Provider`
- commands: `/provider route auto|manual`, `/provider explain-route`, `/provider pin <provider:model>`, `/provider fallback test`

Implementation:
- optimizer lives above provider implementations
- capability contracts drive route legality
- fallback transitions are logged and visible

Core integration points:
- `src/providers/interface.ts`
- `src/providers/registry.ts`
- `src/providers/model-catalog.ts`
- provider health domain

Acceptance:
- optimizer off => zero behavior change
- optimizer on => deterministic route explanations

## 5.7 Tool Contract Verification

User experience:
- panel: `Diagnostics`
- commands: `/tool verify <name>`, `/tool verify-all`, `/tool contract show <name>`

Implementation:
- registration-time contract checks:
  - schema validity
  - timeout/cancellation semantics
  - permission class mapping
  - output policy compatibility
  - idempotency declaration for side-effecting tools

Core integration points:
- `src/tools/registry.ts`
- `src/runtime/tools/registry-bridge.ts`
- `src/runtime/events/tools.ts`

Acceptance:
- invalid tools fail closed with actionable diagnostics

## 5.8 Project Memory Substrate

User experience:
- panel: `Memory`
- commands: `/memory add`, `/memory search`, `/memory link`

Implementation:
- durable memory classes: `decision`, `constraint`, `incident`, `pattern`
- provenance links (session/turn/task/event/file)
- retrieval API for runtime/panel/context enrichment

Core integration points:
- `src/state/*` (new memory store)
- `src/sessions/*`
- orchestrator/context wiring

Acceptance:
- memory retrieval returns provenance-rich records
- memory can be cited in operator workflow

## 5.9 Extension Trust Framework

User experience:
- panel: `Plugins`
- commands: `/plugin trust`, `/plugin verify`, `/plugin capabilities`, `/plugin quarantine`

Implementation:
- trust tiers: `untrusted`, `limited`, `trusted`
- signed manifest validation for trusted tier
- capability enforcement bridged into permission engine

Core integration points:
- `src/runtime/plugins/*`
- `src/plugins/*`
- runtime permissions bridge

Acceptance:
- high-risk capabilities require explicit trust escalation
- quarantine path removes unsafe contribution effects

## 5.10 Failure Forensics

User experience:
- panel: `Forensics`
- commands: `/forensics latest`, `/forensics show <id>`, `/forensics export <id>`

Implementation:
- automatic failure report on terminal states
- causal chain from phase timings + cascade events + stop reasons
- jump links to replay and relevant diagnostics

Core integration points:
- `src/runtime/ops/*`
- health cascade and telemetry spans

Acceptance:
- majority of failures auto-classified without manual log spelunking

## 5.11 HITL UX Modes

User experience:
- surfaces: settings modal + status bar
- commands: `/mode quiet|balanced|operator`, `/mode show`, `/mode set-domain <domain> <verbosity>`

Implementation:
- per-domain verbosity and routing policies
- quiet-while-typing and batching policy integration
- mode state visible globally

Core integration points:
- `src/runtime/notifications/*`
- `src/state/mode-manager.ts`

Acceptance:
- burst operations do not flood conversation in quiet/balanced modes

## 5.12 Multi-session Orchestration

User experience:
- panel: `Sessions`
- commands: `/session link-task`, `/session handoff`, `/session graph`, `/session cancel --scope ...`

Implementation:
- global task references across sessions
- status and dependency propagation
- scoped cancellation semantics

Core integration points:
- `src/runtime/tasks/*`
- `src/sessions/manager.ts`
- `src/runtime/remote/sync.ts`

Acceptance:
- cross-session task graph stays consistent through reconnect/resume

## 6) Integrated hardening and gap closure

These are mandatory post-v3, not optional add-ons.

P0 (first):
1. command/tool safety hardening
- strict command segmentation verdicts
- fetch sanitization tiers and SSRF-deny telemetry
- policy provenance and source attribution

2. deterministic side-effect control
- idempotency keys at command and tool-call layers
- dedupe across replay/reconnect/restart

3. orchestrator invariants
- unresolved tool-result reconciliation
- terminal stop-reason consistency checks

P1 (next):
1. provider routing completeness via capability contracts
2. extension trust maturity (tiers + signature flow + capability enforcement)
3. MCP resilience (schema-drift quarantine + remediation UX)

## 7) Remaining v3.1 completion work (current baseline)

Baseline status:
- SLO gates: partial
- unified tool output policy contract: partial
- permissions simulation mode: missing/minimal
- command/tool idempotency and dedupe: partial
- snapshot retention/pruning policy: partial
- provider capability registry: missing/minimal

This section is the concrete closure plan for those six items.

### 7.1 SLO gates (complete from partial)

What exists:
- perf budget framework and CI check (`src/runtime/perf/*`, `scripts/perf-check.ts`)

What to add:
- hard SLO metrics and gates for:
  - `turn_start_ms`: `TURN_SUBMITTED -> first stream delta`
  - `cancel_ms`: cancel request -> confirmed stopped
  - `reconnect_recovery_ms`: disconnect -> operational
  - `permission_decision_ms`: tool received -> decision emitted

Implementation scope:
- `src/runtime/telemetry/spans/{turn,transport,permission,task}.ts`
- `src/runtime/perf/{types,monitor,budgets,reporter}.ts`
- diagnostics status rows in `src/runtime/diagnostics/panels/health.ts`

Tests:
- contract tests for metric emission
- perf regression tests for threshold/tolerance behavior
- CI gate test proving failure on sustained breach

Done criteria:
- all four SLOs visible in diagnostics
- CI gate enforces thresholds and blocks regressions

### 7.2 Unified tool output policy contract

What exists:
- per-tool verbosity/tokens and overflow handling (`read/write/edit/exec/fetch/find`, `overflow.ts`)

What to add:
- one runtime contract applied to all tools:
  - tool class
  - size/token caps
  - truncation mode
  - spill mode
  - audit metadata (`policyId`, `actionTaken`)

Implementation scope:
- new contract in `src/runtime/tools/types.ts`
- enforcement in `src/runtime/tools/phases/map-output.ts`
- adapter hooks in `src/runtime/tools/adapter.ts`
- tool-class mappings in `src/tools/index.ts` or runtime bridge

Tests:
- per-tool conformance tests
- oversize output behavior tests (truncate/spill/reference)
- audit metadata presence tests

Done criteria:
- no tool can emit output without passing through output policy
- every transformed result includes policy audit fields

### 7.3 Permissions simulation mode

What exists:
- layered evaluator and decision logging (`src/runtime/permissions/{evaluator,decision-log}.ts`)

What to add:
- simulation pipeline with dual evaluation:
  - `actualDecision`
  - `simulatedDecision`
  - divergence classification
- rollout modes:
  - `simulation-only`
  - `warn-on-divergence`
  - `enforce`

Implementation scope:
- `src/runtime/permissions/index.ts`
- evaluator wrapper in `src/runtime/permissions/evaluator.ts`
- feature flags in `src/runtime/feature-flags/*`
- diagnostics timeline in `src/runtime/diagnostics/panels/events.ts`

Tests:
- divergence generation and bucketing
- mode transition tests
- enforcement lockout when divergence threshold exceeded

Done criteria:
- divergence report queryable by tool class and command prefix
- enforcement mode blocked unless divergence gate passes

### 7.4 Idempotency and dedupe (command/tool layers)

What exists:
- idempotency on remote reconnect transport path (`src/runtime/remote/reconnect.ts`)

What to add:
- command submission key and tool-call idempotency key in core runtime paths
- duplicate suppression for reconnect/replay/restart
- prior-result or in-flight reference behavior for duplicates

Implementation scope:
- `src/core/orchestrator.ts` (command submission key)
- `src/runtime/tools/phased-executor.ts` (tool call idempotency)
- `src/runtime/tasks/{manager,registry}.ts` (dedupe state)
- `src/sessions/manager.ts` (resume dedupe)

Tests:
- duplicate submit tests
- reconnect replay duplication tests
- restart/resume dedupe tests

Done criteria:
- duplicate side effects = zero in chaos/replay suites
- duplicate requests return deterministic reference behavior

### 7.5 Snapshot retention and pruning policy

What exists:
- compaction lifecycle + boundary commit + resume repair (`src/runtime/compaction/*`)

What to add:
- explicit retention classes (`short`, `standard`, `forensic`)
- checkpoint cadence policy (N revisions or T minutes)
- segment pruning policy with fallback restore path

Implementation scope:
- `src/runtime/compaction/{types,manager}.ts`
- `src/sessions/manager.ts`
- optional ledger integration in `src/runtime/telemetry/exporters/local-ledger.ts`

Tests:
- retention pruning tests
- corrupted-latest-checkpoint fallback tests
- long-session bounded growth tests

Done criteria:
- storage growth bounded by configured retention profile
- resume succeeds from latest valid checkpoint + replay segment

### 7.6 Provider capability registry

What exists:
- base provider interface and scattered capability signals

What to add:
- unified capability contract per provider/model:
  - streaming
  - tool-calling
  - parallel tools
  - json mode
  - reasoning controls
  - context/output limits
  - timeout policy
- capability-driven route legality and fallback planning

Implementation scope:
- `src/providers/interface.ts` (contract types)
- `src/providers/model-catalog.ts` (capability records)
- `src/providers/registry.ts` (route/fallback decisions)
- provider health surfacing in `src/runtime/store/domains/provider-health.ts`

Tests:
- capability compatibility tests by request profile
- deterministic routing tests
- unsupported-feature early-fail tests

Done criteria:
- routing decisions are fully explainable from capability contracts
- unsupported requests fail early with typed reason codes

### 7.7 Cross-item completion gates

All six items are “done” only if:
1. diagnostics visibility is present
2. feature flags and kill switches exist
3. contract/lifecycle/failure tests pass
4. rollout can be reversed without restart/data corruption

### 7.8 Comparison-derived closure backlog (explicit)

This is the concrete closure list imported from `goodvibes-claude-gap-roadmap-from-9257788.md`.
These are not optional and are tracked in addition to 7.1-7.7.

Runtime architecture:
1. Add import-boundary CI enforcement for domain read rules (`runtime/store` + architecture tests).
2. Ban raw event emission outside typed wrappers (`runtime/events` + lint rule).
3. Add per-cascade SLO alerts and remediation bindings (`runtime/health/*` + diagnostics).

Tool/runtime hardening:
1. Enforce strict budget contracts (`maxTokens/maxMs/maxCost`) at runtime phase boundaries.
2. Add shell AST normalization and per-segment verdicts for exec.
3. Add fetch response-class sanitizers, host reputation tiers, SSRF deny telemetry.
4. Add deterministic schema fingerprints for find/analyze/inspect outputs.
5. Add configurable overflow spill backends and retention policy.

Permissions/policy:
1. Add simulation-vs-enforcement divergence dashboard by command class/prefix.
2. Add tokenizer fuzzing and pathological input protections.
3. Add signed policy bundle provenance and managed-policy validation.

Agents/tasks/transport:
1. Add mailbox protocol versioning + dead-letter handling.
2. Add task snapshot leases + dedupe keys across restart/reconnect.
3. Add transport compatibility matrix + negotiated protocol downgrade.
4. Add unresolved tool-result reconciliation + stop-reason consistency assertions in orchestrator.

MCP/plugins/extensions:
1. Add MCP schema-drift quarantine + per-server policy templates.
2. Add plugin trust tiers and signed manifest validation path.
3. Add per-hook isolation classes + timeout recovery behavior.

Sessions/compaction/replay:
1. Add compaction quality scoring and fallback strategy switching.
2. Add replay determinism CI checks on recorded ledgers.
3. Add replay mismatch classifier + auto-minimized failing sequence output.

Provider/intelligence/integrations:
1. Add provider capability contracts as single routing truth.
2. Add adaptive notification suppression by typing/operator mode.
3. Add integration delivery SLOs + dead-letter queue + retry classification.
4. Add token scope minimization + rotation cadence audits for auth surfaces.

UI/panels/diagnostics:
1. Add per-panel capability/resource contracts (`cpu/io/update budget`) and health states.
2. Add actionable diagnostics controls (replay-load, policy-simulate, jump-to-fix).
3. Add state inspector time-travel and selector hotspot analysis.

### 7.9 Execution packets for 7.8 backlog (implementation-grade)

Each packet below is executable as-is.

#### GC-ARCH-001 Domain import boundaries

Scope:
- `src/runtime/store/domains/*`
- architecture test folder (`src/test/contracts/*` or equivalent)
- lint config/rules

User surface impact:
- none (internal reliability)

Runtime contracts:
- explicit domain read matrix enforced in tests

Implementation:
1. add `domain-read-matrix.ts` as single source of truth
2. add import scanner test that fails on unauthorized domain internal imports
3. add lint rule alias to prevent deep internal imports between domains

Tests:
- `domain-boundary-contract.test.ts`

Acceptance:
- unauthorized cross-domain import fails CI

Rollback:
- feature flag not required; rollback by reverting boundary rule file and test

#### GC-ARCH-002 Typed emission enforcement

Scope:
- `src/runtime/events/*`
- `src/runtime/emitters/*`
- lint config

User surface impact:
- none

Runtime contracts:
- raw event emission disallowed outside wrapper modules

Implementation:
1. add lint pattern blocking direct `bus.emit(...)` outside approved files
2. expose wrapper-only emitter APIs
3. replace remaining direct emissions with wrapper calls

Tests:
- static lint test in CI

Acceptance:
- zero raw emissions outside allowlist

Rollback:
- temporary lint suppression list if migration is incomplete

#### GC-HEALTH-003 Cascade SLO and remediation binding

Scope:
- `src/runtime/health/*`
- `src/runtime/diagnostics/panels/health.ts`
- `src/runtime/ops/playbooks/*`

User surface impact:
- diagnostics panel health rows + remediation jump actions

Runtime contracts:
- cascade events include latency/severity/remediation identifiers

Implementation:
1. attach timing instrumentation to cascade applications
2. map cascade types -> playbook ids
3. render actionable remediation in health panel

Tests:
- cascade timing emission test
- playbook mapping completeness test

Acceptance:
- each cascade type shows SLO status and at least one remediation action

Rollback:
- disable remediation links via config while retaining diagnostics

#### GC-TOOL-004 Runtime budget enforcement

Scope:
- `src/runtime/tools/phases/*`
- `src/runtime/tools/context.ts`

User surface impact:
- tool-call panel shows budget-exceeded reason codes

Runtime contracts:
- `BUDGET_EXCEEDED_MS`, `BUDGET_EXCEEDED_TOKENS`, `BUDGET_EXCEEDED_COST`

Implementation:
1. enforce budget checks at phase entry/exit
2. terminate phase on hard exceed with typed reason
3. emit budget breach events for diagnostics

Tests:
- per-phase exceed test vectors

Acceptance:
- no phase ignores explicit budget limits

Rollback:
- budget enforcement flag (`runtime.tools.budget_enforcement`)

#### GC-EXEC-005 Shell AST normalization and verdicts

Scope:
- `src/runtime/permissions/normalization/*`
- `src/tools/exec/*`

User surface impact:
- exec denials include segmented command explanation

Runtime contracts:
- per-segment decision records

Implementation:
1. parser produces segment AST for compound commands
2. evaluate policy per segment, aggregate final verdict
3. include segment reasons in denial output

Tests:
- compound command corpus tests
- obfuscation/bypass tests

Acceptance:
- mixed commands correctly deny unsafe segments

Rollback:
- fall back to legacy segmentation mode behind flag

#### GC-FETCH-006 Fetch sanitization and host trust tiers

Scope:
- `src/tools/fetch/*`
- `src/runtime/permissions/rules/network-scope.ts`

User surface impact:
- fetch output indicates sanitization tier
- policy panel shows host trust classification

Runtime contracts:
- `SANITIZE_MODE_APPLIED`, `HOST_TRUST_TIER`, `SSRF_DENY`

Implementation:
1. add response sanitizer modes (`none`, `safe-text`, `strict`)
2. add host trust tiers (`trusted`, `unknown`, `blocked`)
3. emit SSRF-specific deny telemetry

Tests:
- SSRF vector tests
- sanitizer output conformance tests

Acceptance:
- blocked hosts denied pre-request
- sanitizer mode deterministic and auditable

Rollback:
- default tier to `safe-text` and allow override in config

#### GC-TOOL-007 Output schema fingerprints

Scope:
- `src/tools/find/index.ts`
- `src/tools/analyze/index.ts`
- `src/tools/inspect/index.ts`

User surface impact:
- tool-call panel shows schema fingerprint for result payload

Runtime contracts:
- `outputSchemaFingerprint` in tool result metadata

Implementation:
1. define canonical schema shape ids per output mode
2. compute and append fingerprint on output
3. surface fingerprint in diagnostics

Tests:
- fingerprint stability tests

Acceptance:
- same mode/input class produces stable fingerprint

Rollback:
- allow fingerprint omission via compatibility flag

#### GC-TOOL-008 Overflow backend and retention policy

Scope:
- `src/tools/shared/overflow.ts`
- `src/runtime/tools/phases/map-output.ts`

User surface impact:
- overflow references indicate backend type

Runtime contracts:
- `spillBackend: file|ledger|diagnostics`

Implementation:
1. add pluggable spill backend interface
2. add retention policy per backend
3. expose cleanup command for operators

Tests:
- backend switching tests
- retention pruning tests

Acceptance:
- spill backend configurable without code changes

Rollback:
- pin backend to `file` mode

#### GC-PERM-009 Divergence dashboard and gating

Scope:
- `src/runtime/permissions/*`
- `src/runtime/diagnostics/panels/events.ts`

User surface impact:
- policy panel/divergence diagnostics visible

Runtime contracts:
- divergence event types and aggregates

Implementation:
1. aggregate divergence by tool/prefix/mode
2. enforce gate threshold before enable enforce mode
3. expose trend history in diagnostics

Tests:
- threshold gate tests

Acceptance:
- enforce mode blocked on unhealthy divergence

Rollback:
- switch to `warn` mode via feature flag

#### GC-PERM-010 Tokenizer fuzz and pathological guards

Scope:
- `src/runtime/permissions/normalization/tokenizer.ts`
- fuzz corpus under tests

User surface impact:
- none

Runtime contracts:
- bounded tokenizer runtime and token count

Implementation:
1. add max input length/token count safeguards
2. add fuzz seed corpus and property tests

Tests:
- fuzz/property test suite in CI

Acceptance:
- pathological inputs cannot hang parser/evaluator

Rollback:
- emergency hard cut length fallback

#### GC-PERM-011 Policy signing and provenance

Scope:
- `src/runtime/permissions/*`
- config/policy loader modules

User surface impact:
- policy panel shows signature/provenance status

Runtime contracts:
- `policyBundleId`, `signatureStatus`, `provenanceSource`

Implementation:
1. add signature validation step on policy load
2. attach provenance to each decision record

Tests:
- unsigned/invalid signature behavior tests

Acceptance:
- managed mode rejects invalid signature bundles

Rollback:
- allow unsigned in non-managed mode only

#### GC-AGENT-012 Mailbox versioning and dead-letter

Scope:
- `src/agents/message-bus.ts`
- `src/agents/orchestrator.ts`

User surface impact:
- agent panel shows dead-letter count and recovery actions

Runtime contracts:
- mailbox protocol version in message envelope

Implementation:
1. version message envelope
2. route failed/expired messages to dead-letter queue
3. add replay/retry action from panel

Tests:
- version compatibility tests
- dead-letter routing tests

Acceptance:
- no silent message loss between agents

Rollback:
- compatibility shim for previous envelope version

#### GC-TASK-013 Task lease and dedupe keys

Scope:
- `src/runtime/tasks/{types,manager,registry}.ts`
- `src/sessions/manager.ts`

User surface impact:
- tasks panel shows lease owner/state

Runtime contracts:
- `taskLeaseId`, `dedupeKey`, `leaseExpiresAt`

Implementation:
1. add lease fields and dedupe key
2. enforce single-owner updates by lease check
3. resume path reacquires/repairs leases

Tests:
- lease conflict and recovery tests

Acceptance:
- duplicate task execution suppressed across restart/reconnect

Rollback:
- disable lease enforcement but keep dedupe checks

#### GC-REMOTE-014 Transport compatibility matrix

Scope:
- `src/runtime/remote/transport-contract.ts`
- `src/runtime/remote/reconnect.ts`
- `src/runtime/remote/types.ts`

User surface impact:
- diagnostics transport panel shows negotiated version/mode

Runtime contracts:
- negotiated protocol version and downgrade reason

Implementation:
1. define compatibility matrix
2. negotiate version during handshake
3. degrade gracefully with explicit reason codes

Tests:
- compatibility negotiation tests

Acceptance:
- incompatible peer cannot proceed silently

Rollback:
- hard fail mode for strict compatibility deployments

#### GC-ORCH-015 Unresolved tool result reconciliation

Scope:
- `src/core/orchestrator.ts`

User surface impact:
- conversation/system message for synthetic reconciliation when needed

Runtime contracts:
- terminal turn invariants for tool result resolution

Implementation:
1. detect unresolved tool calls at turn end
2. synthesize typed error result when needed
3. enforce stop-reason completeness on terminal states

Tests:
- malformed provider response tests

Acceptance:
- no turn exits with dangling tool-call state

Rollback:
- compatibility mode allows legacy handling with warning

#### GC-MCP-016 Schema drift quarantine

Scope:
- `src/runtime/mcp/{manager,schema-freshness,lifecycle}.ts`

User surface impact:
- MCP panel shows `quarantined` status and remediation action

Runtime contracts:
- freshness state includes `quarantined`

Implementation:
1. mark stale/incompatible schemas as quarantined
2. block execution until refresh/approve action

Tests:
- stale schema execution block tests

Acceptance:
- MCP tools cannot execute on quarantined schema

Rollback:
- allow temporary override with explicit operator acknowledgment

#### GC-PLUGIN-017 Plugin trust tiers and signatures

Scope:
- `src/runtime/plugins/{manifest,lifecycle,manager}.ts`
- `src/plugins/*`

User surface impact:
- plugin panel shows trust tier and signature status

Runtime contracts:
- `trustTier`, `signatureStatus`, `capabilityRisk`

Implementation:
1. trust tier assignment at load
2. signature verification for trusted tier
3. capability enforcement based on tier

Tests:
- trust escalation and quarantine tests

Acceptance:
- high-risk capability plugins cannot run trusted paths unsigned

Rollback:
- default all plugins to `limited` tier

#### GC-HOOK-018 Hook isolation and timeout recovery

Scope:
- `src/hooks/*`
- `src/runtime/tools/phases/{prehook,posthook}.ts`

User surface impact:
- diagnostics shows hook isolation mode and timeout events

Runtime contracts:
- hook outcome codes (`completed`, `timed_out`, `isolated_failed`)

Implementation:
1. define isolation classes for hook runners
2. enforce timeout and fallback behavior by class

Tests:
- hook hang and crash containment tests

Acceptance:
- hook failures cannot deadlock turns

Rollback:
- set hooks to non-blocking mode globally

#### GC-COMP-019 Compaction quality scoring

Scope:
- `src/runtime/compaction/{manager,strategies/*}.ts`

User surface impact:
- compaction diagnostics show score and strategy switch reason

Runtime contracts:
- compaction score event payload

Implementation:
1. add quality score function (compression + semantic retention signals)
2. auto-switch strategy on low score

Tests:
- strategy switch tests by score threshold

Acceptance:
- low-quality compaction auto-corrects strategy path

Rollback:
- disable auto-switch; keep scoring telemetry

#### GC-REPLAY-020 Determinism CI and mismatch minimizer

Scope:
- `src/core/event-replay.ts`
- test harness modules

User surface impact:
- replay panel shows minimized failing sequence

Runtime contracts:
- mismatch classifier enum

Implementation:
1. deterministic replay check suite in CI
2. minimizer for failing event sequences

Tests:
- deterministic replay regression tests

Acceptance:
- CI fails on nondeterministic replay drift

Rollback:
- soft-fail mode with warning for transitional releases

#### GC-PROV-021 Capability-driven routing and fallback legality

Scope:
- `src/providers/{interface,model-catalog,registry}.ts`

User surface impact:
- provider panel shows route rationale and fallback legality

Runtime contracts:
- provider capability record per model

Implementation:
1. define capability contract
2. enforce route eligibility from contract
3. expose fallback chain and reason codes

Tests:
- route legality tests by request profile

Acceptance:
- routing decisions fully explainable from capability table

Rollback:
- manual routing override via config

#### GC-NOTIF-022 Adaptive suppression by typing/operator mode

Scope:
- `src/runtime/notifications/{router,policies/*}.ts`
- `src/state/mode-manager.ts`

User surface impact:
- reduced conversation noise under burst load

Runtime contracts:
- notification routing reason codes

Implementation:
1. routing policy uses typing + mode context
2. batch repeated operational events

Tests:
- burst notification routing tests

Acceptance:
- conversation stays high-signal in quiet/balanced modes

Rollback:
- revert to static routing policy

#### GC-INT-023 Integration delivery SLO + dead-letter

Scope:
- `src/integrations/*`
- telemetry/perf metrics for delivery outcomes

User surface impact:
- integration diagnostics show queue/dead-letter status

Runtime contracts:
- delivery outcome taxonomy (`delivered`, `retrying`, `dead_letter`)

Implementation:
1. classify retryable vs terminal delivery failures
2. add dead-letter storage and replay command

Tests:
- retry/backoff + dead-letter replay tests

Acceptance:
- failed deliveries never disappear silently

Rollback:
- disable dead-letter replay action while preserving logs

#### GC-SEC-024 Token scope and rotation audits

Scope:
- `src/security/*`
- config/runtime policy references

User surface impact:
- security diagnostics display token scope and age

Runtime contracts:
- token metadata events for rotation and scope validation

Implementation:
1. enforce minimum scope principle checks
2. add rotation cadence audits and warnings

Tests:
- scope minimization tests
- rotation expiry warning tests

Acceptance:
- out-of-policy tokens are flagged and blocked in managed mode

Rollback:
- downgrade blocking checks to warnings in non-managed mode

#### GC-UI-025 Panel resource contracts and health

Scope:
- `src/panels/*`
- `src/runtime/perf/*`
- diagnostics panel set

User surface impact:
- panel health indicators and throttle status

Runtime contracts:
- per-panel budget/health state schema

Implementation:
1. define panel resource contract
2. monitor panel update cost and rate
3. degrade/throttle heavy panels automatically

Tests:
- render storm containment tests

Acceptance:
- panel overload does not cascade into global UI degradation

Rollback:
- disable auto-throttle and keep monitoring-only mode

#### GC-DIAG-026 Actionable diagnostics controls

Scope:
- `src/runtime/diagnostics/panels/*`

User surface impact:
- one-click actions from diagnostics:
  - load replay
  - run policy simulation
  - jump to related task/tool/agent

Runtime contracts:
- diagnostic action event types and permission checks

Implementation:
1. add action dispatch bindings to diagnostics entries
2. wire actions into existing command handlers

Tests:
- diagnostics action integration tests

Acceptance:
- every high-severity diagnostic has at least one remediation action

Rollback:
- hide action buttons behind feature flag

#### GC-INSPECT-027 State inspector time-travel and hotspots

Scope:
- `src/runtime/ui/state-inspector/*`
- diagnostics state-inspector panel

User surface impact:
- time-travel replay controls
- selector hotspot analysis view

Runtime contracts:
- inspector timeline event format

Implementation:
1. add timeline buffer + step controls
2. track selector update frequencies and expensive subscribers

Tests:
- timeline correctness tests
- hotspot sampler accuracy tests

Acceptance:
- operator can isolate render/subscription hotspots from UI

Rollback:
- disable hotspot sampling while preserving snapshots

## 8) Delivery sequence (execution-ready)

Order:
1. finish remaining `v3.1` items
2. execute P0 hardening
3. ship capabilities in parallel groups
4. execute P1 hardening
5. run integration/eval/release gates

Parallel capability groups:
- Group A: Operator Control Plane + Adaptive Planner + HITL Modes
- Group B: Replay + Failure Forensics
- Group C: Policy-as-Code + Tool Contract Verification
- Group D: Eval Harness
- Group E: Provider Optimizer + Provider capability contracts
- Group F: Project Memory + Multi-session Orchestration
- Group G: Extension Trust

## 9) Execution packet format (for agent handoff)

Every task must include:
1. ID and exact file/module scope
2. user surface changes (command/panel/key/config)
3. runtime contract changes (events/selectors/guards/reason codes)
4. safety/reliability implications (permissions/cancel/idempotency/replay)
5. test plan (contract/lifecycle/failure/integration)
6. acceptance checks
7. rollback path (flag + kill switch)

## 10) Final release gates

Gate 1: Safety
- permission and tool safety paths are auditable and fail-closed

Gate 2: Determinism
- replay and reconnect avoid duplicate side effects
- orchestrator invariants hold

Gate 3: Performance
- SLO and budget gates pass under representative load

Gate 4: Operability
- diagnostics, replay, forensics are operator-usable

Gate 5: Product quality
- all post-v3 capabilities are activatable and coherent
- conversation remains high-signal under burst load
