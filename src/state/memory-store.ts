/**
 * MemoryStore — project memory substrate.
 *
 * Durable, provenance-rich memory for decisions, constraints, incidents, and
 * patterns. Backed by SQLite via SQLiteStore. Survives process restarts and is
 * queryable by runtime/panel/context enrichment consumers.
 *
 * Provenance links can reference: session, turn, task, event, or file.
 */

import { randomUUID } from 'node:crypto';
import { SQLiteStore } from './sqlite-store.ts';
import {
  SqliteVecMemoryIndex,
  type MemoryVectorStats,
  resolveMemoryVectorDbPath,
} from './memory-vector-store.ts';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingDoctorReport,
} from './memory-embeddings.ts';
import { logger } from '../utils/logger.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryClass =
  | 'decision'
  | 'constraint'
  | 'incident'
  | 'pattern'
  | 'fact'
  | 'risk'
  | 'runbook'
  | 'architecture'
  | 'ownership';

export type MemoryScope = 'session' | 'project' | 'team';

export type MemoryReviewState = 'fresh' | 'reviewed' | 'stale' | 'contradicted';

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
  /** Scope of the record for retrieval and sharing workflows. */
  scope: MemoryScope;
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
  /** Operator/state review signal. */
  reviewState: MemoryReviewState;
  /** Confidence score from 0-100. Higher means the record is more trusted for retrieval. */
  confidence: number;
  /** Last explicit review timestamp, if any. */
  reviewedAt?: number;
  /** Reviewer identity, if recorded. */
  reviewedBy?: string;
  /** If stale/contradicted, why. */
  staleReason?: string;
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
  scope?: MemoryScope;
  cls?: MemoryClass;
  tags?: string[];
  /** Full-text substring match on summary and detail. */
  query?: string;
  /** Use the sqlite-vec semantic index for query ranking when available. */
  semantic?: boolean;
  /** Return records created after this timestamp. */
  since?: number;
  /** Match a specific review state or a small set of states. */
  reviewState?: MemoryReviewState | MemoryReviewState[];
  /** Minimum confidence threshold, 0-100. */
  minConfidence?: number;
  /** Restrict to records with at least one matching provenance kind. */
  provenanceKinds?: ProvenanceLinkKind[];
  /** Convenience flag for review queue retrieval. */
  staleOnly?: boolean;
  limit?: number;
}

export interface MemoryAddOptions {
  scope?: MemoryScope;
  cls: MemoryClass;
  summary: string;
  detail?: string;
  tags?: string[];
  provenance?: ProvenanceLink[];
  review?: {
    state?: MemoryReviewState;
    confidence?: number;
    reviewedAt?: number;
    reviewedBy?: string;
    staleReason?: string;
  };
}

export interface MemoryReviewPatch {
  state?: MemoryReviewState;
  confidence?: number;
  reviewedBy?: string;
  staleReason?: string;
}

export interface MemoryBundle {
  schemaVersion: 'v1';
  exportedAt: number;
  scope: MemoryScope | 'all';
  recordCount: number;
  linkCount: number;
  records: MemoryRecord[];
  links: MemoryLink[];
}

export interface MemoryImportResult {
  importedRecords: number;
  skippedRecords: number;
  importedLinks: number;
}

export interface MemorySemanticSearchResult {
  record: MemoryRecord;
  distance: number;
  similarity: number;
  score: number;
}

export interface MemoryStoreOptions {
  enableVectorIndex?: boolean;
  vectorDbPath?: string;
}

export interface MemoryDoctorReport {
  readonly vector: MemoryVectorStats;
  readonly embeddings: MemoryEmbeddingDoctorReport;
  readonly checkedAt: number;
}

// ── Internal schema helper ────────────────────────────────────────────────────

function createSchema(db: { run(sql: string): void; exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> }): void {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL DEFAULT 'project',
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_records(created_at)`);

  ensureColumn(db, 'memory_records', 'scope TEXT NOT NULL DEFAULT \'project\'', 'scope');
  ensureColumn(db, 'memory_records', 'review_state TEXT NOT NULL DEFAULT \'fresh\'', 'review_state');
  ensureColumn(db, 'memory_records', 'confidence INTEGER NOT NULL DEFAULT 60', 'confidence');
  ensureColumn(db, 'memory_records', 'reviewed_at INTEGER', 'reviewed_at');
  ensureColumn(db, 'memory_records', 'reviewed_by TEXT', 'reviewed_by');
  ensureColumn(db, 'memory_records', 'stale_reason TEXT', 'stale_reason');
}

function ensureColumn(
  db: { run(sql: string): void; exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> },
  table: string,
  columnSql: string,
  columnName: string,
): void {
  const rows = db.exec(`PRAGMA table_info(${table})`);
  const existing = new Set<string>();
  if (rows[0]) {
    const nameIndex = rows[0].columns.indexOf('name');
    for (const value of rows[0].values) {
      if (nameIndex >= 0) {
        existing.add(String(value[nameIndex]));
      }
    }
  }
  if (!existing.has(columnName)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  }
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

  searchSemantic(filter: MemorySearchFilter = {}): MemorySemanticSearchResult[] {
    return this.store.searchSemantic(filter);
  }

  rebuildVectors(): MemoryVectorStats {
    return this.store.rebuildVectorIndex();
  }

  vectorStats(): MemoryVectorStats {
    return this.store.vectorStats();
  }

  async doctor(): Promise<MemoryDoctorReport> {
    return this.store.doctor();
  }

  reviewQueue(limit = 10): MemoryRecord[] {
    return this.store.reviewQueue(limit);
  }

  exportBundle(filter: MemorySearchFilter = {}): MemoryBundle {
    return this.store.exportBundle(filter);
  }

  async importBundle(bundle: MemoryBundle): Promise<MemoryImportResult> {
    const result = await this.store.importBundle(bundle);
    this.notify();
    return result;
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

  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    const record = this.store.update(id, patch);
    if (record) this.notify();
    return record;
  }

  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    const record = this.store.review(id, patch);
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
  private vectorIndex: SqliteVecMemoryIndex | null;
  private ready = false;

  constructor(dbPath?: string, options: MemoryStoreOptions = {}) {
    this.sqlite = new SQLiteStore(dbPath);
    this.vectorIndex = options.enableVectorIndex === false
      ? null
      : new SqliteVecMemoryIndex(options.vectorDbPath ?? resolveMemoryVectorDbPath(dbPath));
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.sqlite.init(createSchema as Parameters<SQLiteStore['init']>[0]);
    this.ready = true;
    this.vectorIndex?.init();
    this.rebuildVectorIndex();
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
      scope: opts.scope ?? 'project',
      cls: opts.cls,
      summary: opts.summary,
      detail: opts.detail,
      tags: opts.tags ?? [],
      provenance: opts.provenance ?? [],
      reviewState: opts.review?.state ?? 'fresh',
      confidence: clampConfidence(opts.review?.confidence ?? 60),
      reviewedAt: opts.review?.reviewedAt,
      reviewedBy: opts.review?.reviewedBy,
      staleReason: opts.review?.staleReason,
      createdAt: now,
      updatedAt: now,
    };

    this.sqlite.run(
      `INSERT INTO memory_records
         (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.scope,
        record.cls,
        record.summary,
        record.detail ?? null,
        JSON.stringify(record.tags),
        JSON.stringify(record.provenance),
        record.reviewState,
        record.confidence,
        record.reviewedAt ?? null,
        record.reviewedBy ?? null,
        record.staleReason ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );

    logger.info('MemoryStore: record added', { id, cls: opts.cls });
    this.vectorIndex?.upsert(record);
    this.persist();
    return record;
  }

  /** Retrieve a single record by ID. */
  get(id: string): MemoryRecord | null {
    if (!this.ready) return null;

    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at
         FROM memory_records WHERE id = ? LIMIT 1`,
      [id],
    );

    if (!rows.length || !rows[0].values.length) return null;
    return this.rowToRecord(rows[0].columns, rows[0].values[0]);
  }

  /** Search records with an optional filter. */
  search(filter: MemorySearchFilter = {}): MemoryRecord[] {
    if (!this.ready) return [];
    if (filter.semantic) {
      return this.searchSemantic(filter).map((entry) => entry.record);
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.scope) {
      conditions.push('scope = ?');
      params.push(filter.scope);
    }

    if (filter.cls) {
      conditions.push('cls = ?');
      params.push(filter.cls);
    }

    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    if (filter.reviewState) {
      if (Array.isArray(filter.reviewState)) {
        conditions.push(`review_state IN (${filter.reviewState.map(() => '?').join(', ')})`);
        params.push(...filter.reviewState);
      } else {
        conditions.push('review_state = ?');
        params.push(filter.reviewState);
      }
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
    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at
         FROM memory_records ${where}
         ORDER BY updated_at DESC, created_at DESC`,
      params,
    );

    if (!rows.length) return [];

    let records = rows[0].values.map(v => this.rowToRecord(rows[0].columns, v));

    if (filter.minConfidence !== undefined) {
      records = records.filter((record) => record.confidence >= filter.minConfidence!);
    }

    if (filter.provenanceKinds?.length) {
      const allowed = new Set(filter.provenanceKinds);
      records = records.filter((record) => record.provenance.some((link) => allowed.has(link.kind)));
    }

    if (filter.staleOnly) {
      records = records.filter((record) => isReviewFlagged(record));
    }

    records = records.sort((a, b) => scoreRecord(b, filter) - scoreRecord(a, filter) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);

    if (filter.limit !== undefined) {
      records = records.slice(0, filter.limit);
    }

    return records;
  }

  searchSemantic(filter: MemorySearchFilter = {}): MemorySemanticSearchResult[] {
    if (!this.ready) return [];
    const query = filter.query?.trim();
    if (!query) {
      return this.search({ ...filter, semantic: false }).map((record) => ({
        record,
        distance: Number.POSITIVE_INFINITY,
        similarity: 0,
        score: scoreRecord(record, { ...filter, semantic: false }),
      }));
    }

    const requestedLimit = Math.max(1, filter.limit ?? 10);
    const vectorFilter = {
      ...filter,
      limit: Math.max(requestedLimit * 8, 50),
    };
    const candidates = this.vectorIndex?.search(query, vectorFilter) ?? [];
    if (candidates.length === 0) {
      return this.search({ ...filter, semantic: false }).map((record) => ({
        record,
        distance: Number.POSITIVE_INFINITY,
        similarity: 0,
        score: scoreRecord(record, { ...filter, semantic: false }),
      }));
    }

    const results: MemorySemanticSearchResult[] = [];
    for (const candidate of candidates) {
      const record = this.get(candidate.id);
      if (!record) continue;
      if (!recordMatchesPostSqlFilter(record, filter)) continue;
      const lexicalScore = scoreRecord(record, { ...filter, query: undefined, semantic: false });
      results.push({
        record,
        distance: candidate.distance,
        similarity: candidate.similarity,
        score: candidate.similarity * 100 + lexicalScore * 0.25,
      });
    }

    return results
      .sort((a, b) => b.score - a.score || a.distance - b.distance || b.record.updatedAt - a.record.updatedAt)
      .slice(0, requestedLimit);
  }

  reviewQueue(limit = 10): MemoryRecord[] {
    const records = this.search({ limit: Math.max(limit * 4, 25) });
    const candidates = records.filter((record) => isReviewCandidate(record));
    return candidates
      .sort((a, b) => reviewQueueScore(b) - reviewQueueScore(a) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  exportBundle(filter: MemorySearchFilter = {}): MemoryBundle {
    const records = this.search(filter);
    const recordIds = new Set(records.map((record) => record.id));
    const links: MemoryLink[] = [];
    for (const record of records) {
      for (const link of this.linksFor(record.id)) {
        if (!recordIds.has(link.fromId) || !recordIds.has(link.toId)) continue;
        const duplicate = links.some((existing) => (
          existing.fromId === link.fromId
          && existing.toId === link.toId
          && existing.relation === link.relation
        ));
        if (!duplicate) links.push(link);
      }
    }

    return {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: filter.scope ?? 'all',
      recordCount: records.length,
      linkCount: links.length,
      records,
      links,
    };
  }

  async importBundle(bundle: MemoryBundle): Promise<MemoryImportResult> {
    if (!this.ready) throw new Error('MemoryStore: not initialized');

    let importedRecords = 0;
    let skippedRecords = 0;
    let importedLinks = 0;

    for (const record of bundle.records) {
      if (this.get(record.id)) {
        skippedRecords++;
        continue;
      }
      this.sqlite.run(
        `INSERT INTO memory_records
           (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          normalizeScope(record.scope),
          record.cls,
          record.summary,
          record.detail ?? null,
          JSON.stringify(record.tags),
          JSON.stringify(record.provenance),
          normalizeReviewState(record.reviewState),
          clampConfidence(record.confidence),
          record.reviewedAt ?? null,
          record.reviewedBy ?? null,
          record.staleReason ?? null,
          record.createdAt,
          record.updatedAt,
        ],
      );
      importedRecords++;
      this.vectorIndex?.upsert(record);
    }

    for (const link of bundle.links) {
      if (!this.get(link.fromId) || !this.get(link.toId)) continue;
      this.sqlite.run(
        `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
        [link.fromId, link.toId, link.relation, link.createdAt],
      );
      importedLinks++;
    }

    logger.info('MemoryStore: bundle imported', { importedRecords, skippedRecords, importedLinks });
    this.persist();
    return { importedRecords, skippedRecords, importedLinks };
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

    this.persist();
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
  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    if (!this.ready) return null;

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: update target not found', { id });
      return null;
    }

    const now = Date.now();
    const newScope   = patch.scope   ?? existing.scope;
    const newSummary = patch.summary ?? existing.summary;
    const newDetail  = patch.detail  !== undefined ? patch.detail : existing.detail;
    const newTags    = patch.tags    ?? existing.tags;

    this.sqlite.run(
      `UPDATE memory_records
         SET scope = ?, summary = ?, detail = ?, tags = ?, updated_at = ?
         WHERE id = ?`,
      [newScope, newSummary, newDetail ?? null, JSON.stringify(newTags), now, id],
    );

    logger.info('MemoryStore: record updated', { id });
    const updated = { ...existing, scope: newScope, summary: newSummary, detail: newDetail, tags: newTags, updatedAt: now };
    this.vectorIndex?.upsert(updated);
    this.persist();
    return updated;
  }

  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    if (!this.ready) return null;

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: review target not found', { id });
      return null;
    }

    const now = Date.now();
    const reviewState = patch.state ?? existing.reviewState;
    const confidence = clampConfidence(patch.confidence ?? existing.confidence);
    const reviewedAt = now;
    const reviewedBy = patch.reviewedBy ?? existing.reviewedBy;
    const staleReason = reviewState === 'stale' || reviewState === 'contradicted'
      ? (patch.staleReason ?? existing.staleReason ?? 'marked by operator')
      : undefined;

    this.sqlite.run(
      `UPDATE memory_records
         SET review_state = ?, confidence = ?, reviewed_at = ?, reviewed_by = ?, stale_reason = ?, updated_at = ?
         WHERE id = ?`,
      [
        reviewState,
        confidence,
        reviewedAt,
        reviewedBy ?? null,
        staleReason ?? null,
        now,
        id,
      ],
    );

    logger.info('MemoryStore: record reviewed', { id, reviewState, confidence });
    const reviewed = { ...existing, reviewState, confidence, reviewedAt, reviewedBy, staleReason, updatedAt: now };
    this.vectorIndex?.upsert(reviewed);
    this.persist();
    return reviewed;
  }

  /** Delete a record and all its links. */
  delete(id: string): boolean {
    if (!this.ready) return false;

    const existing = this.get(id);
    if (!existing) return false;

    // Delete links explicitly as well as via FK cascade; sql.js may load older
    // stores with FK enforcement disabled for a connection.
    this.sqlite.run('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', [id, id]);
    this.sqlite.run('DELETE FROM memory_records WHERE id = ?', [id]);
    this.vectorIndex?.delete(id);
    logger.info('MemoryStore: record deleted', { id });
    this.persist();
    return true;
  }

  rebuildVectorIndex(): MemoryVectorStats {
    if (!this.ready) return this.vectorStats();
    const records = this.allRecords();
    this.vectorIndex?.sync(records);
    return this.vectorStats();
  }

  vectorStats(): MemoryVectorStats {
    return this.vectorIndex?.stats() ?? {
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: HASHED_MEMORY_EMBEDDING_PROVIDER.id,
      embeddingProviderLabel: HASHED_MEMORY_EMBEDDING_PROVIDER.label,
      error: 'memory vector index disabled',
    };
  }

  async doctor(): Promise<MemoryDoctorReport> {
    return {
      vector: this.vectorStats(),
      embeddings: await MemoryEmbeddingProviderRegistry.getActive().doctor(),
      checkedAt: Date.now(),
    };
  }

  async save(): Promise<boolean> {
    return this.sqlite.save();
  }

  close(): void {
    this.sqlite.close();
    this.vectorIndex?.close();
    this.ready = false;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private rowToRecord(columns: string[], values: unknown[]): MemoryRecord {
    const get = (col: string) => values[columns.indexOf(col)];

    const tagsRaw = get('tags');
    const provRaw  = get('provenance');

    return {
      id:         String(get('id')),
      scope:      normalizeScope(get('scope')),
      cls:        String(get('cls')) as MemoryClass,
      summary:    String(get('summary')),
      detail:     get('detail') != null ? String(get('detail')) : undefined,
      tags:       Array.isArray(tagsRaw) ? tagsRaw : safeParseJson<string[]>(String(tagsRaw), []),
      provenance: Array.isArray(provRaw) ? provRaw : safeParseJson<ProvenanceLink[]>(String(provRaw), []),
      reviewState: normalizeReviewState(get('review_state')),
      confidence: clampConfidence(Number(get('confidence') ?? 60)),
      reviewedAt: get('reviewed_at') != null ? Number(get('reviewed_at')) : undefined,
      reviewedBy: get('reviewed_by') != null ? String(get('reviewed_by')) : undefined,
      staleReason: get('stale_reason') != null ? String(get('stale_reason')) : undefined,
      createdAt:  Number(get('created_at')),
      updatedAt:  Number(get('updated_at')),
    };
  }

  private allRecords(): MemoryRecord[] {
    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at
         FROM memory_records
         ORDER BY updated_at DESC, created_at DESC`,
    );
    if (!rows.length) return [];
    return rows[0].values.map(v => this.rowToRecord(rows[0].columns, v));
  }

  private persist(): void {
    void this.save().catch((err) => {
      logger.debug('MemoryStore: autosave failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

function normalizeReviewState(value: unknown): MemoryReviewState {
  switch (String(value ?? 'fresh')) {
    case 'reviewed':
    case 'stale':
    case 'contradicted':
      return String(value) as MemoryReviewState;
    default:
      return 'fresh';
  }
}

function normalizeScope(value: unknown): MemoryScope {
  switch (String(value ?? 'project')) {
    case 'session':
    case 'team':
      return String(value) as MemoryScope;
    default:
      return 'project';
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isReviewFlagged(record: MemoryRecord): boolean {
  return record.reviewState === 'stale' || record.reviewState === 'contradicted' || record.confidence < 70 || !record.reviewedAt;
}

function isReviewCandidate(record: MemoryRecord): boolean {
  return record.reviewState !== 'reviewed' || record.confidence < 80 || !record.reviewedAt;
}

function reviewQueueScore(record: MemoryRecord): number {
  let score = 0;
  switch (record.reviewState) {
    case 'contradicted':
      score += 120;
      break;
    case 'stale':
      score += 100;
      break;
    case 'fresh':
      score += 60;
      break;
    case 'reviewed':
      score += 10;
      break;
  }
  if (!record.reviewedAt) score += 30;
  if (record.confidence < 80) score += 80 - record.confidence;
  const ageDays = Math.max(0, (Date.now() - record.updatedAt) / 86400000);
  score += Math.min(ageDays, 30);
  return score;
}

function scoreRecord(record: MemoryRecord, filter: MemorySearchFilter): number {
  let score = 0;
  const ageMinutes = Math.max(0, (Date.now() - record.updatedAt) / 60000);
  score += Math.max(0, 360 - ageMinutes) / 10;
  score += record.confidence / 5;

  switch (record.reviewState) {
    case 'reviewed':
      score += 30;
      break;
    case 'fresh':
      score += 10;
      break;
    case 'stale':
      score -= 40;
      break;
    case 'contradicted':
      score -= 60;
      break;
  }

  if (filter.query) {
    const q = filter.query.trim().toLowerCase();
    const haystack = [
      record.summary,
      record.detail ?? '',
      record.tags.join(' '),
      record.provenance.map((p) => `${p.kind}:${p.ref} ${p.label ?? ''}`).join(' '),
    ].join(' ').toLowerCase();
    for (const token of q.split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) {
        score += 12;
      }
    }
  }

  score += Math.min(record.provenance.length, 4) * 2;
  score += Math.min(record.tags.length, 4);
  return score;
}

function recordMatchesPostSqlFilter(record: MemoryRecord, filter: MemorySearchFilter): boolean {
  if (filter.scope && record.scope !== filter.scope) return false;
  if (filter.cls && record.cls !== filter.cls) return false;
  if (filter.since && record.createdAt < filter.since) return false;
  if (filter.reviewState) {
    const states = Array.isArray(filter.reviewState) ? filter.reviewState : [filter.reviewState];
    if (!states.includes(record.reviewState)) return false;
  }
  if (filter.minConfidence !== undefined && record.confidence < filter.minConfidence) return false;
  if (filter.tags?.length) {
    for (const tag of filter.tags) {
      if (!record.tags.includes(tag)) return false;
    }
  }
  if (filter.provenanceKinds?.length) {
    const allowed = new Set(filter.provenanceKinds);
    if (!record.provenance.some((link) => allowed.has(link.kind))) return false;
  }
  if (filter.staleOnly && !isReviewFlagged(record)) return false;
  return true;
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

export function _resetMemoryRegistryForTesting(): void {
  _registry = undefined;
  if (_store) {
    _store.close();
    _store = undefined;
  }
}
