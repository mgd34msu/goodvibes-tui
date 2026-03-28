import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  id: number;
  tool: string;
  args: string;      // JSON
  result: string;    // JSON
  status: 'ok' | 'error';
  duration_ms: number;
  tokens: number;
  timestamp: number; // ms epoch
}

export interface TelemetryFilter {
  tool?: string;
  status?: 'ok' | 'error';
  since?: number; // ms epoch
  until?: number; // ms epoch
  limit?: number;
}

export interface TelemetrySummary {
  total_calls: number;
  total_tokens: number;
  total_errors: number;
  total_duration_ms: number;
  by_tool: Record<string, { calls: number; tokens: number; errors: number; avg_duration_ms: number }>;
}

// ---------------------------------------------------------------------------
// sql.js minimal interface (avoids `any` while keeping WASM dynamic import)
// ---------------------------------------------------------------------------

interface SqlDatabase {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

// ---------------------------------------------------------------------------
// TelemetryDB
// ---------------------------------------------------------------------------

/**
 * TelemetryDB — in-memory (or file-backed) SQLite telemetry store via sql.js.
 *
 * Records tool calls with duration and token usage.
 * Supports filtered queries, summary aggregation, and JSON/CSV export.
 */
export class TelemetryDB {
  private db: SqlDatabase | null = null;
  private dbPath: string | null = null;
  private ready = false;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
    }
  }

  /**
   * Initialize the WASM SQLite database. Must be called before any other method.
   */
  async init(): Promise<void> {
    if (this.ready) return;
    try {
      // Dynamic import to avoid top-level WASM load overhead
      // @ts-ignore — sql.js ships no bundled type declarations
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      if (this.dbPath && existsSync(this.dbPath)) {
        // Load existing DB from disk
        const { readFileSync } = await import('node:fs');
        const data = readFileSync(this.dbPath);
        this.db = new SQL.Database(data);
        logger.info('TelemetryDB: loaded from disk', { path: this.dbPath });
      } else {
        this.db = new SQL.Database();
        logger.info('TelemetryDB: initialized in-memory');
      }
      this.createSchema();
      this.ready = true;
    } catch (err) {
      logger.error('TelemetryDB: failed to initialize', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private createSchema(): void {
    this._db.run(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tool        TEXT    NOT NULL,
        args        TEXT    NOT NULL DEFAULT '{}',
        result      TEXT    NOT NULL DEFAULT '{}',
        status      TEXT    NOT NULL DEFAULT 'ok',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tokens      INTEGER NOT NULL DEFAULT 0,
        timestamp   INTEGER NOT NULL
      )
    `);
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_tool ON tool_calls(tool)`);
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON tool_calls(timestamp)`);
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_status ON tool_calls(status)`);
  }

  /**
   * Record a tool call.
   */
  recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    duration: number,
    tokens: number,
  ): void {
    this.assertReady();
    const status = (result.success === false || result.error !== undefined) ? 'error' : 'ok';
    this._db.run(
      `INSERT INTO tool_calls (tool, args, result, status, duration_ms, tokens, timestamp)\n        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        tool,
        JSON.stringify(args),
        JSON.stringify(result),
        status,
        Math.round(duration),
        Math.max(0, Math.round(tokens)),
        Date.now(),
      ],
    );
  }

  /**
   * Query tool call records with optional filters.
   */
  query(filter: TelemetryFilter = {}): ToolCallRecord[] {
    this.assertReady();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.tool) {
      conditions.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.since !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit !== undefined ? `LIMIT ${filter.limit}` : '';
    const sql = `SELECT * FROM tool_calls ${where} ORDER BY timestamp DESC ${limit}`;

    const result = this._db.exec(sql, params);
    if (!result.length) return [];

    const { columns, values } = result[0] as { columns: string[]; values: unknown[][] };
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      // Safe cast: the SQL schema defines exactly the columns that
      // ToolCallRecord expects, so the shape is guaranteed at the DB level.
      return obj as unknown as ToolCallRecord;
    });
  }

  /**
   * Get a summary of all tool call activity.
   */
  getSummary(): TelemetrySummary {
    this.assertReady();

    const totalResult = this._db.exec(
      `SELECT COUNT(*) as total_calls,
               COALESCE(SUM(tokens), 0) as total_tokens,
               COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END), 0) as total_errors,
               COALESCE(SUM(duration_ms), 0) as total_duration_ms
        FROM tool_calls`,
    );

    let total_calls = 0, total_tokens = 0, total_errors = 0, total_duration_ms = 0;
    if (totalResult.length > 0) {
      const row = totalResult[0].values[0] as number[];
      total_calls = row[0] ?? 0;
      total_tokens = row[1] ?? 0;
      total_errors = row[2] ?? 0;
      total_duration_ms = row[3] ?? 0;
    }

    const byToolResult = this._db.exec(
      `SELECT tool,
               COUNT(*) as calls,
               COALESCE(SUM(tokens), 0) as tokens,
               COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END), 0) as errors,
               COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM tool_calls
        GROUP BY tool
        ORDER BY calls DESC`,
    );

    const by_tool: TelemetrySummary['by_tool'] = {};
    if (byToolResult.length > 0) {
      for (const row of byToolResult[0].values as unknown[][]) {
        const [tool, calls, tokens, errors, avg_duration_ms] = row as [string, number, number, number, number];
        by_tool[tool] = { calls, tokens, errors, avg_duration_ms: Math.round(avg_duration_ms) };
      }
    }

    return { total_calls, total_tokens, total_errors, total_duration_ms, by_tool };
  }

  /**
   * Export all records as JSON or CSV.
   */
  export(format: 'json' | 'csv' = 'json'): string {
    this.assertReady();
    const records = this.query({});

    if (format === 'csv') {
      const header = 'id,tool,status,duration_ms,tokens,timestamp';
      const rows = records.map((r) =>
        `${r.id},${JSON.stringify(r.tool)},${r.status},${r.duration_ms},${r.tokens},${r.timestamp}`,
      );
      return [header, ...rows].join('\n');
    }

    return JSON.stringify(records, null, 2);
  }

  /**
   * Persist the database to disk (if a path was provided at construction).
   * Returns true if saved, false if in-memory-only.
   */
  async save(): Promise<boolean> {
    this.assertReady();
    if (!this.dbPath) return false;

    try {
      const dir = join(this.dbPath, '..');
      mkdirSync(dir, { recursive: true });
      const data: Uint8Array = this._db.export();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(this.dbPath, Buffer.from(data));
      logger.info('TelemetryDB: saved to disk', { path: this.dbPath });
      return true;
    } catch (err) {
      logger.error('TelemetryDB: failed to save', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Close the database, freeing WASM memory.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.ready = false;
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  private assertReady(): void {
    if (!this.ready || this.db === null) {
      throw new Error('TelemetryDB: not initialized — call init() first');
    }
  }

  /** Type-safe accessor: call only from methods guarded by assertReady(). */
  private get _db(): SqlDatabase {
    return this.db!;
  }
}
