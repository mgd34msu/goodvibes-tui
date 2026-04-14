import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.ts';
import { summarizeError } from '../../utils/error-display.ts';

// ─── Constants ─────────────────────────────────────────────────────────────

export const DEFAULT_MAX_CHARS = 50_000;
const OVERFLOW_DIR = '.goodvibes/.overflow';

// ─── Retention Policy ───────────────────────────────────────────────────────

/**
 * RetentionPolicyConfig — limits enforced during cleanup for a spill backend.
 *
 * All three limits are applied independently; whichever is most restrictive
 * wins. Prune candidates are deleted oldest-first.
 */
export interface RetentionPolicyConfig {
  /** Maximum age of a spill entry in milliseconds. Default: 1 hour. */
  maxAgeMs?: number;
  /** Maximum number of retained entries. Default: unlimited. */
  maxCount?: number;
  /** Maximum total size of retained entries in bytes. Default: unlimited. */
  maxSizeBytes?: number;
}

const DEFAULT_RETENTION: Required<RetentionPolicyConfig> = {
  maxAgeMs: 60 * 60 * 1000, // 1 hour
  maxCount: Infinity,
  maxSizeBytes: Infinity,
};

// ─── Spill Backend Interface ─────────────────────────────────────────────────

/**
 * SpillEntry — a single overflow/spill record as seen by the backend.
 */
export interface SpillEntry {
  /** Stable identifier for this entry (used in refs and cleanup). */
  id: string;
  /** Display-friendly filename or key. */
  filename: string;
  /** Content written to the backend. */
  content: string;
  /** Entry size in bytes (UTF-8 encoded). */
  sizeBytes: number;
  /** Unix timestamp (ms) when the entry was written. */
  createdAt: number;
  /** Backend type that owns this entry. */
  backendType: SpillBackendType;
}

/** Discriminated union of supported backend types. */
export type SpillBackendType = 'file' | 'ledger' | 'diagnostics';

/**
 * SpillBackend — pluggable interface for persisting overflow content.
 *
 * Implementations must be synchronous so they can be called from
 * `OverflowHandler.handle()` without async overhead in the hot path.
 */
export interface SpillBackend {
  /** Backend type discriminant used in overflow references. */
  readonly type: SpillBackendType;
  write(filename: string, content: string): SpillEntry | null;
  read(id: string): string | null;
  cleanup(policy?: RetentionPolicyConfig): void;
  list(): SpillEntry[];
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OverflowResult {
  content: string;
  /** Typed ref: `file:path`, `ledger:key`, or `diagnostics:key`. */
  overflowRef?: string;
  /** Backend type that stored the overflow content. */
  spillBackend?: SpillBackendType;
}

export interface OverflowOptions {
  maxChars?: number;
  label?: string;
}

// ─── File Backend ────────────────────────────────────────────────────────────

/**
 * FileBackend — spills overflow content to `.goodvibes/.overflow/` on disk.
 */
export class FileBackend implements SpillBackend {
  readonly type: SpillBackendType = 'file';
  private readonly overflowDir: string;

  constructor(baseDir: string) {
    this.overflowDir = join(baseDir, OVERFLOW_DIR);
  }

  private ensureDir(): boolean {
    try {
      mkdirSync(this.overflowDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private _safePath(id: string): string | null {
    if (id.includes('/') || id.includes('\\') || id.includes('\0') || id.includes('..')) return null;
    const resolved = join(this.overflowDir, id);
    // Prevent path traversal — id must not escape overflowDir
    return resolved.startsWith(this.overflowDir + '/') ? resolved : null;
  }

  write(filename: string, content: string): SpillEntry | null {
    try {
      if (!this.ensureDir()) return null;
      const target = this._safePath(filename);
      if (!target) return null;
      writeFileSync(target, content, 'utf-8');
      return {
        id: filename,
        filename,
        content,
        sizeBytes: new TextEncoder().encode(content).length,
        createdAt: Date.now(),
        backendType: 'file',
      };
    } catch {
      return null;
    }
  }

  read(id: string): string | null {
    const target = this._safePath(id);
    if (!target) return null;
    try { return readFileSync(target, 'utf-8'); } catch { return null; }
  }

  cleanup(policy?: RetentionPolicyConfig): void {
    const cfg = { ...DEFAULT_RETENTION, ...policy };
    const now = Date.now();
    let files: string[];
    try { files = readdirSync(this.overflowDir); } catch { return; }

    interface FE { file: string; path: string; mtimeMs: number; size: number; }
    const entries: FE[] = [];
    for (const file of files) {
      const p = join(this.overflowDir, file);
      try { const s = statSync(p); entries.push({ file, path: p, mtimeMs: s.mtimeMs, size: s.size }); } catch { }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    const toDelete = new Set<string>();
    for (const e of entries) { if (now - e.mtimeMs >= cfg.maxAgeMs) toDelete.add(e.path); }
    const rem = entries.filter((e) => !toDelete.has(e.path));
    if (cfg.maxCount !== Infinity && rem.length > cfg.maxCount) {
      const excess = rem.length - cfg.maxCount;
      for (let i = 0; i < excess; i++) toDelete.add(rem[i]!.path);
    }
    const ac = entries.filter((e) => !toDelete.has(e.path));
    if (cfg.maxSizeBytes !== Infinity) {
      let total = ac.reduce((s, e) => s + e.size, 0);
      for (const e of ac) { if (total <= cfg.maxSizeBytes) break; toDelete.add(e.path); total -= e.size; }
    }
    for (const p of toDelete) { try { unlinkSync(p); } catch { } }
  }

  /** Lists all overflow entries. Reads file content eagerly — acceptable for small overflow directories. */
  list(): SpillEntry[] {
    let files: string[];
    try { files = readdirSync(this.overflowDir); } catch { return []; }
    const result: SpillEntry[] = [];
    for (const file of files) {
      const p = join(this.overflowDir, file);
      try {
        const s = statSync(p);
        let content = '';
        try { content = readFileSync(p, 'utf-8'); } catch { }
        result.push({ id: file, filename: file, content, sizeBytes: s.size, createdAt: s.mtimeMs, backendType: 'file' });
      } catch { }
    }
    return result;
  }
}

// ─── Ledger Backend ──────────────────────────────────────────────────────────

/**
 * LedgerBackend — stores overflow entries in-process (Map).
 * Ephemeral: entries are lost on process exit.
 */
export class LedgerBackend implements SpillBackend {
  readonly type: SpillBackendType = 'ledger';
  private readonly entries: Map<string, SpillEntry> = new Map();

  write(filename: string, content: string): SpillEntry | null {
    const entry: SpillEntry = {
      id: filename, filename, content,
      sizeBytes: new TextEncoder().encode(content).length,
      createdAt: Date.now(),
      backendType: 'ledger',
    };
    this.entries.set(filename, entry);
    return entry;
  }

  read(id: string): string | null { return this.entries.get(id)?.content ?? null; }

  cleanup(policy?: RetentionPolicyConfig): void {
    const cfg = { ...DEFAULT_RETENTION, ...policy };
    const now = Date.now();
    const sorted = Array.from(this.entries.values()).sort((a, b) => a.createdAt - b.createdAt);
    const toDelete = new Set<string>();
    for (const e of sorted) { if (now - e.createdAt >= cfg.maxAgeMs) toDelete.add(e.id); }
    const rem = sorted.filter((e) => !toDelete.has(e.id));
    if (cfg.maxCount !== Infinity && rem.length > cfg.maxCount) {
      const excess = rem.length - cfg.maxCount;
      for (let i = 0; i < excess; i++) toDelete.add(rem[i]!.id);
    }
    const ac = sorted.filter((e) => !toDelete.has(e.id));
    if (cfg.maxSizeBytes !== Infinity) {
      let total = ac.reduce((s, e) => s + e.sizeBytes, 0);
      for (const e of ac) { if (total <= cfg.maxSizeBytes) break; toDelete.add(e.id); total -= e.sizeBytes; }
    }
    for (const id of toDelete) this.entries.delete(id);
  }

  list(): SpillEntry[] { return Array.from(this.entries.values()); }
}

// ─── Diagnostics Backend ─────────────────────────────────────────────────────

/**
 * DiagnosticsBackend — records overflow events as structured log entries.
 * Does NOT store content; `read()` always returns null.
 */
export class DiagnosticsBackend implements SpillBackend {
  readonly type: SpillBackendType = 'diagnostics';
  private readonly log: Array<{ id: string; filename: string; sizeBytes: number; createdAt: number }> = [];

  write(filename: string, content: string): SpillEntry | null {
    const sizeBytes = new TextEncoder().encode(content).length;
    const createdAt = Date.now();
    this.log.push({ id: filename, filename, sizeBytes, createdAt });
    logger.info(`[overflow:diagnostics] spilled ${sizeBytes} bytes → ${filename}`);
    return { id: filename, filename, content: '', sizeBytes, createdAt, backendType: 'diagnostics' };
  }

  read(_id: string): string | null { return null; }

  cleanup(policy?: RetentionPolicyConfig): void {
    const cfg = { ...DEFAULT_RETENTION, ...policy };
    const now = Date.now();
    const sorted = [...this.log].sort((a, b) => a.createdAt - b.createdAt);
    const toDelete = new Set<string>();
    for (const e of sorted) { if (now - e.createdAt >= cfg.maxAgeMs) toDelete.add(e.id); }
    const rem = sorted.filter((e) => !toDelete.has(e.id));
    if (cfg.maxCount !== Infinity && rem.length > cfg.maxCount) {
      const excess = rem.length - cfg.maxCount;
      for (let i = 0; i < excess; i++) toDelete.add(rem[i]!.id);
    }
    const ac = sorted.filter((e) => !toDelete.has(e.id));
    if (cfg.maxSizeBytes !== Infinity) {
      let total = ac.reduce((s, e) => s + e.sizeBytes, 0);
      for (const e of ac) { if (total <= cfg.maxSizeBytes) break; toDelete.add(e.id); total -= e.sizeBytes; }
    }
    for (let i = this.log.length - 1; i >= 0; i--) {
      if (toDelete.has(this.log[i]!.id)) this.log.splice(i, 1);
    }
  }

  list(): SpillEntry[] {
    return this.log.map((e) => ({ ...e, content: '', backendType: 'diagnostics' as SpillBackendType }));
  }
}

// ─── Backend Factory ─────────────────────────────────────────────────────────

/**
 * Create a spill backend by type. Defaults to `'file'`.
 */
export function createSpillBackend(type: SpillBackendType = 'file', baseDir?: string): SpillBackend {
  switch (type) {
    case 'file':
      if (!baseDir) throw new Error('File spill backend requires an explicit baseDir');
      return new FileBackend(baseDir);
    case 'ledger':      return new LedgerBackend();
    case 'diagnostics': return new DiagnosticsBackend();
    default: {
      logger.info(`[overflow] Unknown spill backend "${String(type)}", falling back to file`);
      if (!baseDir) throw new Error('File spill backend requires an explicit baseDir');
      return new FileBackend(baseDir);
    }
  }
}

// ─── OverflowHandlerConfig ───────────────────────────────────────────────────

export interface OverflowHandlerConfig {
  /**
   * Which backend to use. Defaults to `'file'`.
   */
  spillBackend?: SpillBackendType;
  /** Base directory for FileBackend. */
  baseDir?: string;
  /** Retention policy applied during cleanup(). */
  retention?: RetentionPolicyConfig;
  /** Inject a custom backend directly (takes precedence over spillBackend). */
  backend?: SpillBackend;
}

// ─── OverflowHandler ────────────────────────────────────────────────────────

/**
 * Handles large tool output by delegating overflow content to a pluggable
 * backend and returning a truncated version with a typed reference URI.
 *
 * Overflow references encode the backend type:
 *   `file:.goodvibes/.overflow/{filename}`
 *   `ledger:{filename}`
 *   `diagnostics:{filename}`
 *
 * Never throws — on write failure, returns truncated content without ref.
 */
export class OverflowHandler {
  private readonly backend: SpillBackend;
  private readonly retention: RetentionPolicyConfig;

  constructor(config: OverflowHandlerConfig = {}) {
    if (!config.backend && (config.spillBackend ?? 'file') === 'file' && !config.baseDir) {
      throw new Error('OverflowHandler requires an explicit baseDir when using the file spill backend');
    }
    this.backend = config.backend ?? createSpillBackend(config.spillBackend ?? 'file', config.baseDir);
    this.retention = { ...DEFAULT_RETENTION, ...config.retention };
  }

  private sanitizeLabel(label: string): string {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  private buildRef(filename: string): string {
    switch (this.backend.type) {
      case 'file':        return `file:${OVERFLOW_DIR}/${filename}`;
      case 'ledger':      return `ledger:${filename}`;
      case 'diagnostics': return `diagnostics:${filename}`;
      default:            return `${this.backend.type}:${filename}`;
    }
  }

  /**
   * Handle potentially large content.
   * Returns unchanged content if within limit.
   * On overflow: delegates to active backend and returns typed ref.
   */
  handle(content: string, options?: OverflowOptions): OverflowResult {
    const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

    if (content.length <= maxChars) {
      return { content };
    }

    const label = this.sanitizeLabel(options?.label ?? 'output');
    const filename = `${Date.now()}-${label}.txt`;

    let entry: SpillEntry | null;
    try {
      entry = this.backend.write(filename, content);
    } catch (err) {
      logger.info(`[overflow] Backend write error: ${summarizeError(err)}`);
      entry = null;
    }

    if (!entry) {
      return {
        content: content.slice(0, maxChars) + `\n[... truncated at ${maxChars} chars]`,
      };
    }

    const ref = this.buildRef(filename);
    const notice = this.backend.type === 'file'
      ? `Full output: ${ref.replace(/^file:/, '')}`
      : `Spilled to ${this.backend.type} backend (ref: ${ref})`;

    return {
      content: content.slice(0, maxChars) + `\n[... truncated. ${notice}]`,
      overflowRef: ref,
      spillBackend: this.backend.type,
    };
  }

  /**
   * Prune entries that violate the retention policy.
   */
  cleanup(policy?: RetentionPolicyConfig): void {
    this.backend.cleanup({ ...this.retention, ...policy });
  }

  /** List current overflow entries from the active backend. */
  list(): SpillEntry[] {
    return this.backend.list();
  }

  /** Return the active backend type. */
  get backendType(): SpillBackendType {
    return this.backend.type;
  }
}

// ─── Operator Cleanup Command ────────────────────────────────────────────────

/**
 * overflowCleanup — operator-facing cleanup command.
 *
 * Prunes overflow entries from the provided overflow handler.
 * Suitable for scripted operator invocations (e.g. CLI, cron).
 */
export function overflowCleanup(handler: OverflowHandler, policy?: RetentionPolicyConfig): { beforeCount: number } {
  const beforeCount = handler.list().length;
  handler.cleanup(policy);
  return { beforeCount };
}
