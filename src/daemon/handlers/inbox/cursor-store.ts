// ---------------------------------------------------------------------------
// Persistent cursor + item store for the inbound feed.
//
// Backed by HandlerSqliteStore (sql.js WASM) at
//   {wd}/.goodvibes/tui/operator/inbox.sqlite
//
// Two tables:
//   items(id PK, provider, kind, fromDigest, subjectPreview, bodyPreview,
//         routeId, receivedAt INT, unread INT)
//   cursors(provider PK, nextSince INT)
//
// Dedup is by items.id (upsert). nextSince advances monotonically per provider
// = max(receivedAt) ever seen. Triage metadata is NOT persisted here: it is
// applied downstream at the triage overlay layer (triage/integration.ts) over a
// separate store, so this feed store carries only the raw inbound fields.
//
// RETENTION. The items table is bounded by BOTH an age TTL and a count cap, and
// the sweep runs at init() — the recovery point, right after the database file
// is opened — and then on a timer for the life of the store, so a daemon that
// stays up for weeks keeps reclaiming. `pruneOlderThan` used to exist with no
// production caller at all, which meant the table grew without bound in
// practice. Reclaimed counts are handed to the `onSweep` hook (counts only —
// message previews and sender ids never reach a log line).
//
// Cursors are deliberately NOT reaped: they are monotonic watermarks, so
// dropping one would re-deliver everything a provider ever sent.
//
// Idempotence/concurrency: a sweep re-run immediately reclaims nothing (the
// DELETEs are set-based over the current contents). Two processes opening the
// same file each hold their own sql.js snapshot and `save()` writes the whole
// file via temp+rename, so the last writer wins — that whole-file model is
// HandlerSqliteStore's, and deletion converging on the same surviving set is
// what makes concurrent sweeps safe rather than corrupting.
// ---------------------------------------------------------------------------

import { HandlerSqliteStore } from '../sqlite-store.ts';
import type { InboundChannelItem } from './provider-adapter.ts';

/**
 * Age TTL for feed items: rows whose receivedAt is older than this are dropped
 * on every sweep. Long enough that "what did that person say last month" still
 * works, short enough that the table cannot grow indefinitely.
 */
export const INBOX_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Count cap for feed items: the newest this many rows survive a sweep, older
 * ones are dropped. Guards the case the TTL cannot — a very chatty month.
 */
export const INBOX_ITEM_CAP = 5_000;

/**
 * Cadence of the background retention sweep. The first sweep happens at init();
 * this timer is what keeps it from being a startup-only reap.
 */
export const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_STORE_FILE_NAME = 'inbox.sqlite';

/** Result of one retention sweep. Counts only — never item content. */
export interface InboxSweepSummary {
  /** Unix ms of the sweep. */
  readonly at: number;
  /** Rows removed by the age TTL. */
  readonly expired: number;
  /** Rows removed by the count cap. */
  readonly capped: number;
  /** Rows left in the items table afterwards. */
  readonly remaining: number;
}

export interface InboxCursorStoreOptions {
  /** Override the age TTL (tests / embedders). Defaults to INBOX_ITEM_TTL_MS. */
  readonly itemTtlMs?: number;
  /** Override the count cap (tests / embedders). Defaults to INBOX_ITEM_CAP. */
  readonly itemCap?: number;
  /** Sweep cadence; 0 or less disables the timer (the init sweep still runs). */
  readonly sweepIntervalMs?: number;
  /** Called after a sweep that reclaimed at least one row. Counts only. */
  readonly onSweep?: (summary: InboxSweepSummary) => void;
  /** Called when a sweep failed, so retention problems are visible rather than swallowed. */
  readonly onSweepError?: (message: string) => void;
  /** Clock seam (tests). Defaults to Date.now. */
  readonly now?: () => number;
  /** Timer seams (tests). Default to the globals. */
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     kind TEXT NOT NULL,
     fromDigest TEXT NOT NULL,
     subjectPreview TEXT NOT NULL,
     bodyPreview TEXT NOT NULL,
     routeId TEXT,
     receivedAt INTEGER NOT NULL,
     unread INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_provider_received
     ON items(provider, receivedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_items_received
     ON items(receivedAt)`,
  `CREATE TABLE IF NOT EXISTS cursors (
     provider TEXT PRIMARY KEY,
     nextSince INTEGER NOT NULL
   )`,
];

interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  fromDigest: string;
  subjectPreview: string;
  bodyPreview: string;
  routeId: string | null;
  receivedAt: number;
  unread: number;
}

export interface InboxQuery {
  providers?: readonly string[];
  since?: number;
  /** Max items returned across the whole query. */
  limit: number;
}

export class InboxCursorStore {
  private readonly store: HandlerSqliteStore;
  private dirty = false;
  private readonly itemTtlMs: number;
  private readonly itemCap: number;
  private readonly sweepIntervalMs: number;
  private readonly onSweep: ((summary: InboxSweepSummary) => void) | undefined;
  private readonly onSweepError: ((message: string) => void) | undefined;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Set by close(). `init()` is async and arms the retention timer only after
   * two awaits, so a surface that is torn down while its bootstrap is still in
   * flight would otherwise arm a timer AFTER the only thing that could clear it
   * had already run. That is not hypothetical: registerInboxMethods() kicks
   * init() off without awaiting it, so any shutdown inside the first tick of a
   * daemon's life hits exactly this window.
   */
  private closed = false;

  constructor(
    workingDirectory: string,
    fileName: string = DEFAULT_STORE_FILE_NAME,
    options: InboxCursorStoreOptions = {},
  ) {
    this.store = new HandlerSqliteStore({
      workingDirectory,
      fileName: fileName || DEFAULT_STORE_FILE_NAME,
      schema: SCHEMA,
    });
    this.itemTtlMs = options.itemTtlMs ?? INBOX_ITEM_TTL_MS;
    this.itemCap = options.itemCap ?? INBOX_ITEM_CAP;
    this.sweepIntervalMs = options.sweepIntervalMs ?? INBOX_SWEEP_INTERVAL_MS;
    this.onSweep = options.onSweep;
    this.onSweepError = options.onSweepError;
    this.now = options.now ?? Date.now;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  /**
   * Open the database, then immediately reap: recovery is exactly when stale
   * rows from previous runs must go. The periodic timer starts afterwards so
   * retention is not a startup-only event.
   */
  async init(): Promise<void> {
    await this.store.init();
    await this.runSweep();
    this.startSweepTimer();
  }

  /**
   * One retention pass: age TTL first, then the count cap over what is left.
   * Returns counts only. Running it twice in a row reclaims nothing the second
   * time — the pass is a function of the table's current contents.
   */
  sweepRetention(): InboxSweepSummary {
    const at = this.now();
    const expired = this.pruneOlderThan(at - this.itemTtlMs);
    const capped = this.enforceItemCap();
    return { at, expired, capped, remaining: this.countItems() };
  }

  /** Sweep, persist if anything was reclaimed, and disclose the counts. Never throws. */
  private async runSweep(): Promise<void> {
    try {
      const summary = this.sweepRetention();
      if (summary.expired + summary.capped === 0) return;
      await this.flush();
      this.onSweep?.(summary);
    } catch (error) {
      this.onSweepError?.(error instanceof Error ? error.message : String(error));
    }
  }

  private startSweepTimer(): void {
    if (this.closed || this.sweepTimer !== null || this.sweepIntervalMs <= 0) return;
    const handle = this.setIntervalImpl(() => {
      void this.runSweep();
    }, this.sweepIntervalMs);
    // Retention must never be the reason the process stays alive (Bun/Node unref).
    (handle as unknown as { unref?: () => void }).unref?.();
    this.sweepTimer = handle;
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer === null) return;
    this.clearIntervalImpl(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Count cap: keep the newest `itemCap` rows (receivedAt DESC, id ASC — the
   * same order listItems() uses), delete the rest. Returns rows removed.
   */
  private enforceItemCap(): number {
    const before = this.countItems();
    if (before <= this.itemCap) return 0;
    this.store.run(
      `DELETE FROM items WHERE id NOT IN (
         SELECT id FROM items ORDER BY receivedAt DESC, id ASC LIMIT ?
       )`,
      [this.itemCap],
    );
    const removed = before - this.countItems();
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /**
   * Insert/refresh items, deduping by id. On conflict the mutable feed fields
   * (unread, previews, routeId, receivedAt) are updated in place.
   * Returns the number of NEW (previously unseen) items.
   */
  upsertItems(items: readonly InboundChannelItem[]): number {
    if (items.length === 0) return 0;
    let inserted = 0;
    // Only the ids in THIS batch can collide, so probe for exactly those rather
    // than loading the whole table — bounds the lookup to the poll size instead
    // of growing O(n) with the (unbounded) feed.
    const batchIds = [...new Set(items.map((i) => i.id))];
    const placeholders = batchIds.map(() => '?').join(', ');
    const existing = new Set(
      this.store
        .all<{ id: string }>(
          `SELECT id FROM items WHERE id IN (${placeholders})`,
          batchIds,
        )
        .map((r) => r.id),
    );
    // Track ids seen within this batch so a duplicate id in a single poll is
    // counted (and inserted) once, not once per occurrence.
    const seen = new Set<string>();
    this.store.transaction(() => {
      for (const item of items) {
        const isNew = !existing.has(item.id) && !seen.has(item.id);
        if (isNew) inserted += 1;
        seen.add(item.id);
        this.store.run(
          `INSERT INTO items
             (id, provider, kind, fromDigest, subjectPreview, bodyPreview,
              routeId, receivedAt, unread)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider = excluded.provider,
             kind = excluded.kind,
             fromDigest = excluded.fromDigest,
             subjectPreview = excluded.subjectPreview,
             bodyPreview = excluded.bodyPreview,
             routeId = COALESCE(excluded.routeId, items.routeId),
             receivedAt = excluded.receivedAt,
             unread = excluded.unread`,
          [
            item.id,
            item.provider,
            item.kind,
            item.fromDigest,
            item.subjectPreview,
            item.bodyPreview,
            item.routeId ?? null,
            item.receivedAt,
            item.unread ? 1 : 0,
          ],
        );
      }
    });
    this.dirty = true;
    return inserted;
  }

  /**
   * Advance a provider's cursor monotonically. The stored value is always the
   * max of the current value and the supplied candidate.
   */
  advanceCursor(provider: string, candidate: number): void {
    if (!Number.isFinite(candidate)) return;
    const current = this.getCursor(provider);
    const next = Math.max(current, Math.floor(candidate));
    if (next === current && current !== 0) return;
    this.store.run(
      `INSERT INTO cursors (provider, nextSince) VALUES (?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         nextSince = MAX(cursors.nextSince, excluded.nextSince)`,
      [provider, next],
    );
    this.dirty = true;
  }

  /** Current cursor for a provider (0 when unset). */
  getCursor(provider: string): number {
    const row = this.store.get<{ nextSince: number }>(
      'SELECT nextSince FROM cursors WHERE provider = ?',
      [provider],
    );
    return row ? Number(row.nextSince) : 0;
  }

  /**
   * Read items for the feed, filtered by provider set + since, newest first,
   * capped at limit. Maps SQLite rows back to the internal item shape.
   */
  listItems(query: InboxQuery): InboundChannelItem[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.providers && query.providers.length > 0) {
      const placeholders = query.providers.map(() => '?').join(', ');
      clauses.push(`provider IN (${placeholders})`);
      params.push(...query.providers);
    }
    if (typeof query.since === 'number' && Number.isFinite(query.since)) {
      clauses.push('receivedAt > ?');
      params.push(Math.floor(query.since));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(0, Math.floor(query.limit));
    params.push(limit);
    const rows = this.store.all<ItemRow>(
      `SELECT id, provider, kind, fromDigest, subjectPreview, bodyPreview,
              routeId, receivedAt, unread
         FROM items ${where}
         ORDER BY receivedAt DESC, id ASC
         LIMIT ?`,
      params,
    );
    return rows.map(rowToItem);
  }

  /** Highest receivedAt across the (optionally provider-filtered) feed, or 0. */
  maxReceivedAt(providers?: readonly string[]): number {
    let where = '';
    const params: (string | number)[] = [];
    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(', ');
      where = `WHERE provider IN (${placeholders})`;
      params.push(...providers);
    }
    const row = this.store.get<{ maxReceived: number | null }>(
      `SELECT MAX(receivedAt) AS maxReceived FROM items ${where}`,
      params,
    );
    return row && row.maxReceived != null ? Number(row.maxReceived) : 0;
  }

  /** Total count of items across the (optional) provider set. */
  countItems(providers?: readonly string[]): number {
    let where = '';
    const params: (string | number)[] = [];
    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(', ');
      where = `WHERE provider IN (${placeholders})`;
      params.push(...providers);
    }
    const row = this.store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items ${where}`,
      params,
    );
    return row ? Number(row.n) : 0;
  }

  /**
   * Retention: delete items strictly older than `cutoff` (Unix ms), optionally
   * scoped to a provider set. Returns the number of rows removed. Cursors are
   * left untouched so already-consumed watermarks never regress. A non-finite
   * cutoff is a no-op (prevents an accidental whole-table wipe).
   */
  pruneOlderThan(cutoff: number, providers?: readonly string[]): number {
    if (!Number.isFinite(cutoff)) return 0;
    const clauses = ['receivedAt < ?'];
    const params: (string | number)[] = [Math.floor(cutoff)];
    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(', ');
      clauses.push(`provider IN (${placeholders})`);
      params.push(...providers);
    }
    const before = this.countItems(providers);
    this.store.run(`DELETE FROM items WHERE ${clauses.join(' AND ')}`, params);
    const removed = before - this.countItems(providers);
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** Persist to disk if anything changed since the last flush. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.store.save();
    this.dirty = false;
  }

  /** Stop the retention timer, flush (best-effort), then close the database. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopSweepTimer();
    try {
      await this.flush();
    } finally {
      this.store.close();
    }
  }
}

function rowToItem(row: ItemRow): InboundChannelItem {
  const item: InboundChannelItem = {
    id: row.id,
    provider: row.provider,
    kind: normalizeKind(row.kind),
    fromDigest: row.fromDigest,
    subjectPreview: row.subjectPreview,
    bodyPreview: row.bodyPreview,
    receivedAt: Number(row.receivedAt),
    unread: Number(row.unread) !== 0,
  };
  if (row.routeId != null) item.routeId = row.routeId;
  return item;
}

function normalizeKind(value: string): InboundChannelItem['kind'] {
  return value === 'dm' || value === 'thread' || value === 'mention' || value === 'reaction'
    ? value
    : 'dm';
}
