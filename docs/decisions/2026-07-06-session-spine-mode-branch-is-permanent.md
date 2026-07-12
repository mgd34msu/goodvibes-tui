# Decision: the session-spine mode branch (`syncSessionSpineToHostStatus`) is permanent design, not a staging escape hatch — embedded/in-process operation stays

Date: 2026-07-06
Scope: a prior cleanup pass's scheduled removal 2 — "TUI staged-switch escape hatch"
Status: accepted
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
