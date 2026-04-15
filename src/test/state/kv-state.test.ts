import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { KVState } from '@pellux/goodvibes-sdk/platform/state/kv-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-kv-test-'));
}

function stateDirFor(root: string): string {
  return join(root, '.goodvibes', 'state');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('KVState', () => {
  let tmpDir: string;
  let kv: KVState;

  function createKVState(sessionId?: string): KVState {
    return new KVState({
      ...(sessionId ? { sessionId } : {}),
      stateDir: stateDirFor(tmpDir),
    });
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kv = createKVState();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Session ID
  // -------------------------------------------------------------------------

  describe('session ID', () => {
    test('requires an explicit state directory or storage root', () => {
      expect(() => new KVState()).toThrow('KVState requires an explicit stateDir or storageRoot');
    });

    test('auto-generates an 8-char hex session ID', () => {
      const id = kv.getSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });

    test('uses provided session ID', () => {
      const custom = createKVState('abcd1234');
      expect(custom.getSessionId()).toBe('abcd1234');
    });

    test('different instances get different IDs', () => {
      const a = createKVState();
      const b = createKVState();
      // Very unlikely to collide
      expect(a.getSessionId()).not.toBe(b.getSessionId());
    });
  });

  // -------------------------------------------------------------------------
  // get / set
  // -------------------------------------------------------------------------

  describe('get and set', () => {
    test('set and get a single key', async () => {
      await kv.set({ foo: 'bar' });
      const result = await kv.get(['foo']);
      expect(result.foo).toBe('bar');
    });

    test('get returns only requested keys', async () => {
      await kv.set({ a: 1, b: 2, c: 3 });
      const result = await kv.get(['a', 'c']);
      expect(result).toEqual({ a: 1, c: 3 });
      expect(result.b).toBeUndefined();
    });

    test('get returns empty object for missing keys', async () => {
      const result = await kv.get(['nonexistent']);
      expect(result).toEqual({});
    });

    test('set overwrites existing key', async () => {
      await kv.set({ x: 'first' });
      await kv.set({ x: 'second' });
      const result = await kv.get(['x']);
      expect(result.x).toBe('second');
    });

    test('set multiple keys at once', async () => {
      await kv.set({ alpha: 1, beta: 2, gamma: 3 });
      const result = await kv.get(['alpha', 'beta', 'gamma']);
      expect(result).toEqual({ alpha: 1, beta: 2, gamma: 3 });
    });

    test('set supports nested objects as values', async () => {
      await kv.set({ config: { debug: true, level: 5 } });
      const result = await kv.get(['config']);
      expect(result.config).toEqual({ debug: true, level: 5 });
    });
  });

  // -------------------------------------------------------------------------
  // Reserved keys
  // -------------------------------------------------------------------------

  describe('reserved keys', () => {
    test('cannot set id key', async () => {
      await kv.set({ id: 'hacked' });
      // After load, id should be the session ID, not 'hacked'
      const result = await kv.get(['id']);
      expect(result.id).toBe(kv.getSessionId());
    });

    test('cannot set started_at key', async () => {
      await kv.set({ started_at: 'hacked' });
      const result = await kv.get(['started_at']);
      // Should not be 'hacked'
      expect(result.started_at).not.toBe('hacked');
    });

    test('cannot set __proto__ key', async () => {
      // Should not throw, just silently ignore
      await expect(kv.set({ __proto__: { evil: true } })).resolves.toBeUndefined();
    });

    test('cannot set constructor key', async () => {
      await expect(kv.set({ constructor: 'exploit' })).resolves.toBeUndefined();
    });

    test('cannot set prototype key', async () => {
      await expect(kv.set({ prototype: 'exploit' })).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe('list', () => {
    test('list returns all keys', async () => {
      await kv.set({ one: 1, two: 2 });
      const result = await kv.list();
      expect(result.one).toBe(1);
      expect(result.two).toBe(2);
    });

    test('list with prefix filters keys', async () => {
      await kv.set({ 'session.a': 1, 'session.b': 2, 'other.c': 3 });
      const result = await kv.list('session.');
      expect(result['session.a']).toBe(1);
      expect(result['session.b']).toBe(2);
      expect(result['other.c']).toBeUndefined();
    });

    test('list with non-matching prefix returns empty', async () => {
      await kv.set({ foo: 1 });
      const result = await kv.list('bar.');
      // Only reserved keys would match if prefix is 'bar.'
      expect(Object.keys(result).filter(k => k.startsWith('bar.'))).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    test('removes specified keys', async () => {
      await kv.set({ a: 1, b: 2, c: 3 });
      await kv.clear(['a', 'c']);
      const result = await kv.get(['a', 'b', 'c']);
      expect(result.a).toBeUndefined();
      expect(result.b).toBe(2);
      expect(result.c).toBeUndefined();
    });

    test('clear on missing key is a no-op', async () => {
      await expect(kv.clear(['nonexistent'])).resolves.toBeUndefined();
    });

    test('clear does not remove reserved keys', async () => {
      await kv.clear(['id', 'started_at']);
      const result = await kv.get(['id']);
      expect(result.id).toBe(kv.getSessionId());
    });
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    test('persist writes a file to disk', async () => {
      await kv.set({ persistTest: true });
      await kv.persist();
      const stateDir = join(tmpDir, '.goodvibes', 'state');
      const filePath = join(stateDir, `session_${kv.getSessionId()}.json`);
      expect(existsSync(filePath)).toBe(true);
    });

    test('persist+load round-trip preserves data', async () => {
      await kv.set({ myKey: 'myValue', count: 42 });
      await kv.persist();

      // Create new instance with same session ID pointing at same dir
      const kv2 = createKVState(kv.getSessionId());
      const result = await kv2.get(['myKey', 'count']);
      expect(result.myKey).toBe('myValue');
      expect(result.count).toBe(42);
    });

    test('persist does not throw when data is not loaded', async () => {
      const freshKv = createKVState('aabbccdd');
      // Never loaded; persist should be a no-op
      await expect(freshKv.persist()).resolves.toBeUndefined();
    });

    test('file path includes session ID', async () => {
      const id = kv.getSessionId();
      await kv.set({ x: 1 });
      await kv.persist();
      const filePath = join(tmpDir, '.goodvibes', 'state', `session_${id}.json`);
      expect(existsSync(filePath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Static: listSessions
  // -------------------------------------------------------------------------

  describe('listSessions', () => {
    test('returns empty array when no state dir', () => {
      const emptyDir = makeTmpDir();
      try {
        expect(KVState.listSessions({ stateDir: stateDirFor(emptyDir) })).toEqual([]);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    test('lists session IDs from persisted files', async () => {
      const kv1 = createKVState('aaaabbbb');
      const kv2 = createKVState('ccccdddd');
      await kv1.set({ x: 1 }); await kv1.persist();
      await kv2.set({ y: 2 }); await kv2.persist();

      const sessions = KVState.listSessions({ stateDir: stateDirFor(tmpDir) });
      expect(sessions).toContain('aaaabbbb');
      expect(sessions).toContain('ccccdddd');
    });
  });

  // -------------------------------------------------------------------------
  // Static: cleanupOldSessions
  // -------------------------------------------------------------------------

  describe('cleanupOldSessions', () => {
    test('keeps only the specified number of most recent sessions', async () => {
      // Create 5 sessions
      for (let i = 0; i < 5; i++) {
        const id = `0000000${i}`;
        const s = createKVState(id);
        await s.set({ i });
        await s.persist();
        // Small delay to differentiate mtime
        await new Promise(r => setTimeout(r, 10));
      }

      KVState.cleanupOldSessions(3, { stateDir: stateDirFor(tmpDir) });
      const remaining = KVState.listSessions({ stateDir: stateDirFor(tmpDir) });
      expect(remaining.length).toBeLessThanOrEqual(3);
    });

    test('no-op when fewer sessions than keepCount', async () => {
      const s = createKVState('12345678');
      await s.set({ x: 1 }); await s.persist();

      KVState.cleanupOldSessions(10, { stateDir: stateDirFor(tmpDir) });
      const remaining = KVState.listSessions({ stateDir: stateDirFor(tmpDir) });
      expect(remaining).toContain('12345678');
    });

    test('no-op when no state dir', () => {
      expect(() => KVState.cleanupOldSessions(3, { stateDir: '/tmp/__nonexistent_gv_test_dir__' })).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe('KVState.dispose', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gv-kv-dispose-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('dispose flushes pending data to disk', async () => {
    const kv = new KVState({ stateDir: stateDirFor(tmpDir) });
    await kv.set({ disposeKey: 'disposeVal' });
    // Timer is pending — dispose should flush before it fires
    await kv.dispose();
    const stateDir = join(tmpDir, '.goodvibes', 'state');
    const filePath = join(stateDir, `session_${kv.getSessionId()}.json`);
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.disposeKey).toBe('disposeVal');
  });

  test('dispose is safe to call when no data has been loaded', async () => {
    const kv = new KVState({ stateDir: stateDirFor(tmpDir) });
    await expect(kv.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureLoaded race condition
// ---------------------------------------------------------------------------

describe('KVState ensureLoaded race condition', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gv-kv-race-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('concurrent get() calls load data exactly once without corruption', async () => {
    const kv = new KVState({ stateDir: stateDirFor(tmpDir) });
    // Fire two get() calls simultaneously before any load has happened
    const [r1, r2] = await Promise.all([
      kv.get(['id']),
      kv.get(['id']),
    ]);
    // Both should resolve with the same session ID
    expect(r1.id).toBe(kv.getSessionId());
    expect(r2.id).toBe(kv.getSessionId());
  });

  test('concurrent set() calls do not lose data', async () => {
    const kv = new KVState({ stateDir: stateDirFor(tmpDir) });
    await Promise.all([
      kv.set({ alpha: 1 }),
      kv.set({ beta: 2 }),
    ]);
    const result = await kv.get(['alpha', 'beta']);
    expect(result.alpha).toBe(1);
    expect(result.beta).toBe(2);
  });

  test('ensureLoaded falls back to defaults after corrupt file', async () => {
    // Write a corrupt JSON file so load() hits the catch branch
    const stateDir = stateDirFor(tmpDir);
    mkdirSync(stateDir, { recursive: true });
    const id = 'deadbeef';
    writeFileSync(join(stateDir, `session_${id}.json`), 'not valid json', 'utf-8');

    const kv = new KVState({ sessionId: id, stateDir: stateDirFor(tmpDir) });
    // First get() triggers load(); load() fails to parse but falls back to defaults
    const before = await kv.get(['anything']);
    expect(before).toEqual({});

    // Data is now initialized (not null); subsequent set+get should work
    await kv.set({ recovered: true });
    const after = await kv.get(['recovered']);
    expect(after.recovered).toBe(true);
  });
});
