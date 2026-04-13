import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.ts';
import { randomBytes } from 'crypto';
import { JsonFileStore } from './json-file-store.ts';

/**
 * Reserved keys that cannot be set by callers.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

export interface KVStateOptions {
  readonly sessionId?: string;
  readonly stateDir: string;
}

function resolveLegacyStateDir(storageRoot?: string): string {
  if (!storageRoot) {
    throw new Error('KVState requires an explicit stateDir or storageRoot');
  }
  return join(storageRoot, '.goodvibes', 'state');
}

function resolveKVStateOptions(
  sessionIdOrOptions?: string | KVStateOptions,
  storageRoot?: string,
): KVStateOptions {
  if (typeof sessionIdOrOptions === 'object' && sessionIdOrOptions !== null) {
    if (!sessionIdOrOptions.stateDir || sessionIdOrOptions.stateDir.trim().length === 0) {
      throw new Error('KVState requires a non-empty stateDir');
    }
    return sessionIdOrOptions;
  }

  return {
    sessionId: sessionIdOrOptions,
    stateDir: resolveLegacyStateDir(storageRoot),
  };
}

/**
 * KVState — Session-scoped persistent key-value store.
 *
 * Storage: <stateDir>/session_{id}.json
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
  private data: Record<string, unknown> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly store: JsonFileStore<Record<string, unknown>>;

  constructor(options: KVStateOptions);
  constructor(sessionId?: string, storageRoot?: string);
  constructor(sessionIdOrOptions?: string | KVStateOptions, storageRoot?: string) {
    const options = resolveKVStateOptions(sessionIdOrOptions, storageRoot);
    this.sessionId = options.sessionId ?? KVState.generateId();
    this.stateDir = options.stateDir;
    this.filePath = join(this.stateDir, `session_${this.sessionId}.json`);
    this.store = new JsonFileStore(this.filePath);
  }

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

  async load(): Promise<void> {
    const loaded = await this.store.load();
    if (loaded) {
      this.data = loaded;
      if (!this.data.id) this.data.id = this.sessionId;
      if (!this.data.started_at) this.data.started_at = new Date().toISOString();
      return;
    }

    this.data = {
      id: this.sessionId,
      started_at: new Date().toISOString(),
    };
  }

  async persist(): Promise<void> {
    if (this.data === null) return;
    await this.store.save(this.data);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  static listSessions(options: Pick<KVStateOptions, 'stateDir'>): string[];
  static listSessions(storageRoot?: string): string[];
  static listSessions(optionsOrStorageRoot?: string | Pick<KVStateOptions, 'stateDir'>): string[] {
    const stateDir = typeof optionsOrStorageRoot === 'object' && optionsOrStorageRoot !== null
      ? resolveKVStateOptions(optionsOrStorageRoot).stateDir
      : resolveLegacyStateDir(optionsOrStorageRoot);
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

  static cleanupOldSessions(keepCount: number, options: Pick<KVStateOptions, 'stateDir'>): void;
  static cleanupOldSessions(keepCount: number, storageRoot?: string): void;
  static cleanupOldSessions(keepCount: number, optionsOrStorageRoot?: string | Pick<KVStateOptions, 'stateDir'>): void {
    const stateDir = typeof optionsOrStorageRoot === 'object' && optionsOrStorageRoot !== null
      ? resolveKVStateOptions(optionsOrStorageRoot).stateDir
      : resolveLegacyStateDir(optionsOrStorageRoot);
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
        .sort((a, b) => b.mtime - a.mtime);

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

  async dispose(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data !== null) return;
    if (!this.loadPromise) {
      this.loadPromise = this.load().then(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
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
    const bytes = new Uint8Array(4);
    const rand = randomBytes(4);
    bytes.set(rand);

    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
