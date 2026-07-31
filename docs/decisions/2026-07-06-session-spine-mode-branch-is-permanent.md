# Decision: the session-spine mode branch (`syncSessionSpineToHostStatus`) is permanent design, not a staging escape hatch — embedded/in-process operation stays

Date: 2026-07-06
Scope: a prior cleanup pass's scheduled removal 2 — "TUI staged-switch escape hatch"
Status: accepted; superseded in part 2026-07-31 by the daemon/TUI split (Phase A) and
daemon-hosted sessions (Phase B) — see "Updated 2026-07-31" at the end. The 2026-07-06 ruling
below is kept as written, because what it parked is the thing that later landed.
Repo: goodvibes-tui (the mode branch is TUI-owned; the SDK pieces it calls are read-only references)

## Premise (orchestrator ruling, binding)

Mike's D7a decision shipped detached-daemon-by-default with `daemon.embedInProcess` as an
explicit, documented, opt-in topology (default `false`, "NOT RECOMMENDED" for the reasons
in its own description — coupling the daemon's lifetime to one surface — but a real,
supported mode). Nothing in that prior cleanup pass or any earlier one retired it. The ruling for this brief,
recorded here as the premise the rest of this document works from:

> Embedded/in-process daemon operation STAYS. It is a permanent topology, not a staging
> vestige left over from the earlier spine conversion.

This closes the "OPEN CALL surfaced to the orchestrator" that the prior cleanup pass's brief left
unresolved: whether embedded/in-process operation was being retired at all. It is not.

## Context

The prior cleanup pass's ledger scheduled a second breaking removal alongside the `danger.daemon` alias
drop: "the TUI staged spine-client conversion escape hatch (an earlier multi-step change landed the
conversion; the mode-driven legacy fallback is the staging residual)." Unlike the
`danger.daemon` removal, this one shipped with **no decision record** and an explicitly
flagged ambiguity: there is no boolean flag, env var, or feature flag gating the spine.
The "escape hatch" is `syncSessionSpineToHostStatus` in `src/runtime/bootstrap.ts:393-441`,
a branch on the daemon's `HostServiceMode` (`'disabled' | 'embedded' | 'external' |
'blocked' | 'incompatible' | 'unavailable'`, from
`@pellux/goodvibes-sdk/platform/runtime/bootstrap-services.ts:127`):

- `mode !== 'external'` (bootstrap.ts:394-407): the spine stays dormant/deactivated and
  `sessionUnionCache` stays local-only (or marks itself embedded — see below). This is the
  branch the prior cleanup pass's provisional language called "legacy fallback."
- `mode === 'external'` (bootstrap.ts:408-440): the spine activates against the adopted
  daemon's HTTP transport, folds legacy pre-spine session data in once, and the read
  facade (`sessionUnionCache`) becomes the wire-backed cross-surface union.

The brief's own investigation (binding_architectural_findings, item "REMOVAL 2") had
already flagged the caveat that makes this ambiguous: `embedded` and `external` are
**different daemon topologies**, not two ends of one staged rollout. `embedded` means this
TUI process *is* the daemon (there is nothing to mirror — the local broker already is the
daemon's broker). `external` means this TUI adopted a separate, detached daemon process and
mirrors its own session identity into it. Collapsing the branch to "always mirror" would be
wrong for embedded — there is no second process to mirror to.

## Investigation (this brief)

Re-verified against the current code (not the brief's snapshot) that nothing changed the
premises:

1. **No staging flag exists.** Grepped `src/runtime/bootstrap.ts`,
   `bootstrap-core.ts`, `ui-services.ts`, `session-picker-modal.ts`, the config schema, and
   `FEATURE_FLAG_MAP` for anything gating spine activation — no config key, env var, or
   feature flag does. The only input to the branch is the daemon's own adopt-or-start
   `HostServiceMode`, which is a live runtime fact (what actually happened when this
   surface tried to reach a daemon), not a staging toggle.

2. **`daemon.embedInProcess` is real and current**, not a residual: SDK
   `schema-domain-core.ts:98-101` (`DEFAULT_CONFIG`) and its schema entry (`:600-606`)
   describe it as a supported, documented, currently-shipping opt-in ("host the daemon
   INSIDE this surface process instead of spawning it detached"), with the D7a-era
   detached-spawn-by-default behavior implemented in `bootstrap-services.ts` (SDK,
   `startExternalServices`/adopt-or-start path, `createServiceStatus('embedded', ...)` at
   `:624-625` and the in-process fallback at `:667-671` when a detached spawn doesn't
   become reachable in time). Embedded is an active code path today, exercised by real
   fallback logic, not dead scaffolding.

3. **The SDK's `SessionSpineClient` dormant-until-`activate()` mode is itself documented as
   permanent parameterization, not a staging artifact.** Its module doc
   (`platform/runtime/session-spine/client.ts:22-26`) states the client is constructed
   "WITHOUT [a transport] for dormant-until-`activate()` mode (the TUI — activated once its
   bootstrap adopts a compatible external daemon, deactivated when the mode is lost)" as one
   of two supported activation modes (the other being the agent's always-live mode). This
   is a designed capability of the shared core, not a leftover half-migrated state.

4. **The parallel-write mirror stays a mirror, not authoritative — by design,
   not oversight.** `bootstrap-core.ts:742-745` registers the local session with the spine
   fire-and-forget, alongside (never instead of) the still-authoritative local
   `SharedSessionBroker`. Making the spine authoritative (dropping the local broker as the
   source of truth) is a materially larger architectural change than "retire a staging
   escape hatch," is not implied by anything Mike ruled, and is explicitly out of this
   brief's scope per the prior cleanup pass's own risk note ("do NOT smuggle it in without an
   explicit ruling").

5. **No dead branches, unused exports, or orphaned code found.** Every mode
   (`disabled`/`embedded`/`external`/`blocked`/`incompatible`/`unavailable`) is handled by
   the two-way `mode !== 'external'` / `mode === 'external'` split and every one of the
   five states produces correct, exercised behavior (local-only dormancy, embedded
   passthrough, or external wire activation). `foldLegacySpineStore` is a one-time,
   marker-guarded migration for a surface's *own* pre-spine `sessions.json`, independent of
   which topology it eventually adopts — every fresh adoption of an external daemon still
   benefits from it, so it has ongoing utility and is not a conversion-only vestige either.

## Decision

1. **The mode branch is the permanent design, not a staging vestige.** There is nothing to
   delete: no flag to remove, no dead branch to collapse, no dormant state that no longer
   serves a live topology. `embedded` and `external` remain two legitimate, independently
   necessary topologies and the branch that tells them apart is exactly the code that keeps
   the spine honest about which one is live.

2. **Scheduled Removal 2, as literally described in the prior cleanup pass's ledger ("retire the staging
   scaffolding so the converted path is the only path"), is ruled a no-op beyond
   documentation.** Per the brief's own honesty bar ("a removed escape hatch must not
   silently change a daemon topology") and Mike's no-deferral rule's real-reason bar for
   closing a scheduled item without code changes: the real reason is that investigation
   found no staging residual, not convenience.

3. **Comment cleanup only.** The mode-branch comments in `bootstrap.ts` and
   `bootstrap-core.ts` carried temporal, conversion-era labels naming internal migration
   steps that read as "this is scaffolding from a migration in progress." They are rewritten to
   state the permanent design directly: when `embedded` applies (this process IS the
   daemon), when `external` applies (this process adopted a separate daemon and mirrors
   into it), and why the parallel-write posture toward the still-authoritative local broker
   is deliberate, not provisional. No behavior changes.

## Alternatives rejected

- **Delete the mode branch and always activate the spine.** Rejected: breaks `embedded`
  (nothing to mirror to — the local broker already is the daemon's broker) and every
  offline/local-only mode (`disabled`/`blocked`/`incompatible`/`unavailable`), all of which
  are correct, reachable runtime states today, not staging debris.
- **Make the spine authoritative and drop the local-broker mirror.** Rejected as out of
  scope: this is a materially larger design change (moving the source of truth) than
  retiring a staging escape hatch, was never ruled by Mike, and the prior cleanup pass's own
  risk note explicitly warns against smuggling it into this brief.
- **Force a deletion somewhere to satisfy "a scheduled removal must land code."** Rejected:
  the honesty bar this whole effort operates under says a forced deletion that breaks a
  correct topology (embedded/offline) is worse than an honestly-documented no-op. The
  no-deferral rule's bar is a *real reason*, which this decision record supplies.

## Consequences

- No functional or behavioral change. `embedded`, `external`, `disabled`, `blocked`,
  `incompatible`, and `unavailable` all continue to behave exactly as before.
- The mode-branch comments in `src/runtime/bootstrap.ts` (`syncSessionSpineToHostStatus`,
  its close-time fire-and-forget) and `src/runtime/bootstrap-core.ts` (the dormant client
  construction, the heartbeat call, the fire-and-forget register) now state the permanent
  design in plain language instead of conversion-stage labels.
- Nothing here blocks the release train: this brief's deliverable was the scope ruling
  itself, and the ruling is that no code deletion is required.

## Tests

No new runtime behavior was introduced, so no new bootDaemon proof was required by the
gate definitions for a no-op outcome. Verified via the existing full TUI gate battery
(typecheck, `bun run test`, `bun run test:coverage`, `bun run architecture:check`,
`bun run perf:check`, `bun run eval:gate`, `bun run build`) that the comment-only edits
introduced no regression. See the landing commit for the exact gate numbers.

## Updated 2026-07-31 — what this record parked has now been ruled and shipped

### What was decided here, and what was parked

The 2026-07-06 ruling above decided two things: the `embedded` / `external` mode branch is
permanent design rather than staging residue, and no code deletion was owed. It parked a third
question twice, in these words:

> **The parallel-write mirror stays a mirror, not authoritative — by design, not oversight.**
> `bootstrap-core.ts:742-745` registers the local session with the spine fire-and-forget,
> alongside (never instead of) the still-authoritative local `SharedSessionBroker`. Making the
> spine authoritative (dropping the local broker as the source of truth) is a materially larger
> architectural change than "retire a staging escape hatch," is not implied by anything Mike
> ruled, and is explicitly out of this brief's scope

and, in the rejected alternatives:

> **Make the spine authoritative and drop the local-broker mirror.** Rejected as out of scope:
> this is a materially larger design change (moving the source of truth) than retiring a staging
> escape hatch, was never ruled by Mike, and the prior cleanup pass's own risk note explicitly
> warns against smuggling it into this brief.

That parked question was ruled on 2026-07-30 and executed in two phases.

### Phase A (daemon/TUI product separation) — what it decided about this branch

The daemon became its own product (repo `goodvibes-daemon`), and this app became a pure client.
The concrete consequence for the branch this record is about:

- **This app never hosts a daemon.** `src/runtime/bootstrap.ts:441` passes `adoptOnly: true` in
  the external-service factories, with the comment "This app never constructs a `DaemonServer`
  or an `HttpListener`". `src/runtime/services.ts:240` constructs an empty
  `GatewayMethodCatalog` because this product answers no verbs.
- **`embedded` became unreachable from a surface.** The shared adopt-or-spawn ruling
  (`goodvibes-sdk/packages/sdk/src/platform/runtime/daemon-adoption-policy.ts:121-127`) checks
  `adoptOnly` *before* `embedInProcess`: with the port free and `adoptOnly` set, the decision is
  `adopt-only-idle`, never `embed`. Both surface products pass it — this app at
  `bootstrap.ts:441` and the chat host at
  `goodvibes-agent/src/runtime/bootstrap-external-services.ts:168` — and the daemon product does
  not call `startExternalServices` at all. The `daemon.embedInProcess` key still exists in the
  SDK schema (`platform/config/schema-domain-core.ts:119` default `false`, entry at `:704`) and
  the `embed` branch still exists in `bootstrap-services.ts:695`, but no shipped product
  reaches it. `HostServiceMode` still names `'embedded'`
  (`platform/runtime/bootstrap-services.ts:147`) and this app's `hostServiceIsActive`
  (`bootstrap.ts:377`) still treats it as active; that is a residual union member, not a live
  topology.
- **The branch itself moved into the SDK and became "adopted or not".**
  `syncSessionSpineToHostStatus` is now built by `createSpineAdoptionSync`
  (`bootstrap.ts:386`; SDK `platform/runtime/client/spine-adoption.ts:137`). That module's own
  header states the change: "`embedded` is gone. A surface never hosts a daemon, so there is
  exactly one live topology — adopted — and every other mode (`disabled`, `blocked`,
  `incompatible`, `unavailable`) means the same honest thing: no daemon, local only, nothing
  mirrored."
- **The one recovery step for "no daemon" is starting the installed service**, not becoming one:
  `autostartInstalledDaemon` (SDK `platform/runtime/client/daemon-autostart.ts`), called from
  `bootstrap.ts:449`.

So the specific sentence in this record's title — "embedded/in-process operation stays" — no
longer holds for this product. The rest of the 2026-07-06 reasoning does: the branch was never
staging residue, and it was not deleted; it was replaced by a narrower branch in the SDK when the
topology it distinguished ceased to exist.

### Phase B (daemon-hosted sessions) — what it decided about authority

Phase B did not make the spine authoritative for every session. It added a second, explicitly
chosen kind of session whose loop runs in the daemon:

- The engine is the SDK's `platform/hosted-sessions/` (`manager.ts`, `session-runtime.ts`,
  `store.ts`, `spine-intake.ts`, `types.ts`), composed into a daemon by
  `platform/daemon/hosted-sessions-composition.ts`. `session-runtime.ts` builds the same
  `Orchestrator`, the same `ToolRegistry` via `registerAllTools`, and reuses the product's own
  `permissionManager` rather than a second one.
- Five verbs drive the lifecycle: `sessions.hosted.create`, `.attach`, `.detach`, `.kill`,
  `.list` (`goodvibes-sdk/packages/contracts/src/generated/operator-method-ids.ts:425-429`;
  handlers in `platform/control-plane/routes/hosted-sessions.ts`). There is deliberately no
  hosted-only steer verb — `sessions.steer`, `sessions.followUp` and `sessions.toolCalls.cancel`
  resolve a hosted id daemon-side (`platform/control-plane/method-catalog-hosted-sessions.ts`
  header).
- **The detach toggle and its owner-confirmed default:** `hostedSessions.detachPolicy`, an enum
  of `kill` | `survive`, default **`kill`**
  (`goodvibes-sdk/packages/sdk/src/platform/config/schema-domain-hosted-sessions.ts:39` and
  `:49-54`). A single session may override it at creation
  (`sessions.hosted.create` takes `detachPolicy`). The other shipped keys in that domain:
  `hostedSessions.maxSessions` (8), `hostedSessions.maxMessagesPerSession` (500),
  `hostedSessions.terminatedRetentionMs` (24h in ms), and
  `hostedSessions.promoteInboundConversations` (boolean, default **`false`**).
- **This app's reach:** `src/runtime/client/hosted-sessions.ts` (the five verbs plus the ordinary
  session verbs a hosted id answers), `src/runtime/client/hosted-session-stream.ts` (the hosted
  turn's tokens and tool calls arrive on the same `turn` / `tools` event domains a local session
  uses, filtered on the id `attach` returned), `src/runtime/client/hosted-roster.ts`, and the
  `/hosted` command (`src/input/commands/hosted-runtime.ts`: `new`, `list`, `attach`, `say`,
  `later`, `cancel`, `detach`, `kill`). The five `hostedSessions.*` keys are a settings category
  here (`src/input/settings-modal-types.ts:74-84`).

### What is still local mode — precisely

Nothing about the default experience changed. In this app:

- **The local broker is still constructed and still authoritative for the session this terminal
  runs.** `src/runtime/services.ts:273-279` builds a `SharedSessionBroker` with
  `storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json')`, its
  `routeBindings`, `agentStatusProvider`, `messageSender` and `conversationGateConfig`. The
  continuation runner bound to it (`services.ts:294`) spawns through this process's own
  `agentManager`.
- **The conversation loop still runs in this process.** The orchestrator, tool registry and
  permission prompting are here; closing the terminal ends that work. The module header of
  `src/runtime/client/hosted-sessions.ts` states it: "A local session's loop lives in this
  process ... Local stays the default experience; hosting is something the user asks for."
- **What crosses the wire is identity, not execution.** SDK
  `platform/runtime/client/spine-adoption.ts` header: "Session IDENTITY, not session execution.
  The conversation itself still runs in the surface; what the daemon holds is the register."
  Adoption wires `sessions.register` / `sessions.close`, `sessions.inputs.list` /
  `.deliver`, `sessions.list`, and the memory transport — nothing that moves the loop.
- **Hosted mode is entered by an explicit act**: `/hosted new` or `/hosted attach`. There is no
  setting that makes a terminal's own session hosted, and `hostedSessions.detachPolicy` defaults
  to `kill`, so even a hosted session ends on detach unless the user chose otherwise.

The honest summary: the parked question is answered, and the answer is "both, by choice" — the
local broker remains the source of truth for a terminal-run session, and a daemon-hosted session
is a separate thing the user asks for, with `kill` still the default meaning of detaching.
