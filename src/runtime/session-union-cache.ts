/**
 * session-union-cache.ts
 *
 * S3d (One-Platform Wave 2, TUI read-facade): the cache-backed read layer that
 * lets the panel/read consumers keep their SYNCHRONOUS listSessions()/
 * getSession() shape while telling the truth about cross-surface sessions.
 *
 * The problem it solves (surfaced in S3c): in adopted-daemon mode this TUI's
 * OWN SharedSessionBroker only holds the sessions THIS process created, so a
 * panel reading it misses every session hosted on the adopted daemon from
 * other surfaces (companion, webui, other TUIs). The daemon's own reads are
 * ASYNC (HttpTransport.operator.sessions.list returns a Promise) while the
 * local broker's are SYNC — a signature mismatch that blocks a drop-in swap.
 *
 * This facade bridges that: in adopted mode it refreshes the wire union on a
 * modest interval (and on demand), caches the last-known rows, and serves them
 * synchronously alongside the local rows. It NEVER lies:
 *
 *  - EMBEDDED mode (this process's own broker IS the daemon's broker): pure
 *    passthrough to the local broker — it already IS the truth, no wire, no
 *    'offline' segment.
 *  - ADOPTED mode, wire reachable: serve union(local, wire), deduped by id
 *    (local wins for its own session), with lastSyncAt + a `stale` flag.
 *  - ADOPTED mode, wire UNREACHABLE (daemon died mid-session): degrade to
 *    'offline' — serve ONLY the local rows plus an honest
 *    'cross-surface view offline' note, rather than presenting the stale
 *    last-known union as if it were live.
 *  - LOCAL/dormant (never adopted, or non-external mode): passthrough local,
 *    no cross-surface claim.
 *
 * The wire refresh runs on its OWN interval timer (injectable) and is never
 * invoked from the render/keystroke hot path — reads are served from the cache
 * synchronously, so the facade adds zero awaits to any interactive path.
 *
 * SSE note (this wave): the SDK's HttpTransport exposes a telemetry `stream()`
 * SSE channel but no dedicated `session_update` realtime channel the TUI
 * already subscribes to, so this wave refreshes on the interval only. Wiring an
 * SSE session_update push to trigger refresh() eagerly is honest follow-on work
 * (the refresh() seam is already the single mutation point it would call).
 */

import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { SharedSessionBroker, SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';

/** The synchronous local read source — the in-process SharedSessionBroker. */
export type LocalSessionReader = Pick<SharedSessionBroker, 'listSessions' | 'getSession'>;

/** The async wire reader — HttpTransport.operator.sessions.list against an adopted daemon. */
export interface WireSessionReader {
  list(limit?: number): Promise<readonly SharedSessionRecord[]>;
}

export type SessionUnionMode = 'local' | 'embedded' | 'adopted';

/**
 * Honest cross-surface posture for the panels to render. `offlineNote` is
 * non-null ONLY in adopted mode when the wire is unreachable — that is the
 * exact string a panel should show next to its (local-only) session rows.
 */
export interface CrossSurfaceView {
  readonly mode: SessionUnionMode;
  /** True only after a successful wire refresh in adopted mode. */
  readonly online: boolean;
  /** True when the served rows are not a confirmed-live union (offline, or aged past the freshness window). */
  readonly stale: boolean;
  /** Wall-clock ms of the last successful wire refresh, or null if never. */
  readonly lastSyncAt: number | null;
  /** Honest operator note when the cross-surface view is offline, else null. */
  readonly offlineNote: string | null;
}

/**
 * The read surface panels/openers consume in place of the raw broker. Declares
 * its own signatures (readonly returns) rather than inheriting the broker's
 * mutable ones, so both the broker-backed cache and the cache itself satisfy it.
 */
export interface SessionReadFacade {
  listSessions(limit?: number): readonly SharedSessionRecord[];
  getSession(sessionId: string): SharedSessionRecord | null;
  readonly crossSurfaceView: CrossSurfaceView;
}

export interface SessionUnionCacheOptions {
  readonly local: LocalSessionReader;
  readonly now?: () => number;
  /** Wire refresh cadence in adopted mode (default 5s). */
  readonly refreshIntervalMs?: number;
  /** A served union older than this reads as `stale` even while nominally online (default 20s). */
  readonly staleAfterMs?: number;
  /** Upper bound on rows pulled from the wire per refresh (default 200). */
  readonly wireLimit?: number;
  /** Injectable timer seam for deterministic tests. */
  readonly scheduler?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  };
  readonly log?: Pick<typeof logger, 'debug'>;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 20_000;
const DEFAULT_WIRE_LIMIT = 200;
const OFFLINE_NOTE = 'cross-surface view offline';

/**
 * Cache-backed session read facade. Construct it in bootstrap-core wrapping the
 * local SharedSessionBroker; bootstrap.ts drives its mode (activate/markEmbedded/
 * deactivate) from the SAME authoritative HostServiceMode the adopt-or-start
 * probe computes for the session spine, so the two stay in lockstep.
 */
/**
 * D4: derive the footer's spine online/offline segment from the FRESHEST liveness
 * signal. The spine client's own status() is ACTIVITY-gated — it only flips on a
 * register/heartbeat/close wire call — so after the daemon dies mid-idle the footer
 * keeps reading 'online' until the next activity (seconds to minutes). The union
 * cache, by contrast, probes the wire every refreshIntervalMs (5s) in adopted mode,
 * so ITS `online` flag is a genuine liveness heartbeat with a bounded staleness.
 *
 * Rule (one signal, no new timer): once the wire has been confirmed reachable at
 * least once (`lastSyncAt !== null`), the union probe is authoritative for the
 * footer — a failed 5s probe reads 'offline' within one interval of the daemon
 * dying, and recovers on the next success. Before any confirmation (or when not
 * adopted), fall back to the spine client's own status.
 */
export function deriveSpineFooterStatus(
  spineStatus: 'unknown' | 'online' | 'offline',
  view: Pick<CrossSurfaceView, 'mode' | 'online' | 'lastSyncAt'>,
): 'unknown' | 'online' | 'offline' {
  if (view.mode === 'adopted' && view.lastSyncAt !== null) {
    return view.online ? 'online' : 'offline';
  }
  return spineStatus;
}

export class SessionUnionCache implements SessionReadFacade {
  private readonly local: LocalSessionReader;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly wireLimit: number;
  private readonly scheduler: NonNullable<SessionUnionCacheOptions['scheduler']>;
  private readonly log: Pick<typeof logger, 'debug'>;

  private mode: SessionUnionMode = 'local';
  private wireReader: WireSessionReader | null = null;
  private wireCache: readonly SharedSessionRecord[] = [];
  private online = false;
  private lastSyncAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionUnionCacheOptions) {
    this.local = options.local;
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.wireLimit = options.wireLimit ?? DEFAULT_WIRE_LIMIT;
    this.scheduler = options.scheduler ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle),
    };
    this.log = options.log ?? logger;
  }

  /** Current facade mode — for diagnostics/tests. */
  getMode(): SessionUnionMode {
    return this.mode;
  }

  /**
   * Enter ADOPTED mode against a reachable daemon's wire reader. Kicks an
   * immediate refresh and starts the interval poll. Idempotent per reader:
   * bootstrap only calls this once per adopted baseUrl.
   */
  activate(wireReader: WireSessionReader): void {
    this.stopTimer();
    this.wireReader = wireReader;
    this.mode = 'adopted';
    this.online = false; // unconfirmed until the first successful refresh
    this.lastSyncAt = null;
    this.wireCache = [];
    this.timer = this.scheduler.setInterval(() => void this.refresh(), this.refreshIntervalMs);
    void this.refresh();
  }

  /**
   * Enter EMBEDDED mode — this process's broker IS the daemon's broker, so the
   * local reads are already the whole truth. Pure passthrough, no wire.
   */
  markEmbedded(): void {
    this.stopTimer();
    this.mode = 'embedded';
    this.resetWireState();
  }

  /** Return to LOCAL/dormant mode (non-external daemon, or adoption lost). */
  deactivate(reason: string): void {
    if (this.mode === 'adopted') {
      this.log.debug('[session-union] deactivating adopted read facade', { reason });
    }
    this.stopTimer();
    this.mode = 'local';
    this.resetWireState();
  }

  /**
   * Pull the wire union once and update the cache. Awaitable so tests drive it
   * deterministically. A rejecting wire degrades to offline WITHOUT dropping to
   * a lie: `online` flips false so listSessions() serves local-only rows.
   */
  async refresh(): Promise<void> {
    if (this.mode !== 'adopted' || !this.wireReader) return;
    try {
      const rows = await this.wireReader.list(this.wireLimit);
      this.wireCache = rows;
      this.lastSyncAt = this.now();
      this.online = true;
    } catch (err) {
      // Degrade honestly: keep the last rows but stop serving them as live.
      this.online = false;
      this.log.debug('[session-union] wire refresh failed; serving local-only', { error: String(err) });
    }
  }

  listSessions(limit?: number): readonly SharedSessionRecord[] {
    // Embedded / local / adopted-but-offline: local is the honest answer.
    if (this.mode !== 'adopted' || !this.online) {
      return this.local.listSessions(limit);
    }
    // Adopted + online: serve the deduped union (local wins for its own rows).
    const merged = new Map<string, SharedSessionRecord>();
    for (const record of this.wireCache) merged.set(record.id, record);
    for (const record of this.local.listSessions()) merged.set(record.id, record);
    const union = Array.from(merged.values());
    return typeof limit === 'number' && limit >= 0 ? union.slice(0, limit) : union;
  }

  getSession(sessionId: string): SharedSessionRecord | null {
    const localRecord = this.local.getSession(sessionId);
    if (localRecord) return localRecord;
    if (this.mode === 'adopted' && this.online) {
      return this.wireCache.find((record) => record.id === sessionId) ?? null;
    }
    return null;
  }

  get crossSurfaceView(): CrossSurfaceView {
    if (this.mode !== 'adopted') {
      return { mode: this.mode, online: false, stale: false, lastSyncAt: null, offlineNote: null };
    }
    const aged = this.lastSyncAt === null || this.now() - this.lastSyncAt > this.staleAfterMs;
    const stale = !this.online || aged;
    return {
      mode: 'adopted',
      online: this.online,
      stale,
      lastSyncAt: this.lastSyncAt,
      offlineNote: this.online ? null : OFFLINE_NOTE,
    };
  }

  dispose(): void {
    this.stopTimer();
  }

  private resetWireState(): void {
    this.wireReader = null;
    this.wireCache = [];
    this.online = false;
    this.lastSyncAt = null;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
