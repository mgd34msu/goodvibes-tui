import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { load as loadSqliteVec } from 'sqlite-vec';
import type { MemoryClass, MemoryRecord, MemoryReviewState, MemoryScope } from './memory-store.ts';
import {
  MemoryEmbeddingProviderRegistry,
  embedMemoryText,
  normalizeMemoryEmbeddingVector,
} from './memory-embeddings.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

// Keep this in sync with DEFAULT_MEMORY_EMBEDDING_DIMS in memory-embeddings.ts.
// Duplicating the literal here avoids an initialization cycle when state/index.ts
// re-exports both modules during targeted test imports.
export const MEMORY_VECTOR_DIMS = 384;
export { embedMemoryText } from './memory-embeddings.ts';

export interface MemoryVectorSearchFilter {
  scope?: MemoryScope;
  cls?: MemoryClass;
  since?: number;
  reviewState?: MemoryReviewState | MemoryReviewState[];
  minConfidence?: number;
  staleOnly?: boolean;
  limit?: number;
}

export interface MemoryVectorCandidate {
  id: string;
  distance: number;
  similarity: number;
}

export interface MemoryVectorStats {
  backend: 'sqlite-vec';
  enabled: boolean;
  available: boolean;
  path: string;
  dimensions: number;
  indexedRecords: number;
  embeddingProviderId: string;
  embeddingProviderLabel: string;
  error?: string;
}

type VectorRow = {
  rowid: number;
  record_id: string;
  distance: number;
};

type CountRow = {
  count: number;
};

type RecordIdRow = {
  rowid: number;
};

export function resolveMemoryVectorDbPath(dbPath?: string): string {
  if (!dbPath || dbPath === ':memory:') return ':memory:';
  if (dbPath.endsWith('.sqlite')) return dbPath.slice(0, -'.sqlite'.length) + '.vec.sqlite';
  if (dbPath.endsWith('.db')) return dbPath.slice(0, -'.db'.length) + '.vec.db';
  return `${dbPath}.vec.sqlite`;
}

export function memoryVectorSourceHash(record: MemoryRecord): string {
  const source = JSON.stringify({
    id: record.id,
    scope: record.scope,
    cls: record.cls,
    summary: record.summary,
    detail: record.detail ?? '',
    tags: record.tags,
    provenance: record.provenance,
    reviewState: record.reviewState,
    confidence: record.confidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return createHash('sha256').update(source).digest('hex');
}

export function buildMemoryEmbeddingText(record: MemoryRecord): string {
  return [
    record.cls,
    record.scope,
    record.summary,
    record.detail ?? '',
    record.tags.join(' '),
    record.provenance.map((entry) => `${entry.kind}:${entry.ref} ${entry.label ?? ''}`).join(' '),
  ].filter(Boolean).join('\n');
}

export class SqliteVecMemoryIndex {
  private db: Database | null = null;
  private enabled = false;
  private available = false;
  private error: string | undefined;
  private static readonly rebuildBatchSize = 25;

  constructor(
    private readonly dbPath: string,
    private readonly dimensions = MEMORY_VECTOR_DIMS,
    private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry,
  ) {}

  init(): void {
    if (this.db) return;
    try {
      if (this.dbPath !== ':memory:') {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      this.db = new Database(this.dbPath);
      loadSqliteVec(this.db);
      this.available = true;
      this.enabled = true;
      this.createSchema();
    } catch (err) {
      this.close();
      this.available = false;
      this.enabled = false;
      this.error = summarizeError(err);
      logger.warn('Memory vector index unavailable', { backend: 'sqlite-vec', error: this.error });
    }
  }

  stats(): MemoryVectorStats {
    const provider = this.embeddingRegistry.getDefaultProvider();
    return {
      backend: 'sqlite-vec',
      enabled: this.enabled,
      available: this.available,
      path: this.dbPath,
      dimensions: this.dimensions,
      indexedRecords: this.countIndexedRecords(),
      embeddingProviderId: provider.id,
      embeddingProviderLabel: provider.label,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  upsert(record: MemoryRecord): void {
    if (!this.db || !this.enabled) return;

    const sourceHash = memoryVectorSourceHash(record);
    const embedding = this.embedText(buildMemoryEmbeddingText(record), 'record', record.id);
    this.writeRecord(record, sourceHash, embedding);
  }

  async upsertAsync(record: MemoryRecord): Promise<void> {
    if (!this.db || !this.enabled) return;

    const sourceHash = memoryVectorSourceHash(record);
    const result = await this.embeddingRegistry.embedAsync({
      text: buildMemoryEmbeddingText(record),
      dimensions: this.dimensions,
      usage: 'record',
      recordId: record.id,
    });
    const embedding = normalizeMemoryEmbeddingVector(result.vector, this.dimensions);
    this.writeRecord(record, sourceHash, embedding);
  }

  delete(recordId: string): void {
    if (!this.db || !this.enabled) return;
    const row = this.db.query<RecordIdRow, [string]>(
      'SELECT rowid FROM memory_vector_ids WHERE record_id = ? LIMIT 1',
    ).get(recordId);
    if (!row) return;
    this.db.query('DELETE FROM memory_vectors WHERE rowid = ?').run(row.rowid);
    this.db.query('DELETE FROM memory_vector_ids WHERE rowid = ?').run(row.rowid);
  }

  sync(records: readonly MemoryRecord[]): void {
    if (!this.db || !this.enabled) return;

    const seen = new Set<string>();
    const tx = this.db.transaction((entries: readonly MemoryRecord[]) => {
      for (const record of entries) {
        seen.add(record.id);
        const row = this.db!.query<{ source_hash: string }, [string]>(
          'SELECT source_hash FROM memory_vector_ids WHERE record_id = ? LIMIT 1',
        ).get(record.id);
        const sourceHash = memoryVectorSourceHash(record);
        if (row?.source_hash === sourceHash) continue;
        this.upsert(record);
      }

      const staleRows = this.db!.query<{ record_id: string }, []>(
        'SELECT record_id FROM memory_vector_ids',
      ).all();
      for (const stale of staleRows) {
        if (!seen.has(stale.record_id)) this.delete(stale.record_id);
      }
    });
    tx(records);
  }

  async syncAsync(records: readonly MemoryRecord[], options: { force?: boolean } = {}): Promise<void> {
    if (!this.db || !this.enabled) return;

    const pending: Array<{ record: MemoryRecord; sourceHash: string; embedding: Float32Array }> = [];

    for (const record of records) {
      const row = this.db.query<{ source_hash: string }, [string]>(
        'SELECT source_hash FROM memory_vector_ids WHERE record_id = ? LIMIT 1',
      ).get(record.id);
      const sourceHash = memoryVectorSourceHash(record);
      if (!options.force && row?.source_hash === sourceHash) {
        continue;
      }

      const result = await this.embeddingRegistry.embedAsync({
        text: buildMemoryEmbeddingText(record),
        dimensions: this.dimensions,
        usage: 'record',
        recordId: record.id,
      });
      pending.push({
        record,
        sourceHash,
        embedding: normalizeMemoryEmbeddingVector(result.vector, this.dimensions),
      });

      if (pending.length >= SqliteVecMemoryIndex.rebuildBatchSize) {
        this.writePendingRebuildBatch(pending.splice(0, pending.length));
        await yieldToEventLoop();
      }
    }

    const staleRows = this.db.query<{ record_id: string }, []>(
      'SELECT record_id FROM memory_vector_ids',
    ).all();
    const staleIds = new Set(staleRows.map((row) => row.record_id));
    for (const record of records) {
      staleIds.delete(record.id);
    }

    if (pending.length > 0) {
      this.writePendingRebuildBatch(pending);
    }

    for (const recordId of staleIds) {
      this.delete(recordId);
    }
  }

  search(query: string, filter: MemoryVectorSearchFilter = {}): MemoryVectorCandidate[] {
    if (!this.db || !this.enabled) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const requestedLimit = normalizeLimit(filter.limit, 10);
    const vectorLimit = Math.max(requestedLimit, 1);
    const embedding = this.embedText(trimmed, 'query');
    const where: string[] = ['embedding MATCH ?', 'k = ?'];
    const params: SQLQueryBindings[] = [embedding, vectorLimit];

    if (filter.scope) {
      where.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.cls) {
      where.push('cls = ?');
      params.push(filter.cls);
    }
    if (filter.reviewState) {
      const states = Array.isArray(filter.reviewState) ? filter.reviewState : [filter.reviewState];
      if (states.length === 1) {
        where.push('review_state = ?');
        params.push(states[0]);
      }
    }
    if (filter.minConfidence !== undefined) {
      where.push('confidence >= ?');
      params.push(filter.minConfidence);
    }
    if (filter.staleOnly) {
      where.push("(review_state = 'stale' OR review_state = 'contradicted' OR confidence < 70)");
    } else {
      where.push("review_state != 'contradicted'");
    }

    const rows = this.db.query<VectorRow, SQLQueryBindings[]>(
      `SELECT rowid, record_id, distance
         FROM memory_vectors
        WHERE ${where.join(' AND ')}
        ORDER BY distance`,
    ).all(...params) as VectorRow[];

    return rows.map((row) => ({
      id: row.record_id,
      distance: Number(row.distance),
      similarity: distanceToSimilarity(Number(row.distance)),
    }));
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.enabled = false;
  }

  private createSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_vector_ids (
        rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id   TEXT NOT NULL UNIQUE,
        source_hash TEXT NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0,
        indexed_at  INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        embedding float[${this.dimensions}],
        scope text,
        cls text,
        review_state text,
        confidence integer,
        +record_id text,
        +source_hash text,
        +updated_at integer,
        +created_at integer
      )
    `);
  }

  private ensureRowId(recordId: string): number {
    if (!this.db) throw new Error('Memory vector index is not initialized');
    this.db.query(
      'INSERT OR IGNORE INTO memory_vector_ids (record_id) VALUES (?)',
    ).run(recordId);
    const row = this.db.query<RecordIdRow, [string]>(
      'SELECT rowid FROM memory_vector_ids WHERE record_id = ? LIMIT 1',
    ).get(recordId);
    if (!row) throw new Error(`Memory vector row id not found for ${recordId}`);
    return Number(row.rowid);
  }

  private countIndexedRecords(): number {
    if (!this.db || !this.enabled) return 0;
    const row = this.db.query<CountRow, []>(
      'SELECT count(*) AS count FROM memory_vector_ids',
    ).get();
    return Number(row?.count ?? 0);
  }

  private embedText(text: string, usage: 'record' | 'query', recordId?: string): Float32Array {
    const result = this.embeddingRegistry.embedSync({
      text,
      dimensions: this.dimensions,
      usage,
      recordId,
    });
    return normalizeMemoryEmbeddingVector(result.vector, this.dimensions);
  }

  private writePendingRebuildBatch(entries: Array<{ record: MemoryRecord; sourceHash: string; embedding: Float32Array }>): void {
    if (!this.db || !this.enabled || entries.length === 0) return;
    const tx = this.db.transaction((batch: Array<{ record: MemoryRecord; sourceHash: string; embedding: Float32Array }>) => {
      for (const entry of batch) {
        this.writeRecord(entry.record, entry.sourceHash, entry.embedding);
      }
    });
    tx(entries);
  }

  private writeRecord(record: MemoryRecord, sourceHash: string, embedding: Float32Array): void {
    if (!this.db) return;
    const rowid = this.ensureRowId(record.id);

    this.db.query('DELETE FROM memory_vectors WHERE rowid = ?').run(rowid);
    this.db.query(
      `INSERT INTO memory_vectors
         (rowid, embedding, scope, cls, review_state, confidence, record_id, source_hash, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowid,
      embedding,
      record.scope,
      record.cls,
      record.reviewState,
      record.confidence,
      record.id,
      sourceHash,
      record.updatedAt,
      record.createdAt,
    );
    this.db.query(
      `UPDATE memory_vector_ids
         SET source_hash = ?, updated_at = ?, indexed_at = ?
       WHERE rowid = ?`,
    ).run(sourceHash, record.updatedAt, Date.now(), rowid);
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.round(value!)));
}

function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - (distance / 2)));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
