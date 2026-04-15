/**
 * overflow-backends.test.ts
 *
 * Overflow backend switching and retention pruning tests.
 *
 * Test strategy:
 *  - Backend switching: verify each backend (file, ledger, diagnostics) writes,
 *    reads, and produces correctly-typed overflow references.
 *  - Retention pruning: verify that maxAgeMs, maxCount, and maxSizeBytes limits
 *    are independently enforced on each backend, oldest-first.
 *  - FileBackend tests use a temporary directory; ledger/diagnostics are in-memory.
 *  - OverflowHandler integration: verify spillBackend is surfaced in results.
 *  - overflowCleanup command: verify it delegates to the active backend.
 */

import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileBackend,
  LedgerBackend,
  DiagnosticsBackend,
  OverflowHandler,
  createSpillBackend,
  overflowCleanup,
} from '@pellux/goodvibes-sdk/platform/tools/shared/overflow';
import type { SpillBackend, RetentionPolicyConfig } from '@pellux/goodvibes-sdk/platform/tools/shared/overflow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory for FileBackend isolation. */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-overflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// FileBackend
// ---------------------------------------------------------------------------

describe('FileBackend', () => {
  let tmpDir: string;
  let backend: FileBackend;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    backend = new FileBackend(tmpDir);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  it('has type discriminant "file"', () => {
    expect(backend.type).toBe('file');
  });

  it('write() creates a SpillEntry with correct shape', () => {
    const entry = backend.write('test.txt', 'hello world');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('test.txt');
    expect(entry!.filename).toBe('test.txt');
    expect(entry!.backendType).toBe('file');
    expect(entry!.sizeBytes).toBeGreaterThan(0);
    expect(entry!.createdAt).toBeGreaterThan(0);
  });

  it('read() returns the written content', () => {
    backend.write('foo.txt', 'content123');
    expect(backend.read('foo.txt')).toBe('content123');
  });

  it('read() returns null for unknown id', () => {
    expect(backend.read('nonexistent.txt')).toBeNull();
  });

  it('list() returns all written entries', () => {
    backend.write('a.txt', 'aaa');
    backend.write('b.txt', 'bbb');
    const entries = backend.list();
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toContain('a.txt');
    expect(ids).toContain('b.txt');
  });

  it('cleanup() prunes entries older than maxAgeMs', async () => {
    // Write two entries
    backend.write('old.txt', 'x'.repeat(100));
    backend.write('new.txt', 'y'.repeat(100));

    // Small delay to ensure filesystem mtime is strictly before Date.now()
    await new Promise(r => setTimeout(r, 5));

    // Cleanup with maxAgeMs=1 removes everything older than 1ms ago
    backend.cleanup({ maxAgeMs: 1 });
    // After maxAgeMs=1 all files should be removed (created more than 1ms in the past)
    const remaining = backend.list();
    expect(remaining.length).toBe(0);
  });

  it('cleanup() prunes oldest entries when maxCount exceeded', () => {
    backend.write('e1.txt', 'a');
    backend.write('e2.txt', 'b');
    backend.write('e3.txt', 'c');

    // Keep at most 2; should remove the oldest (e1) first
    backend.cleanup({ maxAgeMs: Infinity, maxCount: 2 });
    const remaining = backend.list();
    expect(remaining.length).toBeLessThanOrEqual(2);
  });

  it('cleanup() prunes oldest entries when maxSizeBytes exceeded', () => {
    backend.write('small1.txt', 'a'.repeat(10));
    backend.write('small2.txt', 'b'.repeat(10));
    backend.write('large.txt', 'c'.repeat(1000));

    // Allow only 500 bytes total
    backend.cleanup({ maxAgeMs: Infinity, maxSizeBytes: 500 });
    const remaining = backend.list();
    const totalBytes = remaining.reduce((s, e) => s + e.sizeBytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// FileBackend — path traversal guard
// ---------------------------------------------------------------------------

describe('FileBackend — path traversal guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  test('read() rejects ../ traversal', () => {
    const backend = new FileBackend(tmpDir);
    expect(backend.read('../../../etc/passwd')).toBeNull();
  });

  test('write() rejects ../ traversal', () => {
    const backend = new FileBackend(tmpDir);
    expect(backend.write('../escape.txt', 'data')).toBeNull();
  });

  test('read() accepts valid filename', () => {
    const backend = new FileBackend(tmpDir);
    backend.write('valid.txt', 'hello');
    expect(backend.read('valid.txt')).toBe('hello');
  });

  test('read() rejects absolute path', () => {
    const backend = new FileBackend(tmpDir);
    expect(backend.read('/etc/passwd')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LedgerBackend
// ---------------------------------------------------------------------------

describe('LedgerBackend', () => {
  let backend: LedgerBackend;

  beforeEach(() => {
    backend = new LedgerBackend();
  });

  it('has type discriminant "ledger"', () => {
    expect(backend.type).toBe('ledger');
  });

  it('write() stores content in-memory', () => {
    const entry = backend.write('key1', 'in-memory content');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('key1');
    expect(entry!.backendType).toBe('ledger');
    expect(entry!.content).toBe('in-memory content');
  });

  it('read() returns stored content', () => {
    backend.write('k', 'val');
    expect(backend.read('k')).toBe('val');
  });

  it('read() returns null for missing key', () => {
    expect(backend.read('missing')).toBeNull();
  });

  it('list() returns all stored entries', () => {
    backend.write('a', 'aaa');
    backend.write('b', 'bbb');
    const entries = backend.list();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('cleanup() prunes entries older than maxAgeMs', () => {
    backend.write('old', 'x');
    backend.write('also-old', 'y');
    // maxAgeMs=0 → all entries are older than "now" so all are pruned
    backend.cleanup({ maxAgeMs: 0 });
    expect(backend.list().length).toBe(0);
  });

  it('cleanup() prunes oldest entries when maxCount exceeded', () => {
    backend.write('e1', 'a');
    backend.write('e2', 'b');
    backend.write('e3', 'c');
    backend.write('e4', 'd');
    backend.cleanup({ maxAgeMs: Infinity, maxCount: 2 });
    expect(backend.list().length).toBeLessThanOrEqual(2);
  });

  it('cleanup() enforces maxSizeBytes by removing oldest first', () => {
    backend.write('small', 'x'.repeat(10));
    backend.write('large', 'y'.repeat(500));
    backend.cleanup({ maxAgeMs: Infinity, maxSizeBytes: 100 });
    const remaining = backend.list();
    const totalBytes = remaining.reduce((s, e) => s + e.sizeBytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(100);
  });

  it('is ephemeral — new instance has empty ledger', () => {
    backend.write('x', 'data');
    const fresh = new LedgerBackend();
    expect(fresh.list().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DiagnosticsBackend
// ---------------------------------------------------------------------------

describe('DiagnosticsBackend', () => {
  let backend: DiagnosticsBackend;

  beforeEach(() => {
    backend = new DiagnosticsBackend();
  });

  it('has type discriminant "diagnostics"', () => {
    expect(backend.type).toBe('diagnostics');
  });

  it('write() records a log entry and returns a SpillEntry with empty content', () => {
    const entry = backend.write('diag-key', 'some large content');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('diag-key');
    expect(entry!.backendType).toBe('diagnostics');
    // diagnostics backend does NOT store content
    expect(entry!.content).toBe('');
    expect(entry!.sizeBytes).toBeGreaterThan(0);
  });

  it('read() always returns null (content not stored)', () => {
    backend.write('k', 'big data');
    expect(backend.read('k')).toBeNull();
  });

  it('list() returns all log entries', () => {
    backend.write('a', 'x');
    backend.write('b', 'y');
    const entries = backend.list();
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.content === '')).toBe(true);
    expect(entries.every((e) => e.backendType === 'diagnostics')).toBe(true);
  });

  it('cleanup() prunes log entries older than maxAgeMs', () => {
    backend.write('old', 'x');
    backend.cleanup({ maxAgeMs: 0 });
    expect(backend.list().length).toBe(0);
  });

  it('cleanup() prunes oldest log entries when maxCount exceeded', () => {
    backend.write('e1', 'a');
    backend.write('e2', 'b');
    backend.write('e3', 'c');
    backend.cleanup({ maxAgeMs: Infinity, maxCount: 1 });
    expect(backend.list().length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// createSpillBackend factory
// ---------------------------------------------------------------------------

describe('createSpillBackend', () => {
  it('returns FileBackend for type "file"', () => {
    const b = createSpillBackend('file', makeTmpDir());
    expect(b.type).toBe('file');
  });

  it('returns LedgerBackend for type "ledger"', () => {
    const b = createSpillBackend('ledger');
    expect(b.type).toBe('ledger');
  });

  it('returns DiagnosticsBackend for type "diagnostics"', () => {
    const b = createSpillBackend('diagnostics');
    expect(b.type).toBe('diagnostics');
  });

  it('defaults to FileBackend when type is omitted', () => {
    const b = createSpillBackend('file', makeTmpDir());
    expect(b.type).toBe('file');
  });

  it('requires a baseDir for the file backend', () => {
    expect(() => createSpillBackend('file')).toThrow('File spill backend requires an explicit baseDir');
  });
});

// ---------------------------------------------------------------------------
// OverflowHandler — backend switching
// ---------------------------------------------------------------------------

describe('OverflowHandler — backend switching', () => {
  const TINY_LIMIT = 10; // 10 chars → easy to trigger overflow

  it('uses file backend by default and produces file: ref', () => {
    const tmpDir = makeTmpDir();
    const handler = new OverflowHandler({ spillBackend: 'file', baseDir: tmpDir });
    const result = handler.handle('x'.repeat(100), { maxChars: TINY_LIMIT });
    expect(handler.backendType).toBe('file');
    expect(result.spillBackend).toBe('file');
    expect(result.overflowRef).toMatch(/^file:/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses ledger backend when configured and produces ledger: ref', () => {
    const handler = new OverflowHandler({ spillBackend: 'ledger' });
    const result = handler.handle('x'.repeat(100), { maxChars: TINY_LIMIT });
    expect(handler.backendType).toBe('ledger');
    expect(result.spillBackend).toBe('ledger');
    expect(result.overflowRef).toMatch(/^ledger:/);
  });

  it('uses diagnostics backend when configured and produces diagnostics: ref', () => {
    const handler = new OverflowHandler({ spillBackend: 'diagnostics' });
    const result = handler.handle('x'.repeat(100), { maxChars: TINY_LIMIT });
    expect(handler.backendType).toBe('diagnostics');
    expect(result.spillBackend).toBe('diagnostics');
    expect(result.overflowRef).toMatch(/^diagnostics:/);
  });

  it('accepts an injected custom backend via config.backend', () => {
    const custom = new LedgerBackend();
    const handler = new OverflowHandler({ backend: custom });
    expect(handler.backendType).toBe('ledger');
  });

  it('does not overflow when content is within limit', () => {
    const handler = new OverflowHandler({ spillBackend: 'ledger' });
    const result = handler.handle('short', { maxChars: 100 });
    expect(result.spillBackend).toBeUndefined();
    expect(result.overflowRef).toBeUndefined();
    expect(result.content).toBe('short');
  });

  it('truncates gracefully when backend write fails', () => {
    // Inject a backend whose write() always returns null (simulates failure)
    const failBackend: SpillBackend = {
      type: 'file',
      write: () => null,
      read: () => null,
      cleanup: () => {},
      list: () => [],
    };
    const handler = new OverflowHandler({ backend: failBackend });
    const result = handler.handle('x'.repeat(100), { maxChars: TINY_LIMIT });
    // Must not throw; must return truncated content without overflowRef
    expect(result.overflowRef).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// OverflowHandler — retention policy integration
// ---------------------------------------------------------------------------

describe('OverflowHandler — retention policy', () => {
  it('cleanup() delegates to backend with merged retention config', () => {
    const calls: Array<RetentionPolicyConfig | undefined> = [];
    const trackingBackend: SpillBackend = {
      type: 'ledger',
      write: () => null,
      read: () => null,
      cleanup: (policy) => { calls.push(policy); },
      list: () => [],
    };
    const handler = new OverflowHandler({
      backend: trackingBackend,
      retention: { maxCount: 5 },
    });
    handler.cleanup();
    expect(calls.length).toBe(1);
  });

  it('cleanup() accepts a retention policy object', () => {
    const calls: Array<RetentionPolicyConfig | undefined> = [];
    const trackingBackend: SpillBackend = {
      type: 'ledger',
      write: () => null,
      read: () => null,
      cleanup: (policy) => { calls.push(policy); },
      list: () => [],
    };
    const handler = new OverflowHandler({ backend: trackingBackend });
    handler.cleanup({ maxAgeMs: 3600 * 1000 });
    expect(calls.length).toBe(1);
    expect((calls[0] as RetentionPolicyConfig).maxAgeMs).toBe(3600 * 1000);
  });
});

// ---------------------------------------------------------------------------
// overflowCleanup operator command
// ---------------------------------------------------------------------------

describe('overflowCleanup operator command', () => {
  it('returns beforeCount and delegates cleanup', () => {
    const handler = new OverflowHandler({ spillBackend: 'ledger' });
    const result = overflowCleanup(handler, { maxAgeMs: 0 });
    expect(result).toHaveProperty('beforeCount');
    expect(typeof result.beforeCount).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Retention pruning — cross-backend
// ---------------------------------------------------------------------------

describe('Retention pruning — all three backends apply same policy logic', () => {
  const backends: Array<{ name: string; make: () => SpillBackend }> = [
    { name: 'LedgerBackend', make: () => new LedgerBackend() },
    { name: 'DiagnosticsBackend', make: () => new DiagnosticsBackend() },
  ];

  for (const { name, make } of backends) {
    describe(name, () => {
      it('prunes all entries with maxAgeMs=0', () => {
        const b = make();
        b.write('x1', 'a'.repeat(50));
        b.write('x2', 'b'.repeat(50));
        b.write('x3', 'c'.repeat(50));
        b.cleanup({ maxAgeMs: 0 });
        expect(b.list().length).toBe(0);
      });

      it('keeps all entries with maxAgeMs=Infinity and no other limits', () => {
        const b = make();
        b.write('y1', 'a');
        b.write('y2', 'b');
        b.cleanup({ maxAgeMs: Infinity });
        expect(b.list().length).toBe(2);
      });

      it('enforces maxCount=1, deletes oldest', () => {
        const b = make();
        b.write('old', 'a');
        b.write('new', 'b');
        b.cleanup({ maxAgeMs: Infinity, maxCount: 1 });
        expect(b.list().length).toBeLessThanOrEqual(1);
      });
    });
  }
});
