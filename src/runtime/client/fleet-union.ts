/**
 * fleet-union.ts — the Fleet panel shows everything running, not just what this
 * terminal started.
 *
 * ── What moved to the SDK, and what stays here ────────────────────────────
 *
 * The SDK's `@pellux/goodvibes-sdk/platform/runtime/client` now owns the
 * policy every surface needs for this: `createDaemonFleetRowsPoller` (the poll
 * cadence and last-known-rows retention when a poll fails), `mergeFleetNodes`
 * (the local-wins dedupe by node id) and `daemonOnlyFleetActRefusal` (the
 * reason string a steer/archive against a daemon-only row gets, rather than a
 * bare false). This module is now a thin wrapper over that policy.
 *
 * What stays here is the panel binding: the TUI's own `FleetReadModel`
 * interface (interrupt/resume/kill/steer/archive, subscribe, snapshots) and
 * `buildFleetSnapshot`, the tree-builder + honest cost/token aggregator this
 * repo's Fleet panel renders from. Rebuilding through the SAME builder the
 * local view uses — rather than summing two halves — is what keeps the
 * rollups, the cost/token totals and the blocked-on-user ordering computed
 * once, over the whole fleet.
 *
 * ── Who wins ──────────────────────────────────────────────────────────────
 *
 * Local rows are AUTHORITATIVE for processes this terminal spawned. They are
 * live — the registry pushes on every state change, with sub-second latency —
 * and they carry the capabilities that make a row actionable here (interrupt,
 * resume, kill, steer all reach a real child process). The daemon's copy of
 * the same row, arriving over a poll, is necessarily staler; where both
 * describe the same node id, the local one is kept (`mergeFleetNodes`).
 *
 * ── Acting on a row you do not own ────────────────────────────────────────
 *
 * `interrupt`/`resume`/`kill`/`steer` reach this process's own children. A
 * daemon row has no child here to signal, so those refuse — and `steer`,
 * which has a reason channel, says why rather than returning a bare false
 * that reads as "the agent ignored you". The panel's own act surface
 * (fleet-gateway.ts) already drives the daemon's verbs for the acts the
 * daemon serves.
 */
import {
  createDaemonFleetRowsPoller,
  daemonOnlyFleetActRefusal,
  DEFAULT_FLEET_REFRESH_MS,
  mergeFleetNodes,
  readDaemonFleetRows,
  type DaemonFleetRows,
  type DaemonFleetRowsPoller,
  type DaemonFleetRowsPollerOptions,
  type DaemonVerbCaller,
} from '@pellux/goodvibes-sdk/platform/runtime/client';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { buildFleetSnapshot, type FleetReadModel, type FleetSnapshot } from '../../panels/fleet-read-model.ts';

/** Re-exported so an importer that only needs the SDK's policy has one import site. */
export { DEFAULT_FLEET_REFRESH_MS, daemonOnlyFleetActRefusal, mergeFleetNodes, readDaemonFleetRows };
export type { DaemonFleetRows, DaemonFleetRowsPoller, DaemonFleetRowsPollerOptions };

export interface FleetUnionOptions {
  /** This surface's own live registry view — authoritative for what it spawned. */
  readonly local: FleetReadModel;
  readonly verbs: DaemonVerbCaller;
  readonly refreshIntervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug'>;
}

export interface FleetUnionReadModel extends FleetReadModel {
  /** Stop the refresh timer. Idempotent. */
  stop(): void;
  /** Re-read the daemon's rows now. Never throws. */
  refresh(): Promise<void>;
}

/** How this terminal names itself in a daemon-only-row act refusal. */
const SURFACE_LABEL = 'this terminal';

/**
 * Wrap a local fleet read model so its snapshot also carries the adopted
 * daemon's rows, over the SDK's poll/merge/refusal policy.
 *
 * Inert until the first poll lands: before then, and whenever the daemon
 * cannot answer, the snapshot is exactly the local one — which is the honest
 * answer, not a degraded one. A daemon that stops answering keeps its LAST
 * known rows rather than dropping them (the poller's own retention), so a
 * momentary blip does not make half the fleet blink out and back.
 */
export function createFleetUnionReadModel(options: FleetUnionOptions): FleetUnionReadModel {
  const local = options.local;
  const poller = createDaemonFleetRowsPoller({
    verbs: options.verbs,
    ...(options.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: options.refreshIntervalMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const listeners = new Set<() => void>();
  const unsubscribePoller = poller.subscribe(() => {
    for (const listener of listeners) listener();
  });

  /** Ids this surface owns right now — the set the daemon's copy defers to. */
  const localNodeIds = (snapshot: FleetSnapshot): Set<string> =>
    new Set(snapshot.rows.map((row) => row.node.id));
  const isLocalId = (id: string): boolean => localNodeIds(local.getSnapshot()).has(id);

  return {
    getSnapshot(): FleetSnapshot {
      const localSnapshot = local.getSnapshot();
      const daemonRows = poller.rows();
      if (!daemonRows || daemonRows.nodes.length === 0) return localSnapshot;
      const merged = mergeFleetNodes(localSnapshot.rows.map((row) => row.node), daemonRows.nodes);
      // Rebuilt through the SAME builder the local view uses, so the rollups,
      // the cost/token totals and the blocked-on-user ordering are computed
      // once, over the whole fleet, rather than summed from two halves.
      return buildFleetSnapshot(merged, Math.max(localSnapshot.capturedAt, daemonRows.capturedAt));
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      const unsubscribeLocal = local.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeLocal();
      };
    },

    interrupt: (id) => local.interrupt(id),
    resume: (id) => local.resume(id),
    kill: (id, opts) => local.kill(id, opts),
    steer: (id, text) => (isLocalId(id)
      ? local.steer(id, text)
      : { queued: false, reason: daemonOnlyFleetActRefusal(id, SURFACE_LABEL) }),
    subscribeConsumed: (listener) => local.subscribeConsumed(listener),
    // The archive is this surface's own view state; the daemon keeps its own.
    getArchivedSnapshot: () => local.getArchivedSnapshot(),
    archive: (id) => (isLocalId(id)
      ? local.archive(id)
      : { archived: false, count: 0, reason: daemonOnlyFleetActRefusal(id, SURFACE_LABEL) }),
    archiveFinished: () => local.archiveFinished(),
    unarchive: (id) => local.unarchive(id),

    refresh: () => poller.refresh(),
    stop(): void {
      poller.stop();
      unsubscribePoller();
      listeners.clear();
    },
  };
}
