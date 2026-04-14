import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join, dirname, sep } from 'path';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

/**
 * A file entry in the flat in-memory index.
 */
export interface FileEntry {
  /** Path relative to project root, using forward slashes. */
  path: string;
  /** Estimated LLM token count. */
  tokens: number;
}

/**
 * On-disk tree format:
 * { "src/": { "main.ts": 450, "config/": { "schema.ts": 280 } } }
 */
type TreeNode = number | TreeDir;
interface TreeDir {
  [key: string]: TreeNode;
}

interface DiskFormat {
  _format: string;
  version: number;
  created_at: string;
  updated_at: string;
  project_root: string;
  stats: {
    total_files: number;
    total_dirs: number;
    index_duration_ms: number;
  };
  tree: TreeDir;
}

/**
 * ProjectIndex — In-memory project file index with token counts.
 *
 * Singleton per process. Loaded at startup from disk in the background.
 * Mutations are debounced: flush happens 5 seconds after last write.
 *
 * Disk format: v4 tree (see DiskFormat above).
 */
export class ProjectIndex {
  private readonly indexPath: string;
  private readonly projectRoot: string;
  readonly baseDir: string;
  private files: Map<string, number> = new Map(); // path -> tokens
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private createdAt: string = new Date().toISOString();
  private loaded = false;

  constructor(baseDir: string) {
    this.projectRoot = baseDir;
    this.baseDir = this.projectRoot;
    this.indexPath = join(this.projectRoot, '.goodvibes', 'project-index.json');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load the index from disk.
   * Non-blocking: called at startup, safe to call multiple times.
   */
  async load(): Promise<void> {
    if (!existsSync(this.indexPath)) {
      this.loaded = true;
      return;
    }
    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      const disk = JSON.parse(raw) as DiskFormat;
      if (disk.version === 4 && disk.tree) {
        this.createdAt = disk.created_at ?? this.createdAt;
        this.files = flattenTree(disk.tree);
      }
      this.loaded = true;
      logger.debug('ProjectIndex: loaded', { files: this.files.size });
    } catch (err) {
      logger.debug('ProjectIndex: load failed (non-fatal)', { error: summarizeError(err) });
      this.loaded = true;
    }
  }

  /**
   * Flush to disk immediately, bypassing debounce.
   */
  async forceFlush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getFiles(): FileEntry[] {
    return Array.from(this.files.entries()).map(([path, tokens]) => ({ path, tokens }));
  }

  getFile(path: string): FileEntry | null {
    const normalPath = this.normalizePath(path);
    const tokens = this.files.get(normalPath);
    if (tokens === undefined) return null;
    return { path: normalPath, tokens };
  }

  getFilesByPrefix(prefix: string): FileEntry[] {
    const normalPrefix = this.normalizePath(prefix);
    const result: FileEntry[] = [];
    for (const [path, tokens] of this.files) {
      if (path.startsWith(normalPrefix)) {
        result.push({ path, tokens });
      }
    }
    return result;
  }

  /** Return count of files by extension (e.g. { ts: 42, json: 5 }). */
  getTypeCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const path of this.files.keys()) {
      const dot = path.lastIndexOf('.');
      const ext = dot >= 0 ? path.slice(dot + 1) : 'other';
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
    return counts;
  }

  getTotalTokens(): number {
    let total = 0;
    for (const tokens of this.files.values()) total += tokens;
    return total;
  }

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------

  /**
   * Insert or update a file entry.
   * If tokens is not provided, attempts to estimate from disk.
   */
  upsertFile(path: string, tokens?: number): void {
    const normalPath = this.normalizePath(path);
    const t = tokens ?? this.files.get(normalPath) ?? 0;
    this.files.set(normalPath, t);
    this.scheduleFlush();
  }

  /**
   * Touch an existing file entry (update token count from disk if possible).
   * No-op if file not in index.
   */
  touchFile(path: string): void {
    const normalPath = this.normalizePath(path);
    if (!this.files.has(normalPath)) return;
    // Update token estimate from file size if readable
    try {
      const size = statSync(path).size;
      const tokens = Math.ceil(size / 4);
      this.files.set(normalPath, tokens);
      this.scheduleFlush();
    } catch {
      // Non-fatal: leave existing value
    }
  }

  removeFile(path: string): void {
    const normalPath = this.normalizePath(path);
    if (this.files.delete(normalPath)) {
      this.scheduleFlush();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private normalizePath(inputPath: string): string {
    let p = inputPath.split(sep).join('/');
    // Strip project root prefix for absolute paths
    const root = this.baseDir.split(sep).join('/');
    if (p.startsWith(root + '/')) {
      p = p.slice(root.length + 1);
    }
    p = p.replace(/^\.\//,'');
    return p;
  }

  async dispose(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.forceFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(err => {
        logger.debug('ProjectIndex: scheduled flush failed', { error: summarizeError(err) });
      });
    }, 5000);
  }

  private async flush(): Promise<void> {
    try {
      mkdirSync(dirname(this.indexPath), { recursive: true });
      const tree = buildTree(this.files);
      const totalFiles = this.files.size;
      // Count dirs
      const dirs = new Set<string>();
      for (const path of this.files.keys()) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'));
        }
      }
      const disk: DiskFormat = {
        _format: 'tree: { "directory/": { "file.ext": token_count } }',
        version: 4,
        created_at: this.createdAt,
        updated_at: new Date().toISOString(),
        project_root: this.projectRoot,
        stats: {
          total_files: totalFiles,
          total_dirs: dirs.size,
          index_duration_ms: 0,
        },
        tree,
      };
      const tmpPath = `${this.indexPath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(disk) + '\n', 'utf-8');
      renameSync(tmpPath, this.indexPath);
    } catch (err) {
      logger.debug('ProjectIndex: flush failed (non-fatal)', { error: summarizeError(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Tree serialization helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a v4 tree into a Map<path, tokens>.
 * Tree: { "src/": { "main.ts": 450 } } -> Map { "src/main.ts" => 450 }
 */
function flattenTree(tree: TreeDir, prefix = ''): Map<string, number> {
  const result: Map<string, number> = new Map();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'number') {
      // File entry
      result.set(prefix + key, value);
    } else {
      // Directory: key ends with '/'
      const dirName = key.endsWith('/') ? key : key + '/';
      const nested = flattenTree(value as TreeDir, prefix + dirName);
      for (const [p, t] of nested) result.set(p, t);
    }
  }
  return result;
}

/**
 * Build a v4 tree from a flat Map<path, tokens>.
 * "src/main.ts" -> { "src/": { "main.ts": 450 } }
 */
function buildTree(files: Map<string, number>): TreeDir {
  const root: TreeDir = {};
  for (const [path, tokens] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirKey = parts[i] + '/';
      if (!(dirKey in node)) {
        node[dirKey] = {};
      }
      node = node[dirKey] as TreeDir;
    }
    const fileName = parts[parts.length - 1];
    node[fileName] = tokens;
  }
  return root;
}
