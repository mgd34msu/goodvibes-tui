import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
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

/**
 * The 16 bytes every SQLite file begins with ("SQLite format 3" + NUL). A file
 * that does not start with these is not a database, whatever its extension —
 * which is exactly what a crash mid-create, a zero-fill, or a partially
 * restored backup leaves behind.
 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * How long a quarantined `.corrupt-<timestamp>` database is kept before it is
 * reclaimed. These files exist so an operator can try to salvage a damaged
 * store by hand; 14 days is long enough for someone to notice a broken daemon
 * and come looking, and short enough that a store that goes bad repeatedly
 * cannot fill the disk with copies of itself. Reaped on the next init.
 */
const CORRUPT_QUARANTINE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** At most this many quarantined copies of one store are kept, newest first. */
const MAX_CORRUPT_QUARANTINES = 3;

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

  /**
   * Move a database file that cannot be opened aside instead of deleting it, so
   * an operator still has something to salvage, and return the quarantine path.
   * Returns null when the move itself failed — in which case the caller starts
   * fresh in memory and the bad file is left exactly where it was rather than
   * being overwritten on the next save.
   */
  private quarantineUnreadable(): string | null {
    const target = `${this.resolvedPath}.corrupt-${Date.now()}`;
    try {
      renameSync(this.resolvedPath, target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * Bound the quarantine directory: drop `.corrupt-*` copies of THIS store that
   * are past the TTL or beyond the keep-newest count. Best-effort and
   * idempotent — a file another process already removed is success, not an
   * error — so two daemons opening the same store at once cannot fight.
   * Returns how many were reclaimed.
   */
  private reapCorruptQuarantines(nowMs: number): number {
    const dir = dirname(this.resolvedPath);
    const prefix = `${basename(this.resolvedPath)}.corrupt-`;
    let candidates: Array<{ path: string; mtimeMs: number }>;
    try {
      candidates = readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => join(dir, name))
        .flatMap((path) => {
          try {
            return [{ path, mtimeMs: statSync(path).mtimeMs }];
          } catch {
            return [];
          }
        });
    } catch {
      return 0;
    }
    if (candidates.length === 0) return 0;
    // Newest first: the newest MAX_CORRUPT_QUARANTINES survive the count cap,
    // and everything past the TTL goes regardless of rank.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let reclaimed = 0;
    for (const [index, candidate] of candidates.entries()) {
      const tooOld = nowMs - candidate.mtimeMs > CORRUPT_QUARANTINE_TTL_MS;
      const overCap = index >= MAX_CORRUPT_QUARANTINES;
      if (!tooOld && !overCap) continue;
      try {
        rmSync(candidate.path, { force: true });
        reclaimed += 1;
      } catch {
        // Another process may have taken it first; that is the outcome we wanted.
      }
    }
    return reclaimed;
  }

  async init(): Promise<void> {
    if (this.db) return;
    await mkdir(dirname(this.resolvedPath), { recursive: true });
    const SQL = await loadSqlJs();

    // Validate the file by its CONTENT, not by existsSync. `save()` writes
    // through a pid-and-timestamp temp file and an atomic rename, so it cannot
    // itself leave a half-written database — but a zero-filled file recovered
    // by a filesystem, a truncated restore, or a copy interrupted by something
    // outside this process all produce a path that exists and holds no usable
    // database. Handing those bytes to `new SQL.Database(...)` throws out of
    // init and takes the whole daemon store down with no way back.
    let existing: Buffer | undefined;
    let quarantined: string | null = null;
    let quarantineReason = '';
    if (existsSync(this.resolvedPath)) {
      let raw: Buffer | null = null;
      try {
        raw = readFileSync(this.resolvedPath);
      } catch {
        raw = null;
      }
      if (!raw || raw.length === 0) {
        quarantineReason = raw ? 'zero-byte file (interrupted write)' : 'unreadable file';
        quarantined = this.quarantineUnreadable();
      } else if (raw.length < SQLITE_HEADER.length || !raw.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
        quarantineReason = 'missing the SQLite file header (not a database)';
        quarantined = this.quarantineUnreadable();
      } else {
        existing = raw;
      }
    }

    if (existing) {
      // The constructor is NOT where a damaged image surfaces: sql.js accepts
      // the bytes and only reports "database disk image is malformed" when the
      // first statement touches a bad page. So the open is not proved until the
      // schema has actually run against it, and both steps share one catch.
      try {
        const candidate = new SQL.Database(existing);
        try {
          for (const statement of this.options.schema) candidate.run(statement);
          this.db = candidate;
        } catch (error) {
          candidate.close();
          throw error;
        }
      } catch (error) {
        // Header present but the body does not hold up: a truncated or damaged
        // database. Same treatment — set aside, disclose, start clean.
        quarantineReason = `database would not open: ${error instanceof Error ? error.message : String(error)}`;
        this.db = null;
        quarantined = this.quarantineUnreadable();
      }
    }

    if (!this.db) {
      this.db = new SQL.Database();
      for (const statement of this.options.schema) this.db.run(statement);
    }

    // Disclosure: starting a store from scratch is data loss from the user's
    // point of view, so it is never allowed to happen quietly.
    if (quarantineReason) {
      logger.warn('daemon store could not be opened — starting a fresh one', {
        store: this.options.fileName,
        path: this.resolvedPath,
        reason: quarantineReason,
        quarantinedTo: quarantined ?? '(could not be moved aside; left in place)',
      });
    }

    const reclaimed = this.reapCorruptQuarantines(Date.now());
    if (reclaimed > 0) {
      logger.info('daemon store reclaimed quarantined copies', {
        store: this.options.fileName,
        reclaimedFiles: reclaimed,
        ttlDays: Math.round(CORRUPT_QUARANTINE_TTL_MS / (24 * 60 * 60 * 1000)),
        keptNewest: MAX_CORRUPT_QUARANTINES,
      });
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
