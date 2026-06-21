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
// ---------------------------------------------------------------------------

import { HandlerSqliteStore } from '../sqlite-store.ts';
import type { InboundChannelItem } from './provider-adapter.ts';

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

  constructor(workingDirectory: string, fileName = 'inbox.sqlite') {
    this.store = new HandlerSqliteStore({
      workingDirectory,
      fileName,
      schema: SCHEMA,
    });
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  async init(): Promise<void> {
    await this.store.init();
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

  /** Flush (best-effort) then close the underlying database. */
  async close(): Promise<void> {
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
