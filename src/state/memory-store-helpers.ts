import type { MemoryDoctorReport, MemoryLink, MemoryRecord, MemoryReviewState, MemoryScope, MemorySearchFilter } from '@pellux/goodvibes-sdk/platform/state/memory-store';

export function createSchema(db: { run(sql: string): void; exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> }): void {
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

  ensureColumn(db, 'memory_records', 'scope TEXT NOT NULL DEFAULT \'project\'', 'scope');
  ensureColumn(db, 'memory_records', 'review_state TEXT NOT NULL DEFAULT \'fresh\'', 'review_state');
  ensureColumn(db, 'memory_records', 'confidence INTEGER NOT NULL DEFAULT 60', 'confidence');
  ensureColumn(db, 'memory_records', 'reviewed_at INTEGER', 'reviewed_at');
  ensureColumn(db, 'memory_records', 'reviewed_by TEXT', 'reviewed_by');
  ensureColumn(db, 'memory_records', 'stale_reason TEXT', 'stale_reason');

  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_cls ON memory_records(cls)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_records(created_at)`);
}

export function ensureColumn(
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

export function rowToRecord(columns: string[], values: unknown[]): MemoryRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]])) as Record<string, unknown>;
  return {
    id: String(row.id),
    scope: normalizeScope(row.scope),
    cls: String(row.cls) as MemoryRecord['cls'],
    summary: String(row.summary),
    ...(typeof row.detail === 'string' && row.detail.trim() ? { detail: row.detail.trim() } : {}),
    tags: safeParseJson<string[]>(row.tags, []),
    provenance: safeParseJson<Array<MemoryRecord['provenance'][number]>>(row.provenance, []),
    reviewState: normalizeReviewState(row.review_state),
    confidence: clampConfidence(row.confidence),
    ...(typeof row.reviewed_at === 'number' ? { reviewedAt: Number(row.reviewed_at) } : {}),
    ...(typeof row.reviewed_by === 'string' && row.reviewed_by.trim() ? { reviewedBy: row.reviewed_by.trim() } : {}),
    ...(typeof row.stale_reason === 'string' && row.stale_reason.trim() ? { staleReason: row.stale_reason.trim() } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function normalizeReviewState(value: unknown): MemoryReviewState {
  return value === 'reviewed' || value === 'stale' || value === 'contradicted' ? value : 'fresh';
}

export function normalizeScope(value: unknown): MemoryScope {
  return value === 'session' || value === 'team' ? value : 'project';
}

export function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 60;
}

export function isReviewFlagged(record: MemoryRecord): boolean {
  return record.reviewState === 'stale' || record.reviewState === 'contradicted';
}

export function isReviewCandidate(record: MemoryRecord): boolean {
  return record.reviewState === 'fresh'
    || record.reviewState === 'reviewed'
    || record.reviewState === 'stale'
    || record.reviewState === 'contradicted';
}

export function reviewQueueScore(record: MemoryRecord): number {
  let score = 0;
  if (record.reviewState === 'fresh') score += 40;
  if (record.reviewState === 'stale') score += 20;
  if (record.reviewState === 'contradicted') score += 10;
  score += Math.max(0, 100 - record.confidence);
  score += Math.min(20, record.tags.length * 3);
  score += Math.min(20, record.provenance.length * 4);
  return score;
}

export function scoreRecord(record: MemoryRecord, filter: MemorySearchFilter): number {
  let score = record.confidence;
  if (filter.query) {
    const query = filter.query.toLowerCase();
    if (record.summary.toLowerCase().includes(query)) score += 30;
    if (record.detail?.toLowerCase().includes(query)) score += 20;
  }
  if (filter.semantic) score += 15;
  if (filter.tags?.length) score += Math.min(25, filter.tags.length * 5);
  if (isReviewFlagged(record)) score -= 20;
  return score;
}

export function recordMatchesPostSqlFilter(record: MemoryRecord, filter: MemorySearchFilter): boolean {
  if (filter.provenanceKinds?.length) {
    if (!record.provenance.some((entry) => filter.provenanceKinds!.includes(entry.kind))) return false;
  }
  if (filter.reviewState) {
    const states = Array.isArray(filter.reviewState) ? filter.reviewState : [filter.reviewState];
    if (!states.includes(record.reviewState)) return false;
  }
  if (filter.staleOnly && !isReviewFlagged(record)) return false;
  return true;
}

export function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function memoryLink(fromId: string, toId: string, relation: string, createdAt: number): MemoryLink {
  return { fromId, toId, relation, createdAt };
}

export function memoryDoctorReport(vector: MemoryDoctorReport['vector'], embeddings: MemoryDoctorReport['embeddings'], checkedAt: number): MemoryDoctorReport {
  return { vector, embeddings, checkedAt };
}
