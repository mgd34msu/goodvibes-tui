import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJsStatic['Database']>;

export interface SqliteStoreOptions {
  workingDirectory: string;
  /** e.g. 'channel-routes.sqlite', 'drafts.sqlite', 'inbox-cursors.sqlite' */
  fileName: string;
  /** CREATE TABLE / INDEX statements run once on init (idempotent: IF NOT EXISTS). */
  schema: string[];
}

let sqlJsStaticPromise: Promise<SqlJsStatic> | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsStaticPromise) {
    sqlJsStaticPromise = initSqlJs();
  }
  return sqlJsStaticPromise;
}

/**
 * Daemon sqlite helper following the project MemoryStore lifecycle
 * (sql.js WASM: init → run/exec → save → close). One file per concern under
 * {workingDirectory}/.goodvibes/tui/operator/{fileName}.
 */
export class HandlerSqliteStore {
  private readonly options: SqliteStoreOptions;
  private readonly resolvedPath: string;
  private db: SqlDatabase | null = null;

  constructor(options: SqliteStoreOptions) {
    this.options = options;
    this.resolvedPath = join(
      options.workingDirectory,
      '.goodvibes',
      'tui',
      'operator',
      options.fileName,
    );
  }

  get dbPath(): string {
    return this.resolvedPath;
  }

  private requireDb(): SqlDatabase {
    if (!this.db) {
      throw new Error(`HandlerSqliteStore not initialized: ${this.resolvedPath}`);
    }
    return this.db;
  }

  async init(): Promise<void> {
    if (this.db) return;
    await mkdir(dirname(this.resolvedPath), { recursive: true });
    const SQL = await loadSqlJs();
    const existing = existsSync(this.resolvedPath) ? readFileSync(this.resolvedPath) : undefined;
    this.db = existing ? new SQL.Database(existing) : new SQL.Database();
    for (const statement of this.options.schema) {
      this.db.run(statement);
    }
  }

  /** Execute a write (INSERT/UPDATE/DELETE/CREATE). */
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    this.requireDb().run(sql, params);
  }

  /** SELECT → array of row objects (columns mapped to values). */
  all<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T[] {
    const result = this.requireDb().exec(sql, params);
    if (result.length === 0) return [];
    const { columns, values } = result[0]!;
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i += 1) {
        obj[columns[i]!] = row[i];
      }
      return obj as T;
    });
  }

  /** First row or null. */
  get<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): T | null {
    const rows = this.all<T>(sql, params);
    return rows.length > 0 ? rows[0]! : null;
  }

  /** Serialize and atomically persist to dbPath (tmp + rename). */
  async save(): Promise<void> {
    const db = this.requireDb();
    await mkdir(dirname(this.resolvedPath), { recursive: true });
    const data = db.export();
    const tmpPath = `${this.resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, this.resolvedPath);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** BEGIN/COMMIT around fn; ROLLBACK on throw (synchronous sql.js). */
  transaction(fn: () => void): void {
    const db = this.requireDb();
    db.run('BEGIN');
    try {
      fn();
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
}
