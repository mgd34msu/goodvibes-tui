import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { FileStateCache } from '@pellux/goodvibes-sdk/platform/state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-fc-test-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FileStateCache', () => {
  let tmpDir: string;
  let cache: FileStateCache;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cache = new FileStateCache();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // lookup: miss
  // -------------------------------------------------------------------------

  describe('lookup: miss', () => {
    test('returns miss for unknown file', () => {
      const result = cache.lookup(join(tmpDir, 'unknown.ts'));
      expect(result.status).toBe('miss');
      expect(result.entry).toBeUndefined();
    });

    test('returns miss after invalidate', () => {
      const filePath = join(tmpDir, 'file.ts');
      writeFileSync(filePath, 'const x = 1;', 'utf-8');
      cache.update(filePath, 'const x = 1;');
      cache.invalidate(filePath);
      const result = cache.lookup(filePath);
      expect(result.status).toBe('miss');
    });

    test('returns miss when file has been deleted', () => {
      const filePath = join(tmpDir, 'gone.ts');
      writeFileSync(filePath, 'x', 'utf-8');
      cache.update(filePath, 'x');
      // Delete the file
      rmSync(filePath);
      const result = cache.lookup(filePath);
      expect(result.status).toBe('miss');
    });
  });

  // -------------------------------------------------------------------------
  // lookup: unchanged
  // -------------------------------------------------------------------------

  describe('lookup: unchanged', () => {
    test('returns unchanged when file has not been modified', () => {
      const filePath = join(tmpDir, 'stable.ts');
      const content = 'export const x = 42;';
      writeFileSync(filePath, content, 'utf-8');
      cache.update(filePath, content);

      const result = cache.lookup(filePath);
      expect(result.status).toBe('unchanged');
      expect(result.entry).toBeDefined();
    });

    test('entry has correct metadata after unchanged hit', () => {
      const filePath = join(tmpDir, 'meta.ts');
      const content = 'line1\nline2\nline3';
      writeFileSync(filePath, content, 'utf-8');
      cache.update(filePath, content);

      const result = cache.lookup(filePath);
      expect(result.status).toBe('unchanged');
      const entry = result.entry!;
      expect(entry.lineCount).toBe(3);
      expect(entry.readCount).toBeGreaterThanOrEqual(2); // 1 from update + 1 from lookup
      expect(entry.tokenEstimate).toBeGreaterThan(0);
    });

    test('tokensSaved accumulates on repeated hits', () => {
      const filePath = join(tmpDir, 'hits.ts');
      const content = 'a'.repeat(400); // ~100 tokens
      writeFileSync(filePath, content, 'utf-8');
      cache.update(filePath, content);

      cache.lookup(filePath);
      cache.lookup(filePath);
      const result = cache.lookup(filePath);
      expect(result.entry!.tokensSaved).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // lookup: modified
  // -------------------------------------------------------------------------

  describe('lookup: modified', () => {
    test('returns modified when file content changes on disk', () => {
      const filePath = join(tmpDir, 'changing.ts');
      const v1 = 'const x = 1;';
      const v2 = 'const x = 2; // updated';
      writeFileSync(filePath, v1, 'utf-8');
      cache.update(filePath, v1);

      // Modify the file externally
      writeFileSync(filePath, v2, 'utf-8');

      const result = cache.lookup(filePath);
      expect(result.status).toBe('modified');
    });

    test('modified entry has incremented version', () => {
      const filePath = join(tmpDir, 'versioned.ts');
      writeFileSync(filePath, 'v1', 'utf-8');
      cache.update(filePath, 'v1');
      const v1Entry = cache.lookup(filePath); // unchanged, version=1

      writeFileSync(filePath, 'v2', 'utf-8');
      const v2Result = cache.lookup(filePath); // modified

      expect(v2Result.status).toBe('modified');
      expect(v2Result.entry!.version).toBeGreaterThan(v1Entry.entry!.version);
    });
  });

  // -------------------------------------------------------------------------
  // OCC conflict detection
  // -------------------------------------------------------------------------

  describe('checkConflict', () => {
    test('returns null when no entry exists', () => {
      expect(cache.checkConflict(join(tmpDir, 'none.ts'), 1)).toBeNull();
    });

    test('returns null when version matches', () => {
      const filePath = join(tmpDir, 'noconflict.ts');
      writeFileSync(filePath, 'content', 'utf-8');
      cache.update(filePath, 'content');
      const result = cache.lookup(filePath);
      const v = result.entry!.version;
      expect(cache.checkConflict(filePath, v)).toBeNull();
    });

    test('returns ConflictInfo when version differs', () => {
      const filePath = join(tmpDir, 'conflict.ts');
      writeFileSync(filePath, 'v1', 'utf-8');
      cache.update(filePath, 'v1');

      // Update again to bump version
      writeFileSync(filePath, 'v2', 'utf-8');
      cache.update(filePath, 'v2');

      const conflict = cache.checkConflict(filePath, 1);
      expect(conflict).not.toBeNull();
      expect(conflict!.yourVersion).toBe(1);
      expect(conflict!.currentVersion).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // invalidate
  // -------------------------------------------------------------------------

  describe('invalidate', () => {
    test('invalidating unknown path is a no-op', () => {
      expect(() => cache.invalidate('/nonexistent/path.ts')).not.toThrow();
    });

    test('invalidated file returns miss on next lookup', () => {
      const filePath = join(tmpDir, 'inv.ts');
      writeFileSync(filePath, 'x', 'utf-8');
      cache.update(filePath, 'x');
      cache.invalidate(filePath);
      expect(cache.lookup(filePath).status).toBe('miss');
    });
  });

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  describe('getStats', () => {
    test('returns zeros for empty cache', () => {
      const stats = cache.getStats();
      expect(stats.uniqueFiles).toBe(0);
      expect(stats.totalReads).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.tokensSaved).toBe(0);
    });

    test('uniqueFiles reflects cache size', () => {
      const f1 = join(tmpDir, 'f1.ts');
      const f2 = join(tmpDir, 'f2.ts');
      writeFileSync(f1, 'a', 'utf-8');
      writeFileSync(f2, 'b', 'utf-8');
      cache.update(f1, 'a');
      cache.update(f2, 'b');
      expect(cache.getStats().uniqueFiles).toBe(2);
    });

    test('hitRate increases with cache hits', () => {
      const filePath = join(tmpDir, 'rate.ts');
      writeFileSync(filePath, 'content', 'utf-8');
      cache.update(filePath, 'content');
      cache.lookup(filePath); // hit
      cache.lookup(filePath); // hit
      const stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(0);
    });

    test('memoryMB is non-negative', () => {
      expect(cache.getStats().memoryMB).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    test('clears all entries', () => {
      const filePath = join(tmpDir, 'clear.ts');
      writeFileSync(filePath, 'x', 'utf-8');
      cache.update(filePath, 'x');
      cache.clear();
      expect(cache.getStats().uniqueFiles).toBe(0);
      expect(cache.lookup(filePath).status).toBe('miss');
    });
  });

  // -------------------------------------------------------------------------
  // LRU eviction
  // -------------------------------------------------------------------------

  describe('LRU eviction', () => {
    test('evicts oldest entries when memory limit exceeded', () => {
      // Use 1 byte limit to force immediate eviction
      const tinyCache = new FileStateCache({ maxMemoryMB: 0.000001 });
      const filePaths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = join(tmpDir, `lru${i}.ts`);
        const content = 'x'.repeat(1000);
        writeFileSync(p, content, 'utf-8');
        tinyCache.update(p, content);
        filePaths.push(p);
      }
      // Some entries should have been evicted
      const stats = tinyCache.getStats();
      expect(stats.uniqueFiles).toBeLessThan(5);
    });

    test('normal cache does not evict under budget', () => {
      const smallCache = new FileStateCache({ maxMemoryMB: 200 });
      for (let i = 0; i < 10; i++) {
        const p = join(tmpDir, `normal${i}.ts`);
        const content = 'small content';
        writeFileSync(p, content, 'utf-8');
        smallCache.update(p, content);
      }
      expect(smallCache.getStats().uniqueFiles).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // with_content mode
  // -------------------------------------------------------------------------

  describe('with_content mode', () => {
    test('stores content in with_content mode', () => {
      const contentCache = new FileStateCache({ mode: 'with_content' });
      const filePath = join(tmpDir, 'wc.ts');
      const content = 'const x = 1;';
      writeFileSync(filePath, content, 'utf-8');
      contentCache.update(filePath, content);

      const result = contentCache.lookup(filePath);
      expect(result.status).toBe('unchanged');
      expect(result.entry!.content).toBe(content);
    });

    test('does not store content in hash_only mode', () => {
      const filePath = join(tmpDir, 'ho.ts');
      const content = 'const y = 2;';
      writeFileSync(filePath, content, 'utf-8');
      cache.update(filePath, content);

      const result = cache.lookup(filePath);
      expect(result.entry!.content).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // token estimate
  // -------------------------------------------------------------------------

  describe('token estimate', () => {
    test('tokenEstimate is ceil(byteSize / 4)', () => {
      const filePath = join(tmpDir, 'tokens.ts');
      const content = 'x'.repeat(100); // 100 bytes -> 25 tokens
      writeFileSync(filePath, content, 'utf-8');
      cache.update(filePath, content);
      const result = cache.lookup(filePath);
      expect(result.entry!.tokenEstimate).toBe(25);
    });
  });
});
