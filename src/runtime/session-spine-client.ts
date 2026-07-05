/**
 * session-spine-client.ts
 *
 * S3c (One-Platform Wave 2, TUI broker-owner -> broker-client conversion):
 * the in-process coordinator that mirrors THIS TUI's own session identity
 * (create / resume / heartbeat / close) into the daemon-hosted session spine
 * once the TUI has adopted a compatible EXTERNAL daemon.
 *
 * Design (mirrors the goodvibes-agent W2A pattern — session-registration.ts +
 * session-spine-client.ts in that repo — with one deliberate difference: this
 * client is TYPED against the SDK's session wire types and an injected
 * `SpineSessionsClient`, not raw fetch. The agent compiles against the pinned
 * npm SDK (which may predate `sessions.register`), so it hand-rolls a
 * version-tolerant REST mirror. The TUI DEV-rides the local SDK overlay and
 * OWNS the daemon it adopts, so there is no version-straddling concern here —
 * a typed client is strictly safer (compiler-checked wire shapes).
 *
 * Discipline (same as the agent's, load-bearing for the interactive-latency
 * budget):
 *  - Every public method (register / reopen / heartbeat / close /
 *    foldLegacyRecords) is fire-and-forget: it returns `void` SYNCHRONOUSLY
 *    and never throws into the caller, even when the wire call rejects.
 *    Session start/resume/heartbeat never block the render or keystroke path.
 *  - This client does NOT self-probe reachability. The TUI's bootstrap
 *    already runs the authoritative adopt-or-start identity + version-compat
 *    probe (bootstrap-services.ts); this client is told when to `activate()`
 *    (a compatible external daemon was adopted) or stay dormant (embedded /
 *    disabled / blocked / incompatible / unavailable — today's exact local
 *    behavior, unchanged). Reachability tracked HERE covers the OTHER case:
 *    the daemon dying mid-session after having been adopted.
 *  - Before `activate()` (backend not yet known, or daemon mode is not
 *    'external') every op is queued, never dropped-on-the-floor and never
 *    attempted over a client that does not exist. `activate()` flushes the
 *    backlog. Deactivating (daemon mode resolved to non-external, or lost)
 *    stops attempting the wire but keeps queuing — the ring is bounded
 *    (drop-oldest), so this is memory-safe even if a daemon is never adopted
 *    for the life of the process.
 *  - Offline ops go into a bounded ring (drop-oldest); flush is idempotent
 *    because register is an upsert.
 *  - Heartbeat is debounced/coalesced to at most one wire call per window and
 *    omits the title so it never renames a titled session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type {
  RegisterSharedSessionInput,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionRegisterResult,
} from '@pellux/goodvibes-sdk/platform/control-plane';

/** The canonical TUI participant (TRANSPORT axis). Mirrors the local
 * SharedSessionBroker.createSession() participant in bootstrap-core.ts. */
export const TUI_SPINE_PARTICIPANT: Omit<SharedSessionParticipant, 'lastSeenAt'> = {
  surfaceKind: 'tui',
  surfaceId: 'surface:tui',
  displayName: 'Terminal UI',
};

export type SpineReachability = 'unknown' | 'online' | 'offline';

export interface SessionSpineRecord {
  readonly sessionId: string;
  readonly project: string;
  readonly title?: string | undefined;
  readonly userId?: string | undefined;
}

/**
 * The minimal wire surface this client needs. Structurally satisfied by BOTH
 * the SDK's in-process `OperatorClient['sessions']` (DirectTransport) and the
 * wire `HttpTransportOperatorClient['sessions']` (HttpTransport) — this client
 * only ever receives an Http-backed instance in practice (see
 * `createHttpSpineSessionsClient` in bootstrap.ts), but is deliberately typed
 * against this narrow shape rather than either concrete transport type so it
 * has no compile-time dependency on which transport backs it.
 */
export interface SpineSessionsClient {
  register(input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult>;
  close(sessionId: string): Promise<SharedSessionRecord | null>;
}

interface QueuedOp {
  readonly type: 'register' | 'close';
  readonly sessionId: string;
  readonly input?: RegisterSharedSessionInput;
}

type SpineLogger = Pick<typeof logger, 'debug' | 'info'>;

export interface SessionSpineClientOptions {
  readonly now?: () => number;
  readonly queueLimit?: number;
  readonly heartbeatMinIntervalMs?: number;
  readonly log?: SpineLogger;
}

const DEFAULT_QUEUE_LIMIT = 128;
const DEFAULT_HEARTBEAT_MIN_INTERVAL_MS = 45_000;

export class SessionSpineClient {
  private readonly now: () => number;
  private readonly queueLimit: number;
  private readonly heartbeatMinIntervalMs: number;
  private readonly log: SpineLogger;

  private sessionsClient: SpineSessionsClient | null = null;
  private reachability: SpineReachability = 'unknown';
  private readonly records = new Map<string, RegisterSharedSessionInput>();
  private readonly queue: QueuedOp[] = [];
  private lastHeartbeatAt = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(options: SessionSpineClientOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
    this.heartbeatMinIntervalMs = Math.max(0, options.heartbeatMinIntervalMs ?? DEFAULT_HEARTBEAT_MIN_INTERVAL_MS);
    this.log = options.log ?? logger;
  }

  /** Honest reachability: 'unknown' until a client is attached, 'online' after
   * a successful wire call, 'offline' after a failed one (attached or not). */
  status(): SpineReachability {
    return this.reachability;
  }

  /** Whether a backend is currently attached (daemon adopted as 'external'). */
  get active(): boolean {
    return this.sessionsClient !== null;
  }

  /** Current bounded offline-queue depth (for diagnostics / tests). */
  get pendingOps(): number {
    return this.queue.length;
  }

  /**
   * ONE selection point: attach the real wire client once the TUI's bootstrap
   * has adopted a compatible EXTERNAL daemon. Flushes anything queued while
   * dormant (including ops queued before this call ever happened). Idempotent
   * reachability starts 'unknown' until the first wire call resolves.
   */
  activate(sessionsClient: SpineSessionsClient): void {
    this.sessionsClient = sessionsClient;
    this.log.info('session spine activated — mirroring session identity to the adopted external daemon', {});
    void this.flush();
  }

  /** Detach the backend (daemon mode resolved to non-external, or was lost).
   * Ops continue to be queued (bounded, drop-oldest) rather than dropped. */
  deactivate(reason: string): void {
    if (this.sessionsClient === null) return;
    this.sessionsClient = null;
    this.reachability = 'unknown';
    this.log.info('session spine deactivated', { reason });
  }

  /** CREATE: fire-and-forget initial registration (title stamped once). */
  register(record: SessionSpineRecord): void {
    this.cacheHeartbeatRecord(record);
    this.dispatchRegister(this.buildInput(record, { includeTitle: true }));
  }

  /** RESUME: fire-and-forget reopen (reopen:true, no title) — the only reopen path. */
  reopen(record: SessionSpineRecord): void {
    this.cacheHeartbeatRecord(record);
    this.dispatchRegister(this.buildInput(record, { includeTitle: false, reopen: true }));
  }

  /** HEARTBEAT: debounced re-register, coalesced to one wire call per window, no title, no reopen.
   * Safe to call on every turn-activity tick — internally a no-op unless the window has elapsed. */
  heartbeat(sessionId: string): void {
    const cached = this.records.get(sessionId);
    if (!cached) return;
    const now = this.now();
    if (now - this.lastHeartbeatAt >= this.heartbeatMinIntervalMs) {
      this.lastHeartbeatAt = now;
      this.dispatchRegister(this.withFreshLastSeen(cached));
      return;
    }
    if (this.heartbeatTimer) return; // already a trailing beat scheduled -> coalesced
    const delay = Math.max(0, this.heartbeatMinIntervalMs - (now - this.lastHeartbeatAt));
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.lastHeartbeatAt = this.now();
      const rec = this.records.get(sessionId);
      if (rec) this.dispatchRegister(this.withFreshLastSeen(rec));
    }, delay);
    this.heartbeatTimer.unref?.();
  }

  /** CLOSE: best-effort, fire-and-forget; tolerate a racing daemon stop. */
  close(sessionId: string): void {
    this.records.delete(sessionId);
    if (!this.sessionsClient) {
      this.enqueue({ type: 'close', sessionId });
      return;
    }
    void this.runClose(sessionId);
  }

  /**
   * LEGACY FOLD: register each per-project record; a record whose id is in
   * `closedIds` is registered then closed so a locally-closed session STAYS
   * closed in the daemon (honest history). Idempotent — register is an
   * upsert; closing an already-closed record is a no-op.
   */
  foldLegacyRecords(records: readonly SessionSpineRecord[], closedIds: ReadonlySet<string>): void {
    for (const record of records) {
      this.enqueue({ type: 'register', sessionId: record.sessionId, input: this.buildInput(record, { includeTitle: true }) });
      if (closedIds.has(record.sessionId)) {
        this.enqueue({ type: 'close', sessionId: record.sessionId });
      }
    }
    void this.flush();
  }

  /** Clears the pending heartbeat timer; call on shutdown. */
  dispose(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cacheHeartbeatRecord(record: SessionSpineRecord): void {
    // Cache the title-less form so heartbeats never rename a titled session.
    this.records.set(record.sessionId, this.buildInput(record, { includeTitle: false }));
  }

  private buildInput(
    record: SessionSpineRecord,
    opts: { readonly includeTitle: boolean; readonly reopen?: boolean },
  ): RegisterSharedSessionInput {
    const participant: SharedSessionParticipant = {
      ...TUI_SPINE_PARTICIPANT,
      ...(record.userId ? { userId: record.userId } : {}),
      lastSeenAt: this.now(),
    };
    return {
      sessionId: record.sessionId,
      kind: 'tui',
      project: record.project,
      ...(opts.includeTitle && record.title ? { title: record.title } : {}),
      participant,
      ...(opts.reopen ? { reopen: true } : {}),
    };
  }

  private withFreshLastSeen(input: RegisterSharedSessionInput): RegisterSharedSessionInput {
    return { ...input, participant: { ...input.participant, lastSeenAt: this.now() } };
  }

  private dispatchRegister(input: RegisterSharedSessionInput): void {
    if (!this.sessionsClient) {
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      return;
    }
    void this.runRegister(input);
  }

  private async runRegister(input: RegisterSharedSessionInput): Promise<void> {
    const client = this.sessionsClient;
    if (!client) {
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      return;
    }
    try {
      await client.register(input);
      this.reachability = 'online';
      await this.flush();
    } catch (error) {
      // Fire-and-forget contract: absorb everything, degrade honestly, queue for replay.
      this.reachability = 'offline';
      this.enqueue({ type: 'register', sessionId: input.sessionId, input });
      this.log.debug('session spine register failed — queued for reconnect', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runClose(sessionId: string): Promise<void> {
    const client = this.sessionsClient;
    if (!client) {
      this.enqueue({ type: 'close', sessionId });
      return;
    }
    try {
      await client.close(sessionId);
      this.reachability = 'online';
    } catch (error) {
      this.reachability = 'offline';
      this.enqueue({ type: 'close', sessionId });
      this.log.debug('session spine close failed — queued for reconnect', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private enqueue(op: QueuedOp): void {
    if (this.queue.length >= this.queueLimit) this.queue.shift(); // drop-oldest
    this.queue.push(op);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    const client = this.sessionsClient;
    if (!client) return;
    this.flushing = true;
    try {
      const pending = this.queue.splice(0, this.queue.length);
      for (const op of pending) {
        try {
          if (op.type === 'register' && op.input) {
            await client.register(op.input);
          } else if (op.type === 'close') {
            await client.close(op.sessionId);
          }
          this.reachability = 'online';
        } catch (error) {
          this.reachability = 'offline';
          this.enqueue(op);
          this.log.debug('session spine flush op failed — re-queued', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export interface FoldLegacySpineStoreOptions {
  readonly storePath: string;
  readonly markerPath: string;
  readonly project: string;
  readonly now?: () => number;
  readonly log?: SpineLogger;
}

export interface FoldLegacySpineStoreResult {
  readonly folded: number;
  readonly skipped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads the TUI's OWN project-scoped control-plane sessions.json (the store
 * `services.ts` constructs at `shellPaths.resolveProjectPath('tui',
 * 'control-plane', 'sessions.json')`) and folds each record into the daemon
 * via the client (register upsert; closed records also closed). Writes a
 * marker file (`<storePath>.migrated`-style path, caller decides exact name)
 * so subsequent runs are a no-op. Register is idempotent, so even a
 * marker-less re-run is safe. Only folds the store for the project it is
 * invoked from — the per-project discovery scope is documented, not silently
 * "complete" across every project this TUI has ever run in.
 */
export function foldLegacySpineStore(
  client: Pick<SessionSpineClient, 'foldLegacyRecords'>,
  options: FoldLegacySpineStoreOptions,
): FoldLegacySpineStoreResult {
  const log = options.log ?? logger;
  if (existsSync(options.markerPath)) return { folded: 0, skipped: true };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.storePath, 'utf-8')) as unknown;
  } catch {
    // No store (or unreadable) -> nothing to fold; do not write a marker so a
    // later run with a real store still folds.
    return { folded: 0, skipped: false };
  }

  const sessions = isRecord(raw) && isRecord(raw.sessions) ? raw.sessions : {};
  const records: SessionSpineRecord[] = [];
  const closedIds = new Set<string>();
  for (const [key, value] of Object.entries(sessions)) {
    if (!isRecord(value)) continue;
    const sessionId = typeof value.id === 'string' && value.id.trim().length > 0 ? value.id : key;
    const title = typeof value.title === 'string' ? value.title : undefined;
    records.push({ sessionId, project: options.project, ...(title ? { title } : {}) });
    if (value.status === 'closed') closedIds.add(sessionId);
  }

  client.foldLegacyRecords(records, closedIds);

  try {
    mkdirSync(dirname(options.markerPath), { recursive: true });
    writeFileSync(
      options.markerPath,
      JSON.stringify(
        { migratedAt: (options.now ?? Date.now)(), count: records.length, source: options.storePath },
        null,
        2,
      ),
    );
  } catch (err) {
    log.debug('session spine legacy fold marker write failed', { err });
  }

  return { folded: records.length, skipped: false };
}
