import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverflowHandler } from '../../../tools/shared/overflow.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir and return its path. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'overflow-test-'));
}

/** Generate a string of length n. */
function makeString(n: number): string {
  return 'x'.repeat(n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OverflowHandler — passthrough for small content', () => {
  let tmpDir: string;
  let handler: OverflowHandler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    handler = new OverflowHandler(tmpDir);
  });

  test('returns content unchanged when at exactly maxChars', () => {
    const content = makeString(50_000);
    const result = handler.handle(content);
    expect(result.content).toBe(content);
    expect(result.overflowRef).toBeUndefined();
  });

  test('returns content unchanged when below maxChars', () => {
    const content = 'small content';
    const result = handler.handle(content);
    expect(result.content).toBe(content);
    expect(result.overflowRef).toBeUndefined();
  });

  test('returns content unchanged when below custom maxChars', () => {
    const content = makeString(100);
    const result = handler.handle(content, { maxChars: 200 });
    expect(result.content).toBe(content);
    expect(result.overflowRef).toBeUndefined();
  });

  test('does not create overflow dir for small content', () => {
    const content = 'tiny';
    handler.handle(content);
    expect(existsSync(join(tmpDir, '.goodvibes', '.overflow'))).toBe(false);
  });
});

describe('OverflowHandler — overflow file creation for large content', () => {
  let tmpDir: string;
  let handler: OverflowHandler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    handler = new OverflowHandler(tmpDir);
  });

  test('truncates content at maxChars', () => {
    const content = makeString(60_000);
    const result = handler.handle(content);
    expect(result.content.startsWith(makeString(50_000))).toBe(true);
    expect(result.content).toContain('[... truncated');
  });

  test('writes full content to overflow file', () => {
    const content = makeString(60_000);
    const result = handler.handle(content);

    expect(result.overflowRef).toBeDefined();
    const overflowPath = join(tmpDir, result.overflowRef!);
    expect(existsSync(overflowPath)).toBe(true);

    const written = readFileSync(overflowPath, 'utf-8');
    expect(written).toBe(content);
  });

  test('overflow ref is included in returned content', () => {
    const content = makeString(60_000);
    const result = handler.handle(content);

    expect(result.overflowRef).toBeDefined();
    expect(result.content).toContain(result.overflowRef!);
  });

  test('auto-creates .goodvibes/.overflow directory', () => {
    const content = makeString(60_000);
    handler.handle(content);
    expect(existsSync(join(tmpDir, '.goodvibes', '.overflow'))).toBe(true);
  });

  test('uses custom maxChars', () => {
    const content = makeString(500);
    const result = handler.handle(content, { maxChars: 100 });
    expect(result.content.length).toBeLessThan(content.length);
    expect(result.overflowRef).toBeDefined();
    expect(result.content.startsWith(makeString(100))).toBe(true);
  });

  test('filename contains timestamp and label', () => {
    const content = makeString(60_000);
    const result = handler.handle(content, { label: 'my stdout' });

    expect(result.overflowRef).toBeDefined();
    const filename = result.overflowRef!.split('/').pop()!;
    expect(filename).toMatch(/^\d+-my-stdout\.txt$/);
  });

  test('creates multiple overflow files for multiple calls', () => {
    const content = makeString(60_000);
    handler.handle(content, { label: 'first' });
    // Ensure different timestamps
    handler.handle(content, { label: 'second' });
    const files = readdirSync(join(tmpDir, '.goodvibes', '.overflow'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
});

describe('OverflowHandler — label sanitization', () => {
  let tmpDir: string;
  let handler: OverflowHandler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    handler = new OverflowHandler(tmpDir);
  });

  test('sanitizes label to lowercase alphanumeric with hyphens', () => {
    const content = makeString(60_000);
    const result = handler.handle(content, { label: 'My Tool OUTPUT!' });
    const filename = result.overflowRef!.split('/').pop()!;
    // Should be lowercase, no special chars
    expect(filename).toMatch(/^\d+-my-tool-output\.txt$/);
  });

  test('truncates label to 40 chars', () => {
    const content = makeString(60_000);
    const longLabel = 'a'.repeat(100);
    const result = handler.handle(content, { label: longLabel });
    const filename = result.overflowRef!.split('/').pop()!;
    // format: {timestamp}-{label}.txt
    const labelPart = filename.replace(/^\d+-/, '').replace(/\.txt$/, '');
    expect(labelPart.length).toBeLessThanOrEqual(40);
  });

  test('uses default label when none provided', () => {
    const content = makeString(60_000);
    const result = handler.handle(content);
    const filename = result.overflowRef!.split('/').pop()!;
    expect(filename).toMatch(/^\d+-output\.txt$/);
  });

  test('handles empty label gracefully', () => {
    const content = makeString(60_000);
    const result = handler.handle(content, { label: '' });
    expect(result.overflowRef).toBeDefined();
    const filename = result.overflowRef!.split('/').pop()!;
    // Empty label sanitizes to empty string, falls back gracefully
    expect(filename).toMatch(/\.txt$/);
  });
});

describe('OverflowHandler — cleanup of old files', () => {
  let tmpDir: string;
  let handler: OverflowHandler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    handler = new OverflowHandler(tmpDir);
  });

  test('cleanup removes files older than maxAge', () => {
    const content = makeString(60_000);
    handler.handle(content, { label: 'old' });

    const overflowDir = join(tmpDir, '.goodvibes', '.overflow');
    const files = readdirSync(overflowDir);
    expect(files.length).toBe(1);

    // Backdate the file's mtime to 2 hours ago
    const filePath = join(overflowDir, files[0]);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(filePath, twoHoursAgo, twoHoursAgo);

    handler.cleanup(60 * 60 * 1000); // 1 hour max age
    expect(existsSync(filePath)).toBe(false);
  });

  test('cleanup keeps files newer than maxAge', () => {
    const content = makeString(60_000);
    const result = handler.handle(content, { label: 'new' });

    handler.cleanup(60 * 60 * 1000); // 1 hour max age

    // File was just created — should still exist
    const filePath = join(tmpDir, result.overflowRef!);
    expect(existsSync(filePath)).toBe(true);
  });

  test('cleanup does nothing when overflow dir does not exist', () => {
    // No overflow files created, dir doesn't exist
    expect(() => handler.cleanup()).not.toThrow();
  });

  test('cleanup uses default 1-hour max age', () => {
    const content = makeString(60_000);
    handler.handle(content, { label: 'stale' });

    const overflowDir = join(tmpDir, '.goodvibes', '.overflow');
    const files = readdirSync(overflowDir);
    const filePath = join(overflowDir, files[0]);

    // Backdate to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(filePath, twoHoursAgo, twoHoursAgo);

    handler.cleanup(); // Default 1 hour
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('OverflowHandler — list', () => {
  let tmpDir: string;
  let handler: OverflowHandler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    handler = new OverflowHandler(tmpDir);
  });

  test('list returns empty array when no overflow files', () => {
    const files = handler.list();
    expect(files).toEqual([]);
  });

  test('list returns overflow file info', () => {
    const content = makeString(60_000);
    handler.handle(content, { label: 'test' });

    const files = handler.list();
    expect(files.length).toBe(1);
    expect(files[0].filename).toMatch(/^\d+-test\.txt$/);
    expect(files[0].sizeBytes).toBe(60_000);
    expect(typeof files[0].createdAt).toBe('number');
    expect(existsSync(files[0].path)).toBe(true);
  });

  test('list returns multiple overflow files', () => {
    const content = makeString(60_000);
    handler.handle(content, { label: 'alpha' });
    handler.handle(content, { label: 'beta' });

    const files = handler.list();
    expect(files.length).toBe(2);
  });
});

describe('OverflowHandler — never throws on write failure', () => {
  test('returns truncated content without ref when write fails', () => {
    // Use a path that cannot be created (file exists where dir should be)
    const tmpDir = makeTmpDir();
    // Create a file at the path where .goodvibes should be — blocks dir creation
    writeFileSync(join(tmpDir, '.goodvibes'), 'blocker');
    const handler = new OverflowHandler(tmpDir);

    const content = makeString(60_000);
    // Should not throw
    let result: ReturnType<OverflowHandler['handle']>;
    expect(() => {
      result = handler.handle(content);
    }).not.toThrow();

    // Should have truncated content but no ref
    expect(result!.content).toContain('[... truncated');
    expect(result!.overflowRef).toBeUndefined();
  });
});
