/**
 * MemoryStore — Project Memory Substrate (Section 5.8).
 *
 * Durable, provenance-rich memory for decisions, constraints, incidents, and
 * patterns. Backed by SQLite via SQLiteStore. Survives process restarts and is
 * queryable by runtime/panel/context enrichment consumers.
 *
 * Provenance links can reference: session, turn, task, event, or file.
 */

import { randomUUID } from 'node:crypto';
import { SQLiteStore } from './sqlite-store.ts';
import { logger } from '../utils/logger.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryClass = 'decision' | 'constraint' | 'incident' | 'pattern';

export type ProvenanceLinkKind = 'session' | 'turn' | 'task' | 'event' | 'file';

export interface ProvenanceLink {
  kind: ProvenanceLinkKind;
  /** The referenced identifier (session ID, turn number, task ID, event ID, or file path). */
  ref: string;
  /** Optional human-readable label. */
  label?: string;
}

export interface MemoryRecord {
  /** Auto-assigned, unique within the store. */
  id: string;
  /** Memory class — governs retrieval priority and display grouping. */
  cls: MemoryClass;
  /** Brief summary (one sentence). */
  summary: string;
  /** Optional expanded detail. */
  detail?: string;
  /** Tags for search and grouping. */
  tags: string[];
  /** Provenance links back to the source context. */
  provenance: ProvenanceLink[];
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last updated timestamp (epoch ms). */
  updatedAt: number;
}

export interface MemoryLink {
  /** ID of the source record. */
  fromId: string;
  /** ID of the target record. */
  toId: string;
  /** Human-readable relationship label, e.g. "caused", "supersedes". */
  relation: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
}

export interface MemorySearchFilter {
  cls?: MemoryClass;
  tags?: string[];
  /** Full-text substring match on summary and detail. */
  query?: string;
  /** Return records created after this timestamp. */
  since?: number;
  limit?: number;
}

export interface MemoryAddOptions {
  cls: MemoryClass;
  summary: string;
  detail?: string;
  tags?: string[];
  provenance?: ProvenanceLink[];
}

// ── Internal schema helper ────────────────────────────────────────────────────

function createSchema(db: { run(sql: string): void }): void {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id         TEXT PRIMARY KEY,
      cls        TEXT NOT NULL,
      summary    TEXT NOT NULL,
      detail     TEXT,
      tags       TEXT NOT NULL DEFAULT '[]',
      provenance TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_links (
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, relation),
      FOREIGN KEY(from_id) REFERENCES memory_records(id) ON DELETE CASCADE,
      FOREIGN KEY(to_id) REFERENCES memory_records(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_cls ON memory_records(cls)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_records(created_at)`);
}

// ── MemoryRegistry — panel-observable counter ─────────────────────────────────

/**
 * MemoryRegistry — thin observable wrapper around the MemoryStore.
 * Panels subscribe via listeners; commands push/retrieve through this.
 */
export class MemoryRegistry {
  private store: MemoryStore;
  private listeners: Array<() => void> = [];

  constructor(store: MemoryStore) {
    this.store = store;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  async add(opts: MemoryAddOptions): Promise<MemoryRecord> {
    const record = await this.store.add(opts);
    this.notify();
    return record;
  }

  search(filter: MemorySearchFilter = {}): MemoryRecord[] {
    return this.store.search(filter);
  }

  get(id: string): MemoryRecord | null {
    return this.store.get(id);
  }

  async link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null> {
    const link = await this.store.link(fromId, toId, relation);
    if (link) this.notify();
    return link;
  }

  linksFor(id: string): MemoryLink[] {
    return this.store.linksFor(id);
  }

  update(id: string, patch: { summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    const record = this.store.update(id, patch);
    if (record) this.notify();
    return record;
  }

  delete(id: string): boolean {
    const removed = this.store.delete(id);
    if (removed) this.notify();
    return removed;
  }

  getAll(): MemoryRecord[] {
    return this.store.search({});
  }
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private sqlite: SQLiteStore;
  private ready = false;

  constructor(dbPath?: string) {
    this.sqlite = new SQLiteStore(dbPath);
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.sqlite.init(createSchema as Parameters<SQLiteStore['init']>[0]);
    this.ready = true;
    logger.info('MemoryStore: initialized', { ready: true });
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Add a new memory record. Returns the created record. */
  async add(opts: MemoryAddOptions): Promise<MemoryRecord> {
    if (!this.ready) throw new Error('MemoryStore: not initialized');

    const now = Date.now();
    const id = `mem_${now.toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const record: MemoryRecord = {
      id,
      cls: opts.cls,
      summary: opts.summary,
      detail: opts.detail,
      tags: opts.tags ?? [],
      provenance: opts.provenance ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.sqlite.run(
      `INSERT INTO memory_records
         (id, cls, summary, detail, tags, provenance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.cls,
        record.summary,
        record.detail ?? null,
        JSON.stringify(record.tags),
        JSON.stringify(record.provenance),
        record.createdAt,
        record.updatedAt,
      ],
    );

    logger.info('MemoryStore: record added', { id, cls: opts.cls });
    return record;
  }

  /** Retrieve a single record by ID. */
  get(id: string): MemoryRecord | null {
    if (!this.ready) return null;

    const rows = this.sqlite.exec(
      `SELECT id, cls, summary, detail, tags, provenance, created_at, updated_at
         FROM memory_records WHERE id = ? LIMIT 1`,
      [id],
    );

    if (!rows.length || !rows[0].values.length) return null;
    return this.rowToRecord(rows[0].columns, rows[0].values[0]);
  }

  /** Search records with an optional filter. */
  search(filter: MemorySearchFilter = {}): MemoryRecord[] {
    if (!this.ready) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.cls) {
      conditions.push('cls = ?');
      params.push(filter.cls);
    }

    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    if (filter.query) {
      const escaped = filter.query.replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push("(summary LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    if (filter.tags?.length) {
      for (const tag of filter.tags) {
        const escapedTag = tag.replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapedTag}"%`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;

    const rows = this.sqlite.exec(
      `SELECT id, cls, summary, detail, tags, provenance, created_at, updated_at
         FROM memory_records ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
      [...params, limit],
    );

    if (!rows.length) return [];

    let records = rows[0].values.map(v => this.rowToRecord(rows[0].columns, v));

    return records;
  }

  /** Create a directed link between two records. */
  async link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null> {
    if (!this.ready) return null;

    const from = this.get(fromId);
    const to = this.get(toId);

    if (!from) {
      logger.warn('MemoryStore: link source not found', { fromId });
      return null;
    }
    if (!to) {
      logger.warn('MemoryStore: link target not found', { toId });
      return null;
    }

    const now = Date.now();

    try {
      this.sqlite.run(
        `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
        [fromId, toId, relation, now],
      );
    } catch (err) {
      logger.error('MemoryStore: link insert failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    return { fromId, toId, relation, createdAt: now };
  }

  /** Get all links where this record is either source or target. */
  linksFor(id: string): MemoryLink[] {
    if (!this.ready) return [];

    const rows = this.sqlite.exec(
      `SELECT from_id, to_id, relation, created_at
         FROM memory_links
         WHERE from_id = ? OR to_id = ?
         ORDER BY created_at DESC`,
      [id, id],
    );

    if (!rows.length) return [];

    return rows[0].values.map(v => {
      const col = rows[0].columns;
      return {
        fromId:    String(v[col.indexOf('from_id')]),
        toId:      String(v[col.indexOf('to_id')]),
        relation:  String(v[col.indexOf('relation')]),
        createdAt: Number(v[col.indexOf('created_at')]),
      };
    });
  }

  /** Update mutable fields of an existing record. */
  update(id: string, patch: { summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    if (!this.ready) return null;

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: update target not found', { id });
      return null;
    }

    const now = Date.now();
    const newSummary = patch.summary ?? existing.summary;
    const newDetail  = patch.detail  !== undefined ? patch.detail : existing.detail;
    const newTags    = patch.tags    ?? existing.tags;

    this.sqlite.run(
      `UPDATE memory_records
         SET summary = ?, detail = ?, tags = ?, updated_at = ?
         WHERE id = ?`,
      [newSummary, newDetail ?? null, JSON.stringify(newTags), now, id],
    );

    logger.info('MemoryStore: record updated', { id });
    return { ...existing, summary: newSummary, detail: newDetail, tags: newTags, updatedAt: now };
  }

  /** Delete a record and all its links. */
  delete(id: string): boolean {
    if (!this.ready) return false;

    const existing = this.get(id);
    if (!existing) return false;

    // Links are cascade-deleted via FK constraint (foreign_keys = ON)
    this.sqlite.run('DELETE FROM memory_records WHERE id = ?', [id]);
    logger.info('MemoryStore: record deleted', { id });
    return true;
  }

  async save(): Promise<boolean> {
    return this.sqlite.save();
  }

  close(): void {
    this.sqlite.close();
    this.ready = false;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private rowToRecord(columns: string[], values: unknown[]): MemoryRecord {
    const get = (col: string) => values[columns.indexOf(col)];

    const tagsRaw = get('tags');
    const provRaw  = get('provenance');

    return {
      id:         String(get('id')),
      cls:        String(get('cls')) as MemoryClass,
      summary:    String(get('summary')),
      detail:     get('detail') != null ? String(get('detail')) : undefined,
      tags:       Array.isArray(tagsRaw) ? tagsRaw : safeParseJson<string[]>(String(tagsRaw), []),
      provenance: Array.isArray(provRaw) ? provRaw : safeParseJson<ProvenanceLink[]>(String(provRaw), []),
      createdAt:  Number(get('created_at')),
      updatedAt:  Number(get('updated_at')),
    };
  }
}

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _store: MemoryStore | undefined;
let _registry: MemoryRegistry | undefined;

export function getMemoryStore(dbPath?: string): MemoryStore {
  if (!_store) {
    _store = new MemoryStore(dbPath);
  }
  return _store;
}

export function getMemoryRegistry(dbPath?: string): MemoryRegistry {
  if (!_registry) {
    _registry = new MemoryRegistry(getMemoryStore(dbPath));
  }
  return _registry;
}
