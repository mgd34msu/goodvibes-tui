/**
 * fleet-union.ts — the Fleet panel shows everything running, not just what this
 * terminal started.
 *
 * ── What the panel used to show, and why that stopped being enough ────────
 *
 * The Fleet panel reads one `ProcessRegistry`: the agents, WRFC chains,
 * workflows, watchers and background processes THIS process spawned. While the
 * app hosted a daemon, that registry was also the daemon's, so "everything
 * running" and "everything I started" were the same list.
 *
 * They are not any more. The daemon runs work of its own — scheduled jobs,
 * channel-driven runs, sessions other surfaces started, the external coding
 * agents it observes on this machine — and none of it appears in a registry
 * this process owns. A panel that quietly showed half the fleet would be worse
 * than one that showed none: the half it showed would look complete.
 *
 * ── The union, and who wins ───────────────────────────────────────────────
 *
 * Local rows are AUTHORITATIVE for processes this terminal spawned. They are
 * live — the registry pushes on every state change, with sub-second latency —
 * and they carry the capabilities that make a row actionable here (interrupt,
 * resume, kill, steer all reach a real child process). The daemon's copy of the
 * same row, arriving over a poll, is necessarily staler; where both describe
 * the same node id, the local one is kept.
 *
 * Daemon rows fill in everything else. They are interval-refreshed rather than
 * streamed, on the same reasoning the cross-surface session union already uses:
 * a fleet view is read at human pace, a poll survives a suspended laptop and a
 * dropped tunnel with no reconnect state machine, and the rows that genuinely
 * need per-keystroke latency are the local ones, which are not polled at all.
 *
 * ── Acting on a row you do not own ────────────────────────────────────────
 *
 * `interrupt`/`resume`/`kill`/`steer` reach this process's own children. A
 * daemon row has no child here to signal, so those refuse — and `steer`, which
 * has a reason channel, says why rather than returning a bare false that reads
 * as "the agent ignored you". The panel's own act surface (fleet-gateway.ts)
 * already drives the daemon's verbs for the acts the daemon serves.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { buildFleetSnapshot, type FleetReadModel, type FleetSnapshot } from '../../panels/fleet-read-model.ts';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** How often the daemon's rows are re-read. The local half is push-driven. */
const DEFAULT_REFRESH_MS = 15_000;

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

/** A daemon that answered, or an honest absence. Never a fabricated empty fleet. */
interface DaemonRows {
  readonly nodes: readonly ProcessNode[];
  readonly capturedAt: number;
}

function readNodes(payload: unknown): DaemonRows | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nodes = Array.isArray(record['nodes']) ? record['nodes'] as readonly ProcessNode[] : null;
  if (!nodes) return null;
  const capturedAt = typeof record['capturedAt'] === 'number' ? record['capturedAt'] : Date.now();
  return { nodes, capturedAt };
}

/**
 * Wrap a local fleet read model so its snapshot also carries the adopted
 * daemon's rows.
 *
 * Inert until the first refresh lands: before then, and whenever the daemon
 * cannot answer, the snapshot is exactly the local one — which is the honest
 * answer, not a degraded one. A daemon that stops answering keeps its LAST
 * known rows rather than dropping them, so a momentary blip does not make half
 * the fleet blink out and back.
 */
export function createFleetUnionReadModel(options: FleetUnionOptions): FleetUnionReadModel {
  const log = options.log ?? logger;
  const local = options.local;
  let daemonRows: DaemonRows | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const listeners = new Set<() => void>();

  /** Ids this surface owns right now — the set the daemon's copy defers to. */
  const localNodeIds = (snapshot: FleetSnapshot): Set<string> =>
    new Set(snapshot.rows.map((row) => row.node.id));

  const refresh = async (): Promise<void> => {
    if (inFlight) return;
    const probe = options.verbs.probe();
    if (!probe.available) return; // no daemon configured: the local view IS the fleet
    inFlight = true;
    try {
      const next = readNodes(await options.verbs.invoke('fleet.snapshot', {}));
      if (next) {
        daemonRows = next;
        for (const listener of listeners) listener();
      }
    } catch (error) {
      // Keep the last known rows. A failed poll is a stale view, which the
      // capturedAt on the snapshot already discloses; dropping them would make
      // the daemon's half of the fleet disappear on one bad request.
      log.debug('[fleet] the daemon\'s rows could not be refreshed; keeping the last set', {
        error: summarizeError(error),
      });
    } finally {
      inFlight = false;
    }
  };

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => { void refresh(); }, options.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
    timer.unref?.();
  };
  ensureTimer();
  void refresh();

  const isLocalId = (id: string): boolean => localNodeIds(local.getSnapshot()).has(id);
  const daemonOnlyRefusal = (id: string): string =>
    `${id} is running on the daemon, not in this terminal — this act reaches only processes started here`;

  return {
    getSnapshot(): FleetSnapshot {
      const localSnapshot = local.getSnapshot();
      if (!daemonRows || daemonRows.nodes.length === 0) return localSnapshot;
      const owned = localNodeIds(localSnapshot);
      const merged = [
        ...localSnapshot.rows.map((row) => row.node),
        ...daemonRows.nodes.filter((node) => !owned.has(node.id)),
      ];
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
      : { queued: false, reason: daemonOnlyRefusal(id) }),
    subscribeConsumed: (listener) => local.subscribeConsumed(listener),
    // The archive is this surface's own view state; the daemon keeps its own.
    getArchivedSnapshot: () => local.getArchivedSnapshot(),
    archive: (id) => (isLocalId(id)
      ? local.archive(id)
      : { archived: false, count: 0, reason: daemonOnlyRefusal(id) }),
    archiveFinished: () => local.archiveFinished(),
    unarchive: (id) => local.unarchive(id),

    refresh,
    stop(): void {
      if (timer !== null) { clearInterval(timer); timer = null; }
      listeners.clear();
    },
  };
}
