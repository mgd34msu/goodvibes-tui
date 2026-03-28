import { SQLiteStore } from './sqlite-store.ts';

export interface ToolCallRecord {
  id: number;
  tool: string;
  args: string;
  result: string;
  status: 'ok' | 'error';
  duration_ms: number;
  tokens: number;
  timestamp: number;
}

export interface TelemetryFilter {
  tool?: string;
  status?: 'ok' | 'error';
  since?: number;
  until?: number;
  limit?: number;
}

export interface TelemetrySummary {
  total_calls: number;
  total_tokens: number;
  total_errors: number;
  total_duration_ms: number;
  by_tool: Record<string, { calls: number; tokens: number; errors: number; avg_duration_ms: number }>;
}

export class TelemetryDB {
  private readonly store: SQLiteStore;

  constructor(dbPath?: string) {
    this.store = new SQLiteStore(dbPath);
  }

  async init(): Promise<void> {
    await this.store.init((db) => {
      db.run(`
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
      db.run(`CREATE INDEX IF NOT EXISTS idx_tool ON tool_calls(tool)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON tool_calls(timestamp)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_status ON tool_calls(status)`);
    });
  }

  recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    duration: number,
    tokens: number,
  ): void {
    const status = (result.success === false || result.error !== undefined) ? 'error' : 'ok';
    this.store.run(
      `INSERT INTO tool_calls (tool, args, result, status, duration_ms, tokens, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

  query(filter: TelemetryFilter = {}): ToolCallRecord[] {
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

    const result = this.store.exec(sql, params);
    if (!result.length) return [];

    const { columns, values } = result[0] as { columns: string[]; values: unknown[][] };
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      // Safe cast: the SQL schema defines exactly the columns that
      // ToolCallRecord expects, so the shape is guaranteed at the DB level.
      return obj as unknown as ToolCallRecord;
    });
  }

  getSummary(): TelemetrySummary {
    const totalResult = this.store.exec(
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

    const byToolResult = this.store.exec(
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

  export(format: 'json' | 'csv' = 'json'): string {
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

  async save(): Promise<boolean> {
    return this.store.save();
  }

  close(): void {
    this.store.close();
  }

  get isReady(): boolean {
    return this.store.isReady;
  }
}
