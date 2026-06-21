// ---------------------------------------------------------------------------
// Persistent cursor + item store for the inbound feed.
//
// Backed by OperatorSqliteStore (sql.js WASM) at
//   {wd}/.goodvibes/tui/operator/inbox.sqlite
//
// Two tables:
//   items(id PK, provider, kind, fromDigest, subjectPreview, bodyPreview,
//         routeId, receivedAt INT, unread INT, triageScore REAL NULL,
//         triageTags TEXT NULL)
//   cursors(provider PK, nextSince INT)
//
// Dedup is by items.id (INSERT OR IGNORE / upsert). nextSince advances
// monotonically per provider = max(receivedAt) ever seen. triageScore/
// triageTags columns are written by the triage surface; we only READ them.
// ---------------------------------------------------------------------------

import { OperatorSqliteStore } from '../../operator/index.ts';
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
     unread INTEGER NOT NULL,
     triageScore REAL,
     triageTags TEXT
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
  triageScore: number | null;
  triageTags: string | null;
}

export interface InboxQuery {
  providers?: readonly string[];
  since?: number;
  /** Max items returned across the whole query. */
  limit: number;
}

export class InboxCursorStore {
  private readonly store: OperatorSqliteStore;
  private dirty = false;

  constructor(workingDirectory: string, fileName = 'inbox.sqlite') {
    this.store = new OperatorSqliteStore({
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
   * Insert/refresh items, deduping by id. Existing rows keep their triage
   * columns (written by the triage surface) and are NOT clobbered — only the
   * mutable feed fields (unread, previews, routeId, receivedAt) are updated.
   * Returns the number of NEW (previously unseen) items.
   */
  upsertItems(items: readonly InboundChannelItem[]): number {
    if (items.length === 0) return 0;
    let inserted = 0;
    const existing = new Set(
      this.store
        .all<{ id: string }>('SELECT id FROM items')
        .map((r) => r.id),
    );
    this.store.transaction(() => {
      for (const item of items) {
        const isNew = !existing.has(item.id);
        if (isNew) inserted += 1;
        // Upsert preserving triage columns: ON CONFLICT updates feed fields only.
        this.store.run(
          `INSERT INTO items
             (id, provider, kind, fromDigest, subjectPreview, bodyPreview,
              routeId, receivedAt, unread, triageScore, triageTags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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
    if (inserted > 0 || items.length > 0) this.dirty = true;
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

  /**
   * Write triage metadata for an existing item. Provided so the triage surface
   * has a typed, scoped path to populate the triageScore/triageTags columns this
   * store reads back (no raw SQL needed by callers). No-op when the id is unknown.
   */
  applyTriage(id: string, triageScore: number | null, triageTags: readonly string[] | null): void {
    const tags = triageTags && triageTags.length > 0 ? JSON.stringify(triageTags) : null;
    this.store.run(
      'UPDATE items SET triageScore = ?, triageTags = ? WHERE id = ?',
      [triageScore, tags, id],
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
   * capped at limit. Maps SQLite rows back to the wire shape.
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
              routeId, receivedAt, unread, triageScore, triageTags
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

  /** Count of items per provider for the (optional) provider set. */
  countByProvider(providers?: readonly string[]): Map<string, number> {
    let where = '';
    const params: (string | number)[] = [];
    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(', ');
      where = `WHERE provider IN (${placeholders})`;
      params.push(...providers);
    }
    const rows = this.store.all<{ provider: string; n: number }>(
      `SELECT provider, COUNT(*) AS n FROM items ${where} GROUP BY provider`,
      params,
    );
    const out = new Map<string, number>();
    for (const row of rows) out.set(row.provider, Number(row.n));
    return out;
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
  if (row.triageScore != null) item.triageScore = Number(row.triageScore);
  if (row.triageTags != null) {
    const tags = parseTags(row.triageTags);
    if (tags.length > 0) item.triageTags = tags;
  }
  return item;
}

function normalizeKind(value: string): InboundChannelItem['kind'] {
  return value === 'dm' || value === 'thread' || value === 'mention' || value === 'reaction'
    ? value
    : 'dm';
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    // Fall through to comma-split fallback for non-JSON legacy values.
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
