import { existsSync, statSync, watch, watchFile, unwatchFile, type Stats } from 'fs';
import type { FSWatcher } from 'fs';
import { join, resolve } from 'path';
import { logger } from '../utils/logger.ts';
import type { FileStateCache } from './file-cache.ts';
import type { ProjectIndex } from './project-index.ts';
import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { HookEvent } from '../hooks/types.ts';
import { summarizeError } from '../utils/error-display.ts';

/**
 * Default paths to watch relative to project root.
 * Glob-like patterns are expanded manually.
 */
const DEFAULT_WATCH_PATHS = [
  'package.json',
  'tsconfig.json',
];

/** .env* files to watch (checked for existence on start) */
const DEFAULT_ENV_GLOBS = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
];

/**
 * FileWatcher — watches key project files and invalidates caches on change.
 *
 * Uses Node.js/Bun-native `fs.watch`. Debounces events per-file (100ms).
 * On change:
 *   1. Invalidates FileStateCache entry
 *   2. Upserts ProjectIndex with new token estimate
 *   3. Fires Change:file:external hook via HookDispatcher (if provided)
 */
export class FileWatcher {
  private readonly fileCache: FileStateCache;
  private readonly projectIndex: ProjectIndex;
  private readonly hookDispatcher?: HookDispatcher;
  private readonly projectRoot: string;

  /** Absolute paths currently being watched */
  private watchedPaths: Set<string> = new Set();
  /** Active FSWatcher instances keyed by absolute path */
  private watchers: Map<string, FSWatcher> = new Map();
  /** Pending debounce timers keyed by absolute path */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** watchFile listeners keyed by absolute path for reliable polling fallback */
  private pollListeners: Map<string, (curr: Stats, prev: Stats) => void> = new Map();

  private watching = false;

  /** Debounce window in milliseconds */
  private static readonly DEBOUNCE_MS = 100;

  constructor(
    fileCache: FileStateCache,
    projectIndex: ProjectIndex,
    options: { projectRoot: string },
    hookDispatcher?: HookDispatcher,
  ) {
    this.fileCache = fileCache;
    this.projectIndex = projectIndex;
    this.hookDispatcher = hookDispatcher;
    this.projectRoot = options.projectRoot;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start watching all registered paths.
   * Adds default paths (package.json, tsconfig.json, .env*, .goodvibes/**).
   * Also watches all files currently in ProjectIndex.
   */
  start(): void {
    if (this.watching) return;
    this.watching = true;

    // Register default config paths
    for (const rel of DEFAULT_WATCH_PATHS) {
      this.addPath(join(this.projectRoot, rel));
    }
    for (const rel of DEFAULT_ENV_GLOBS) {
      this.addPath(join(this.projectRoot, rel));
    }

    // Watch .goodvibes/ directory tree (recursive)
    this.addPath(join(this.projectRoot, '.goodvibes'));

    // Watch all files currently in ProjectIndex (cap at MAX_WATCHERS to avoid unbounded growth)
    const MAX_WATCHERS = 500;
    for (const entry of this.projectIndex.getFiles()) {
      if (this.watchedPaths.size >= MAX_WATCHERS) {
        logger.debug('FileWatcher: MAX_WATCHERS cap reached, skipping remaining files', { cap: MAX_WATCHERS });
        break;
      }
      const absPath = entry.path.startsWith('/')
        ? entry.path
        : join(this.projectRoot, entry.path);
      this.addPath(absPath);
    }

    logger.debug('FileWatcher: started', { watched: this.watchedPaths.size });
  }

  /**
   * Stop watching all paths and clear all watchers.
   */
  stop(): void {
    if (!this.watching) return;
    this.watching = false;

    // Cancel pending debounces
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close all watchers
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch (err) { logger.debug('FileWatcher: watcher close error', { error: summarizeError(err) }); }
    }
    this.watchers.clear();
    for (const [absPath, listener] of this.pollListeners) {
      try { unwatchFile(absPath, listener); } catch (err) { logger.debug('FileWatcher: unwatchFile error', { absPath, error: summarizeError(err) }); }
    }
    this.pollListeners.clear();
    this.watchedPaths.clear();

    logger.debug('FileWatcher: stopped');
  }

  /** Returns true if the watcher has been started and not stopped. */
  isWatching(): boolean {
    return this.watching;
  }

  // ---------------------------------------------------------------------------
  // Path management
  // ---------------------------------------------------------------------------

  /**
   * Add a path to the watch list.
   * If already watching, opens a watcher immediately.
   * Silently skips paths that do not exist.
   */
  addPath(inputPath: string): void {
    const absPath = resolve(inputPath);
    if (!absPath.startsWith(this.projectRoot + '/') && absPath !== this.projectRoot) {
      logger.debug('FileWatcher: rejecting path outside project root', { absPath });
      return;
    }
    if (this.watchedPaths.has(absPath)) return;
    this.watchedPaths.add(absPath);

    if (this.watching) {
      this._openWatcher(absPath);
    }
  }

  /**
   * Remove a path from the watch list and close its watcher.
   */
  removePath(inputPath: string): void {
    const absPath = resolve(inputPath);
    this.watchedPaths.delete(absPath);

    // Cancel any pending debounce for this path
    const timer = this.debounceTimers.get(absPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.debounceTimers.delete(absPath);
    }

    const watcher = this.watchers.get(absPath);
    if (watcher) {
      try { watcher.close(); } catch (err) { logger.debug('FileWatcher: watcher close error', { error: summarizeError(err) }); }
      this.watchers.delete(absPath);
    }
    const pollListener = this.pollListeners.get(absPath);
    if (pollListener) {
      try { unwatchFile(absPath, pollListener); } catch (err) { logger.debug('FileWatcher: unwatchFile error', { absPath, error: summarizeError(err) }); }
      this.pollListeners.delete(absPath);
    }
  }

  /** Return a snapshot of all watched absolute paths. */
  getWatchedPaths(): ReadonlySet<string> {
    return new Set(this.watchedPaths);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _openWatcher(absPath: string): void {
    // Skip non-existent paths silently
    if (!existsSync(absPath)) return;

    // Already watching this path
    if (this.watchers.has(absPath)) return;

    try {
      let isDir = false;
      try {
        isDir = statSync(absPath).isDirectory();
      } catch { /* non-fatal */ }

      const watcher = watch(
        absPath,
        { recursive: isDir },
        (_event: string, filename: string | null) => {
          // For directories, reconstruct the changed file path
          const changedPath = isDir && filename
            ? join(absPath, filename)
            : absPath;
          this._scheduleChange(changedPath);
        },
      );

      watcher.on('error', (err) => {
        logger.debug('FileWatcher: watcher error', { absPath, error: summarizeError(err) });
        this.watchers.delete(absPath);
      });

      this.watchers.set(absPath, watcher);

      if (!isDir && !this.pollListeners.has(absPath)) {
        const pollListener = (curr: Stats, prev: Stats) => {
          if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
            this._scheduleChange(absPath);
          }
        };
        watchFile(absPath, { interval: FileWatcher.DEBOUNCE_MS }, pollListener);
        this.pollListeners.set(absPath, pollListener);
      }
    } catch (err) {
      logger.debug('FileWatcher: failed to open watcher', { absPath, error: summarizeError(err) });
    }
  }

  private _scheduleChange(absPath: string): void {
    // Cancel existing debounce for this path
    const existing = this.debounceTimers.get(absPath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      this._handleChange(absPath);
    }, FileWatcher.DEBOUNCE_MS);

    this.debounceTimers.set(absPath, timer);
  }

  private _handleChange(absPath: string): void {
    logger.debug('FileWatcher: file changed', { absPath });

    // 1. Invalidate the file cache entry
    this.fileCache.invalidate(absPath);

    // 2. Update ProjectIndex with fresh token estimate
    let tokenEstimate: number | undefined;
    try {
      const size = statSync(absPath).size;
      // Rough heuristic: ~4 bytes per token (same as ReadTool/ProjectIndex)
      tokenEstimate = Math.ceil(size / 4);
    } catch {
      // File may have been deleted — leave token estimate as undefined
    }
    this.projectIndex.upsertFile(absPath, tokenEstimate);

    // 3. Fire Change:file:external hook (fire-and-forget)
    if (this.hookDispatcher) {
      const event: HookEvent = {
        path: 'Change:file:external',
        phase: 'Change',
        category: 'file',
        specific: 'external',
        sessionId: 'file-watcher',
        timestamp: Date.now(),
        payload: { filePath: absPath },
      };
      this.hookDispatcher.fire(event).catch((err) => {
        logger.debug('FileWatcher: hook fire error', { absPath, error: summarizeError(err) });
      });
    }
  }
}
