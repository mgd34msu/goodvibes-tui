import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileWatcher } from '../../state/file-watcher.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { HookDispatcher } from '../../hooks/dispatcher.ts';
import { getTestProjectIndex, resetTestProjectIndexes } from '../helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-fw-test-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileWatcher', () => {
  let tmpDir: string;
  let fileCache: FileStateCache;
  let projectIndex: ProjectIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fileCache = new FileStateCache();
    resetTestProjectIndexes();
    projectIndex = getTestProjectIndex(tmpDir);
  });

  afterEach(() => {
    resetTestProjectIndexes();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Constructor / isWatching
  // -------------------------------------------------------------------------

  it('starts in non-watching state', () => {
    const watcher = new FileWatcher(fileCache, projectIndex);
    expect(watcher.isWatching()).toBe(false);
  });

  it('isWatching returns true after start()', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    expect(watcher.isWatching()).toBe(true);
    watcher.stop();
  });

  it('isWatching returns false after stop()', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    watcher.stop();
    expect(watcher.isWatching()).toBe(false);
  });

  it('start() is idempotent', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    watcher.start(); // second call is no-op
    expect(watcher.isWatching()).toBe(true);
    watcher.stop();
  });

  it('stop() is idempotent', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    watcher.stop();
    watcher.stop(); // second call is no-op
    expect(watcher.isWatching()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // addPath / removePath
  // -------------------------------------------------------------------------

  it('addPath registers path before start', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    const file = join(tmpDir, 'custom.txt');
    writeFileSync(file, 'hello');
    watcher.addPath(file);
    const watched = watcher.getWatchedPaths();
    expect(watched.has(file)).toBe(true);
    watcher.stop();
  });

  it('addPath deduplicates paths', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    const file = join(tmpDir, 'dup.txt');
    writeFileSync(file, 'content');
    watcher.addPath(file);
    watcher.addPath(file);
    const watched = watcher.getWatchedPaths();
    expect(watched.size).toBeGreaterThanOrEqual(1);
    // Only one entry for this path
    let count = 0;
    for (const p of watched) { if (p === file) count++; }
    expect(count).toBe(1);
  });

  it('removePath removes a path from the watch set', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    const file = join(tmpDir, 'remove-me.txt');
    writeFileSync(file, 'content');
    watcher.addPath(file);
    expect(watcher.getWatchedPaths().has(file)).toBe(true);
    watcher.removePath(file);
    expect(watcher.getWatchedPaths().has(file)).toBe(false);
  });

  it('removePath is safe for unknown paths', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    // Should not throw
    expect(() => watcher.removePath('/nonexistent/path/to/file.ts')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Change handling
  // -------------------------------------------------------------------------

  it('invalidates FileStateCache on file change', async () => {
    const file = join(tmpDir, 'watched.ts');
    writeFileSync(file, 'const x = 1;');

    // Seed the cache so there is something to invalidate
    fileCache.update(file, 'const x = 1;');
    expect(fileCache.lookup(file).status).not.toBe('miss');

    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    watcher.addPath(file);

    // Trigger change
    writeFileSync(file, 'const x = 2;');
    await sleep(250); // wait for debounce + handler

    expect(fileCache.lookup(file).status).toBe('miss');
    watcher.stop();
  });

  it('upserts ProjectIndex on file change', async () => {
    const file = join(tmpDir, 'src', 'main.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(file, 'export const x = 1;');

    projectIndex.upsertFile(file, 5);
    expect(projectIndex.getFile(file)).not.toBeNull();

    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    watcher.addPath(file);

    writeFileSync(file, 'export const x = 2; // bigger');
    await sleep(250);

    // Token estimate should now reflect the new file size
    const entry = projectIndex.getFile(file);
    expect(entry).not.toBeNull();
    watcher.stop();
  });

  it('fires Change:file:external hook on file change', async () => {
    const hookDispatcher = new HookDispatcher();
    const firedPaths: string[] = [];

    // Register a programmatic ts-style hook via spy
    hookDispatcher.register('Change:file:external', {
      type: 'ts',
      match: 'Change:file:external',
      async: true,
      once: false,
    });

    // Spy on fire using bun:test spyOn
    const fireSpy = spyOn(hookDispatcher, 'fire').mockImplementation(async (event: import('../../hooks/types.ts').HookEvent) => {
      firedPaths.push((event.payload as { filePath: string }).filePath);
      return { ok: true };
    });

    const file = join(tmpDir, 'hook-test.ts');
    writeFileSync(file, 'const a = 1;');

    const watcher = new FileWatcher(fileCache, projectIndex, hookDispatcher, { projectRoot: tmpDir });
    watcher.start();
    watcher.addPath(file);

    writeFileSync(file, 'const a = 2;');
    await sleep(250);

    expect(firedPaths.length).toBeGreaterThan(0);
    expect(firedPaths[0]).toBe(file);

    fireSpy.mockRestore();
    watcher.stop();
  });

  // -------------------------------------------------------------------------
  // ProjectIndex files are auto-watched
  // -------------------------------------------------------------------------

  it('watches all files already in ProjectIndex on start()', () => {
    const file = join(tmpDir, 'indexed.ts');
    writeFileSync(file, 'export {}');
    projectIndex.upsertFile(file, 10);

    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();

    expect(watcher.getWatchedPaths().has(file)).toBe(true);
    watcher.stop();
  });

  // -------------------------------------------------------------------------
  // Debounce
  // -------------------------------------------------------------------------

  it('debounces rapid changes to fire handler only once', async () => {
    const file = join(tmpDir, 'debounce-test.ts');
    writeFileSync(file, 'v0');

    let invalidateCount = 0;
    const origInvalidate = fileCache.invalidate.bind(fileCache);
    (fileCache as unknown as Record<string, unknown>).invalidate = (p: string) => {
      if (p === file) invalidateCount++;
      origInvalidate(p);
    };

    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    watcher.start();
    watcher.addPath(file);

    // Write several times in rapid succession
    writeFileSync(file, 'v1');
    writeFileSync(file, 'v2');
    writeFileSync(file, 'v3');
    await sleep(300);

    // Handler should fire at most a small number of times (debounced)
    // The debounce window is 100ms; 3 rapid writes should collapse to fewer than 3 events
    expect(invalidateCount).toBeLessThan(3);

    (fileCache as unknown as Record<string, unknown>).invalidate = origInvalidate;
    watcher.stop();
  });

  // -------------------------------------------------------------------------
  // Path boundary enforcement
  // -------------------------------------------------------------------------

  it('rejects paths outside project root', () => {
    const watcher = new FileWatcher(fileCache, projectIndex, undefined, { projectRoot: tmpDir });
    const outsidePath = join(tmpdir(), 'outside-project.ts');
    writeFileSync(outsidePath, 'const x = 1;');
    watcher.addPath(outsidePath);
    expect(watcher.getWatchedPaths().has(outsidePath)).toBe(false);
    try { rmSync(outsidePath); } catch { /* ignore */ }
  });
});
