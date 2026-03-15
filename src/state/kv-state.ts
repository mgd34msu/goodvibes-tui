import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.ts';

/**
 * Reserved keys that cannot be set by callers.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

/**
 * KVState — Session-scoped persistent key-value store.
 *
 * Storage: <cwd>/.goodvibes/state/session_{id}.json
 * Session ID: 8-char hex string, auto-generated if not provided.
 *
 * Features:
 * - Lazy load: defers disk read until first operation.
 * - Atomic persistence: write to temp file then rename.
 * - Debounced auto-persist: 5-second timer after each set().
 */
export class KVState {
  private sessionId: string;
  private stateDir: string;
  private filePath: string;
  private data: Record<string, unknown> | null = null; // null = not yet loaded
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(sessionId?: string, baseDir?: string) {
    this.sessionId = sessionId ?? KVState.generateId();
    const root = baseDir ?? process.cwd();
    this.stateDir = join(root, '.goodvibes', 'state');
    this.filePath = join(this.stateDir, `session_${this.sessionId}.json`);
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /**
   * Get values for the given keys.
   * Returns a record of key -> value; missing keys are omitted.
   */
  async get(keys: string[]): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(this.data!, key)) {
        result[key] = this.data![key];
      }
    }
    return result;
  }

  /**
   * Set multiple key-value pairs.
   * Silently ignores reserved keys.
   * Triggers debounced auto-persist.
   */
  async set(values: Record<string, unknown>): Promise<void> {
    await this.ensureLoaded();
    for (const [key, value] of Object.entries(values)) {
      if (RESERVED_KEYS.has(key)) {
        logger.debug('KVState: ignoring reserved key', { key });
        continue;
      }
      this.data![key] = value;
    }
    this.schedulePersist();
  }

  /**
   * List all key-value pairs, optionally filtered by prefix.
   */
  async list(prefix?: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!prefix) {
      return { ...this.data! };
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.data!)) {
      if (key.startsWith(prefix)) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Remove the given keys from the store.
   * Reserved keys are silently skipped.
   * Triggers debounced auto-persist.
   */
  async clear(keys: string[]): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const key of keys) {
      if (RESERVED_KEYS.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(this.data!, key)) {
        delete this.data![key];
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Explicitly load state from disk.
   * Called automatically on first operation (lazy load).
   */
  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.data = {
        id: this.sessionId,
        started_at: new Date().toISOString(),
      };
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.data = parsed;
      // Ensure reserved keys are present
      if (!this.data.id) this.data.id = this.sessionId;
      if (!this.data.started_at) this.data.started_at = new Date().toISOString();
    } catch (err) {
      logger.debug('KVState: failed to load from disk, starting fresh', { error: String(err) });
      this.data = {
        id: this.sessionId,
        started_at: new Date().toISOString(),
      };
    }
  }

  /**
   * Atomically persist current state to disk.
   * Writes to a temp file then renames to the final path.
   */
  async persist(): Promise<void> {
    if (this.data === null) return; // Nothing loaded, nothing to persist
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const content = JSON.stringify(this.data, null, 2) + '\n';
      // Use sync write + rename for atomicity
      writeFileSync(tmpPath, content, 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.debug('KVState: persist failed (non-fatal)', { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * List all session IDs found in the state directory.
   */
  static listSessions(baseDir?: string): string[] {
    const stateDir = join(baseDir ?? process.cwd(), '.goodvibes', 'state');
    if (!existsSync(stateDir)) return [];
    try {
      return readdirSync(stateDir)
        .filter(f => /^session_[0-9a-f]{8}\.json$/.test(f))
        .map(f => f.replace(/^session_/, '').replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Delete old session files, keeping only the most recent `keepCount`.
   * Sessions are ordered by filename (which encodes creation order via random ID).
   * Uses mtime for ordering when available.
   */
  static cleanupOldSessions(keepCount: number, baseDir?: string): void {
    const stateDir = join(baseDir ?? process.cwd(), '.goodvibes', 'state');
    if (!existsSync(stateDir)) return;
    try {
      const files = readdirSync(stateDir)
        .filter(f => /^session_[0-9a-f]{8}\.json$/.test(f))
        .map(f => ({
          name: f,
          path: join(stateDir, f),
          mtime: (() => {
            try {
              return statSync(join(stateDir, f)).mtimeMs;
            } catch {
              return 0;
            }
          })(),
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      const toDelete = files.slice(keepCount);
      for (const f of toDelete) {
        try {
          unlinkSync(f.path);
          logger.debug('KVState: cleaned up old session', { file: f.name });
        } catch (err) {
          logger.debug('KVState: could not delete session file', { file: f.name, error: String(err) });
        }
      }
    } catch (err) {
      logger.debug('KVState: cleanupOldSessions failed (non-fatal)', { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private ensureLoaded(): Promise<void> {
    if (this.data !== null) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.load().then(() => { this.loadPromise = null; });
    }
    return this.loadPromise;
  }

  async dispose(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch(err => {
        logger.debug('KVState: scheduled persist failed', { error: String(err) });
      });
    }, 5000);
  }

  private static generateId(): string {
    // Generate 4 random bytes -> 8-char hex
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
