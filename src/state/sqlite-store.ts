import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.ts';

interface SqlDatabase {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | Buffer) => SqlDatabase;
}

export class SQLiteStore {
  private db: SqlDatabase | null = null;
  private readonly dbPath: string | null;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? null;
  }

  get isReady(): boolean {
    return this.db !== null;
  }

  async init(schema: (db: SqlDatabase) => void): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize(schema);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    this.getDb().run(sql, params);
  }

  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> {
    return this.getDb().exec(sql, params);
  }

  async save(): Promise<boolean> {
    if (!this.dbPath || !this.db) return false;

    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
      logger.info('SQLiteStore: saved to disk', { path: this.dbPath });
      return true;
    } catch (err) {
      logger.error('SQLiteStore: failed to save', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private async initialize(schema: (db: SqlDatabase) => void): Promise<void> {
    try {
      // @ts-ignore — no bundled types for sql.js in this environment
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs() as SqlJsStatic;

      if (this.dbPath && existsSync(this.dbPath)) {
        this.db = new SQL.Database(readFileSync(this.dbPath));
        logger.info('SQLiteStore: loaded from disk', { path: this.dbPath });
      } else {
        this.db = new SQL.Database();
        logger.info('SQLiteStore: initialized in-memory');
      }

      schema(this.db);
    } catch (err) {
      this.db = null;
      logger.error('SQLiteStore: failed to initialize', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private getDb(): SqlDatabase {
    if (!this.db) {
      throw new Error('SQLiteStore: not initialized — call init() first');
    }
    return this.db;
  }
}
