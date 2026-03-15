import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '../../tools/write/index.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'gv-write-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Runs the write tool with CWD patched to tmpDir so resolveAndValidatePath works.
 */
async function runWrite(
  tmpDir: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const orig = process.cwd();
  process.chdir(tmpDir);
  const tool = createWriteTool();
  try {
    const result = await tool.execute(args);
    return result as Record<string, unknown>;
  } finally {
    process.chdir(orig);
  }
}

async function runWriteWithState(
  tmpDir: string,
  args: Record<string, unknown>,
  fileCache: FileStateCache,
  projectIndex: ProjectIndex,
): Promise<Record<string, unknown>> {
  const orig = process.cwd();
  process.chdir(tmpDir);
  const tool = createWriteTool({ fileCache, projectIndex });
  try {
    const result = await tool.execute(args);
    return result as Record<string, unknown>;
  } finally {
    process.chdir(orig);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('write tool', () => {
  let tmpDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await makeTempDir();
    tmpDir = t.dir;
    cleanup = t.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Basic writes
  // -------------------------------------------------------------------------

  describe('single file write', () => {
    test('writes a single file', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'hello.txt', content: 'Hello, world!' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'hello.txt'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'hello.txt'), 'utf-8')).toBe('Hello, world!');
    });

    test('writes empty content', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'empty.txt', content: '' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'empty.txt'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'empty.txt'), 'utf-8')).toBe('');
    });

    test('writes file when content is omitted (empty)', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'noContent.txt' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'noContent.txt'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'noContent.txt'), 'utf-8')).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Base64 content
  // -------------------------------------------------------------------------

  describe('base64 content', () => {
    test('writes file using content_base64', async () => {
      const original = 'Hello with special chars: `backtick` and ${var}';
      const encoded = Buffer.from(original, 'utf-8').toString('base64');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'b64.txt', content_base64: encoded }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(join(tmpDir, 'b64.txt'), 'utf-8')).toBe(original);
    });

    test('content_base64 takes priority over content', async () => {
      const decoded = 'from base64';
      const encoded = Buffer.from(decoded, 'utf-8').toString('base64');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'priority.txt', content: 'from content', content_base64: encoded }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(join(tmpDir, 'priority.txt'), 'utf-8')).toBe(decoded);
    });
  });

  // -------------------------------------------------------------------------
  // Batch writes
  // -------------------------------------------------------------------------

  describe('batch write', () => {
    test('writes multiple files in one call', async () => {
      const result = await runWrite(tmpDir, {
        files: [
          { path: 'a.ts', content: 'export const a = 1;' },
          { path: 'b.ts', content: 'export const b = 2;' },
          { path: 'c.ts', content: 'export const c = 3;' },
        ],
      });
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output as string);
      expect(output.files_written).toBe(3);
      expect(existsSync(join(tmpDir, 'a.ts'))).toBe(true);
      expect(existsSync(join(tmpDir, 'b.ts'))).toBe(true);
      expect(existsSync(join(tmpDir, 'c.ts'))).toBe(true);
    });

    test('partial success: continues on error, reports partial', async () => {
      // Pre-create one file to trigger fail_if_exists
      await Bun.write(join(tmpDir, 'existing.ts'), 'old');
      const result = await runWrite(tmpDir, {
        files: [
          { path: 'new.ts', content: 'new file' },
          { path: 'existing.ts', content: 'conflict', mode: 'fail_if_exists' },
        ],
      });
      // new.ts succeeded, existing.ts failed
      expect(existsSync(join(tmpDir, 'new.ts'))).toBe(true);
      const output = JSON.parse(result.output as string);
      expect(output.files_written).toBe(1);
      expect(output.errors).toBeDefined();
      expect(output.errors.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Mode: fail_if_exists
  // -------------------------------------------------------------------------

  describe('mode: fail_if_exists', () => {
    test('errors when file already exists', async () => {
      await Bun.write(join(tmpDir, 'existing.txt'), 'original');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'existing.txt', content: 'new' }],
      });
      expect(result.success).toBe(false);
      expect(result.error as string).toContain('already exists');
    });

    test('succeeds when file does not exist (default mode)', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'brand-new.txt', content: 'fresh' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(join(tmpDir, 'brand-new.txt'), 'utf-8')).toBe('fresh');
    });

    test('explicit fail_if_exists is same as default', async () => {
      await Bun.write(join(tmpDir, 'foo.txt'), 'original');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'foo.txt', content: 'new', mode: 'fail_if_exists' }],
      });
      expect(result.success).toBe(false);
      // original content unchanged
      expect(readFileSync(join(tmpDir, 'foo.txt'), 'utf-8')).toBe('original');
    });
  });

  // -------------------------------------------------------------------------
  // Mode: overwrite
  // -------------------------------------------------------------------------

  describe('mode: overwrite', () => {
    test('replaces existing file', async () => {
      await Bun.write(join(tmpDir, 'target.txt'), 'old content');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'target.txt', content: 'new content', mode: 'overwrite' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(join(tmpDir, 'target.txt'), 'utf-8')).toBe('new content');
    });

    test('creates new file when it does not exist', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'new.txt', content: 'created', mode: 'overwrite' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(join(tmpDir, 'new.txt'), 'utf-8')).toBe('created');
    });
  });

  // -------------------------------------------------------------------------
  // Mode: backup
  // -------------------------------------------------------------------------

  describe('mode: backup', () => {
    test('creates backup copy before overwriting', async () => {
      await Bun.write(join(tmpDir, 'important.ts'), 'original code');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'important.ts', content: 'new code', mode: 'backup' }],
        verbosity: 'minimal',
      });
      expect(result.success).toBe(true);
      // New content written
      expect(readFileSync(join(tmpDir, 'important.ts'), 'utf-8')).toBe('new code');
      // Backup file exists and contains original content
      const output = JSON.parse(result.output as string);
      const fileResult = output.files?.[0];
      expect(fileResult).toBeDefined();
      expect(fileResult.backup_path).toBeDefined();
      expect(existsSync(fileResult.backup_path)).toBe(true);
      expect(readFileSync(fileResult.backup_path, 'utf-8')).toBe('original code');
    });

    test('backup path is reported in minimal verbosity', async () => {
      await Bun.write(join(tmpDir, 'file.ts'), 'original');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'file.ts', content: 'updated', mode: 'backup' }],
        verbosity: 'minimal',
      });
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output as string);
      expect(output.files).toBeDefined();
      expect(output.files[0].backup_path).toBeDefined();
      expect(existsSync(output.files[0].backup_path)).toBe(true);
      const backupContent = readFileSync(output.files[0].backup_path, 'utf-8');
      expect(backupContent).toBe('original');
    });

    test('creates new file without backup when it does not exist', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'fresh.ts', content: 'new', mode: 'backup' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'fresh.ts'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-mkdir
  // -------------------------------------------------------------------------

  describe('auto-mkdir', () => {
    test('creates parent directories automatically', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'deep/nested/dir/file.ts', content: 'nested' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'deep/nested/dir/file.ts'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'deep/nested/dir/file.ts'), 'utf-8')).toBe('nested');
    });

    test('works with multiple levels of missing dirs', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'a/b/c/d/e.txt', content: 'deep' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'a/b/c/d/e.txt'))).toBe(true);
    });

    test('works when parent dir already exists', async () => {
      mkdirSync(join(tmpDir, 'existing-dir'));
      const result = await runWrite(tmpDir, {
        files: [{ path: 'existing-dir/file.ts', content: 'content' }],
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'existing-dir/file.ts'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Atomic write
  // -------------------------------------------------------------------------

  describe('atomic write', () => {
    test('no temp file remains after successful write', async () => {
      await runWrite(tmpDir, {
        files: [{ path: 'atomic.ts', content: 'data' }],
      });
      // Check that no .tmp.* file lingers
      const files = await Bun.file(tmpDir).text().catch(() => '');
      const tmpFiles = (await import('node:fs')).readdirSync(tmpDir).filter((f) =>
        f.includes('.tmp.'),
      );
      expect(tmpFiles).toHaveLength(0);
    });

    test('file has correct content (atomic rename worked)', async () => {
      const bigContent = 'x'.repeat(10000);
      await runWrite(tmpDir, {
        files: [{ path: 'big.ts', content: bigContent }],
      });
      expect(readFileSync(join(tmpDir, 'big.ts'), 'utf-8')).toBe(bigContent);
    });
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  describe('dry_run', () => {
    test('does not write file when dry_run is true', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'dry.ts', content: 'should not write' }],
        dry_run: true,
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(tmpDir, 'dry.ts'))).toBe(false);
    });

    test('returns dry_run flag in output', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'dry2.ts', content: 'x' }],
        dry_run: true,
      });
      const output = JSON.parse(result.output as string);
      expect(output.dry_run).toBe(true);
    });

    test('dry run still validates paths (path traversal blocked in dry run)', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: '../outside.ts', content: 'escape' }],
        dry_run: true,
      });
      // Should fail path validation
      expect(result.success).toBe(false);
    });

    test('dry run reports would-write in minimal verbosity', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'plan.ts', content: 'planned' }],
        dry_run: true,
        verbosity: 'minimal',
      });
      const output = JSON.parse(result.output as string);
      expect(output.files).toBeDefined();
      expect(output.files[0].would_write).toBe(true);
    });

    test('dry run with backup mode reports would-be backup path', async () => {
      await Bun.write(join(tmpDir, 'exists.ts'), 'original');
      const result = await runWrite(tmpDir, {
        files: [{ path: 'exists.ts', content: 'new', mode: 'backup' }],
        dry_run: true,
        verbosity: 'minimal',
      });
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output as string);
      expect(output.files[0].backup_path).toBeDefined();
      // Backup file should NOT actually exist (dry run)
      expect(existsSync(output.files[0].backup_path)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Path safety
  // -------------------------------------------------------------------------

  describe('path safety', () => {
    test('blocks path traversal (../)', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: '../escape.ts', content: 'bad' }],
      });
      expect(result.success).toBe(false);
      expect(result.error as string).toContain('outside');
    });

    test('blocks deep traversal', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'a/../../escape.ts', content: 'bad' }],
      });
      expect(result.success).toBe(false);
    });

    test('allows paths within project root', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'subdir/file.ts', content: 'ok' }],
      });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Encoding and base64 validation
  // -------------------------------------------------------------------------

  describe('encoding and base64 validation', () => {
    test('returns error for invalid encoding', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'enc.txt', content: 'hello', encoding: 'not-a-real-encoding' }],
      });
      expect(result.success).toBe(false);
      expect(result.error as string).toContain('Invalid encoding');
    });

    test('returns error for invalid base64', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'b64.txt', content_base64: '!!!not-valid-base64!!!' }],
      });
      expect(result.success).toBe(false);
      expect(result.error as string).toContain('Invalid base64');
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    test('errors when files array is empty', async () => {
      const result = await runWrite(tmpDir, { files: [] });
      expect(result.success).toBe(false);
      expect(result.error as string).toContain('non-empty');
    });

    test('errors when files is missing', async () => {
      const result = await runWrite(tmpDir, {});
      expect(result.success).toBe(false);
    });

    test('errors when file entry has missing path', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ content: 'no path here' }],
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // State integration
  // -------------------------------------------------------------------------

  describe('state integration', () => {
    test('updates fileCache after successful write', async () => {
      const fileCache = new FileStateCache();
      const projectIndex = ProjectIndex.getInstance(tmpDir);
      ProjectIndex._resetInstance();
      const freshIndex = ProjectIndex.getInstance(tmpDir);

      const result = await runWriteWithState(
        tmpDir,
        { files: [{ path: 'cached.ts', content: 'export const x = 1;' }] },
        fileCache,
        freshIndex,
      );

      expect(result.success).toBe(true);
      const absPath = join(tmpDir, 'cached.ts');
      const { status, entry } = fileCache.lookup(absPath);
      expect(status).toBe('unchanged');
      expect(entry).toBeDefined();
      expect(entry!.byteSize).toBeGreaterThan(0);

      ProjectIndex._resetInstance();
    });

    test('updates projectIndex after successful write', async () => {
      ProjectIndex._resetInstance();
      const fileCache = new FileStateCache();
      const freshIndex = ProjectIndex.getInstance(tmpDir);

      const result = await runWriteWithState(
        tmpDir,
        { files: [{ path: 'indexed.ts', content: 'export const y = 2;' }] },
        fileCache,
        freshIndex,
      );

      expect(result.success).toBe(true);
      const entry = freshIndex.getFile('indexed.ts');
      expect(entry).not.toBeNull();
      expect(entry!.tokens).toBeGreaterThan(0);

      ProjectIndex._resetInstance();
    });

    test('does NOT update state during dry run', async () => {
      ProjectIndex._resetInstance();
      const fileCache = new FileStateCache();
      const freshIndex = ProjectIndex.getInstance(tmpDir);

      await runWriteWithState(
        tmpDir,
        { files: [{ path: 'drystate.ts', content: 'x' }], dry_run: true },
        fileCache,
        freshIndex,
      );

      const absPath = join(tmpDir, 'drystate.ts');
      const { status } = fileCache.lookup(absPath);
      expect(status).toBe('miss');
      expect(freshIndex.getFile('drystate.ts')).toBeNull();

      ProjectIndex._resetInstance();
    });
  });

  // -------------------------------------------------------------------------
  // Verbosity
  // -------------------------------------------------------------------------

  describe('verbosity', () => {
    test('count_only returns minimal output (default)', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'v1.ts', content: 'x' }],
      });
      const output = JSON.parse(result.output as string);
      expect(output.files_written).toBe(1);
      expect(output.bytes_written).toBeGreaterThan(0);
      expect(output.files).toBeUndefined();
    });

    test('minimal verbosity includes file paths', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'v2.ts', content: 'export const v = 2;' }],
        verbosity: 'minimal',
      });
      const output = JSON.parse(result.output as string);
      expect(output.files).toBeDefined();
      expect(output.files).toHaveLength(1);
      expect(output.files[0].path).toBe('v2.ts');
      expect(output.files[0].bytes_written).toBeGreaterThan(0);
    });

    test('standard verbosity includes mode_applied', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'v3.ts', content: 'x', mode: 'overwrite' }],
        verbosity: 'standard',
      });
      const output = JSON.parse(result.output as string);
      expect(output.files).toBeDefined();
      expect(output.files[0].mode_applied).toBe('overwrite');
    });

    test('verbose verbosity includes all fields', async () => {
      const result = await runWrite(tmpDir, {
        files: [{ path: 'v4.ts', content: 'hello' }],
        verbosity: 'verbose',
      });
      const output = JSON.parse(result.output as string);
      expect(output.files).toBeDefined();
      expect(output.files[0].resolved_path).toBeDefined();
    });
  });
});
