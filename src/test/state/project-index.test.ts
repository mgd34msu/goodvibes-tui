import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { ProjectIndex } from '../../state/project-index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-pi-test-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ProjectIndex', () => {
  let tmpDir: string;
  let index: ProjectIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Reset singleton so each test gets a fresh instance
    ProjectIndex._resetInstance();
    index = ProjectIndex.getInstance(tmpDir);
  });

  afterEach(async () => {
    await index.forceFlush().catch(() => {});
    ProjectIndex._resetInstance();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    test('starts empty before load', () => {
      expect(index.getFiles()).toHaveLength(0);
    });

    test('getTotalTokens returns 0 when empty', () => {
      expect(index.getTotalTokens()).toBe(0);
    });

    test('getFile returns null for unknown path', () => {
      expect(index.getFile('src/main.ts')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // upsertFile / getFile
  // -------------------------------------------------------------------------

  describe('upsertFile and getFile', () => {
    test('upsertFile adds a new entry', () => {
      index.upsertFile('src/main.ts', 100);
      const entry = index.getFile('src/main.ts');
      expect(entry).not.toBeNull();
      expect(entry!.path).toBe('src/main.ts');
      expect(entry!.tokens).toBe(100);
    });

    test('upsertFile updates existing entry', () => {
      index.upsertFile('src/main.ts', 100);
      index.upsertFile('src/main.ts', 200);
      expect(index.getFile('src/main.ts')!.tokens).toBe(200);
    });

    test('upsertFile with no tokens defaults to 0 for new entry', () => {
      index.upsertFile('src/new.ts');
      expect(index.getFile('src/new.ts')!.tokens).toBe(0);
    });

    test('normalizes ./ prefix', () => {
      index.upsertFile('./src/main.ts', 50);
      expect(index.getFile('src/main.ts')).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // removeFile
  // -------------------------------------------------------------------------

  describe('removeFile', () => {
    test('removes an existing entry', () => {
      index.upsertFile('src/todelete.ts', 10);
      index.removeFile('src/todelete.ts');
      expect(index.getFile('src/todelete.ts')).toBeNull();
    });

    test('no-op for non-existent entry', () => {
      expect(() => index.removeFile('nonexistent.ts')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getFilesByPrefix
  // -------------------------------------------------------------------------

  describe('getFilesByPrefix', () => {
    test('returns files matching prefix', () => {
      index.upsertFile('src/core/conversation.ts', 100);
      index.upsertFile('src/core/history.ts', 50);
      index.upsertFile('src/utils/logger.ts', 30);

      const results = index.getFilesByPrefix('src/core/');
      expect(results).toHaveLength(2);
      const paths = results.map(e => e.path);
      expect(paths).toContain('src/core/conversation.ts');
      expect(paths).toContain('src/core/history.ts');
    });

    test('returns empty array when no prefix matches', () => {
      index.upsertFile('src/main.ts', 10);
      expect(index.getFilesByPrefix('tests/')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getTypeCounts
  // -------------------------------------------------------------------------

  describe('getTypeCounts', () => {
    test('counts files by extension', () => {
      index.upsertFile('src/a.ts', 10);
      index.upsertFile('src/b.ts', 20);
      index.upsertFile('src/c.json', 5);
      index.upsertFile('src/d.md', 15);

      const counts = index.getTypeCounts();
      expect(counts.ts).toBe(2);
      expect(counts.json).toBe(1);
      expect(counts.md).toBe(1);
    });

    test('files without extension counted as other', () => {
      index.upsertFile('Makefile', 5);
      const counts = index.getTypeCounts();
      expect(counts.other).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getTotalTokens
  // -------------------------------------------------------------------------

  describe('getTotalTokens', () => {
    test('sums tokens across all files', () => {
      index.upsertFile('a.ts', 100);
      index.upsertFile('b.ts', 200);
      index.upsertFile('c.ts', 50);
      expect(index.getTotalTokens()).toBe(350);
    });

    test('updates after removeFile', () => {
      index.upsertFile('a.ts', 100);
      index.upsertFile('b.ts', 50);
      index.removeFile('b.ts');
      expect(index.getTotalTokens()).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // Load / save round-trip
  // -------------------------------------------------------------------------

  describe('load / save round-trip', () => {
    test('forceFlush writes to disk', async () => {
      index.upsertFile('src/main.ts', 450);
      await index.forceFlush();
      const indexPath = join(tmpDir, '.goodvibes', 'project-index.json');
      expect(existsSync(indexPath)).toBe(true);
    });

    test('load reads previously flushed data', async () => {
      index.upsertFile('src/main.ts', 450);
      index.upsertFile('src/config/schema.ts', 280);
      await index.forceFlush();

      // Create fresh instance from same dir
      ProjectIndex._resetInstance();
      const index2 = ProjectIndex.getInstance(tmpDir);
      await index2.load();

      expect(index2.getFile('src/main.ts')).not.toBeNull();
      expect(index2.getFile('src/main.ts')!.tokens).toBe(450);
      expect(index2.getFile('src/config/schema.ts')!.tokens).toBe(280);
      await index2.forceFlush().catch(() => {});
      ProjectIndex._resetInstance();
    });

    test('tree format: nested dirs serialize correctly', async () => {
      index.upsertFile('src/a/b/c.ts', 99);
      await index.forceFlush();

      const { readFileSync } = require('fs');
      const raw = readFileSync(join(tmpDir, '.goodvibes', 'project-index.json'), 'utf-8');
      const disk = JSON.parse(raw);
      expect(disk.version).toBe(4);
      // Tree should have nested dir structure
      expect(disk.tree).toBeDefined();
      expect(disk.tree['src/']).toBeDefined();
    });

    test('load is a no-op when no index file exists', async () => {
      await expect(index.load()).resolves.toBeUndefined();
      expect(index.getFiles()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('getInstance', () => {
    test('returns same instance on repeated calls', () => {
      const a = ProjectIndex.getInstance(tmpDir);
      const b = ProjectIndex.getInstance(tmpDir);
      expect(a).toBe(b);
    });

    test('_resetInstance creates a new instance', () => {
      const a = ProjectIndex.getInstance(tmpDir);
      ProjectIndex._resetInstance();
      const b = ProjectIndex.getInstance(tmpDir);
      expect(a).not.toBe(b);
      // Clean up extra instance
      ProjectIndex._resetInstance();
    });
  });

  // -------------------------------------------------------------------------
  // getFiles
  // -------------------------------------------------------------------------

  describe('getFiles', () => {
    test('returns all entries as FileEntry[]', () => {
      index.upsertFile('a.ts', 1);
      index.upsertFile('b.ts', 2);
      const files = index.getFiles();
      expect(files).toHaveLength(2);
      expect(files.every(f => typeof f.path === 'string' && typeof f.tokens === 'number')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe('ProjectIndex.dispose', () => {
  let tmpDir: string;
  let index: ProjectIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gv-pi-dispose-'));
    ProjectIndex._resetInstance();
    index = ProjectIndex.getInstance(tmpDir);
  });

  afterEach(() => {
    ProjectIndex._resetInstance();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('dispose cancels the flush timer and flushes to disk', async () => {
    index.upsertFile('src/main.ts', 100);
    // Timer is pending; dispose should flush immediately
    await index.dispose();
    const indexPath = join(tmpDir, '.goodvibes', 'project-index.json');
    expect(existsSync(indexPath)).toBe(true);
    const { readFileSync } = require('fs');
    const disk = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(disk.version).toBe(4);
    expect(disk.tree).toBeDefined();
  });

  test('dispose with no pending writes is safe', async () => {
    await expect(index.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizePath with absolute paths
// ---------------------------------------------------------------------------

describe('ProjectIndex normalizePath (absolute paths)', () => {
  let tmpDir: string;
  let index: ProjectIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gv-pi-norm-'));
    ProjectIndex._resetInstance();
    index = ProjectIndex.getInstance(tmpDir);
  });

  afterEach(async () => {
    await index.forceFlush().catch(() => {});
    ProjectIndex._resetInstance();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('upsertFile with absolute path strips project root prefix', () => {
    const absPath = join(tmpDir, 'src', 'main.ts');
    index.upsertFile(absPath, 100);
    // Should be stored as relative path
    expect(index.getFile('src/main.ts')).not.toBeNull();
    expect(index.getFile('src/main.ts')!.tokens).toBe(100);
  });

  test('getFile with absolute path resolves correctly', () => {
    const absPath = join(tmpDir, 'src', 'utils.ts');
    index.upsertFile(absPath, 50);
    expect(index.getFile(absPath)).not.toBeNull();
    expect(index.getFile(absPath)!.tokens).toBe(50);
  });

  test('relative path with ./ prefix is normalized', () => {
    index.upsertFile('./src/config.ts', 30);
    expect(index.getFile('src/config.ts')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getInstance with different baseDir warning
// ---------------------------------------------------------------------------

describe('ProjectIndex getInstance baseDir warning', () => {
  beforeEach(() => {
    ProjectIndex._resetInstance();
  });

  afterEach(async () => {
    const inst = ProjectIndex.getInstance();
    await inst.forceFlush().catch(() => {});
    ProjectIndex._resetInstance();
  });

  test('returns existing instance when called with different baseDir', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'gv-pi-dir1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'gv-pi-dir2-'));
    try {
      const a = ProjectIndex.getInstance(dir1);
      const b = ProjectIndex.getInstance(dir2);
      // Should return the same instance (dir2 is ignored)
      expect(a).toBe(b);
      // baseDir should still be dir1
      expect(a.baseDir).toBe(dir1);
    } finally {
      ProjectIndex._resetInstance();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
