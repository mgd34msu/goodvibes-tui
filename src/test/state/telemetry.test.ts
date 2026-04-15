import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TelemetryDB } from '@pellux/goodvibes-sdk/platform/state/telemetry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeDB(): Promise<TelemetryDB> {
  const db = new TelemetryDB();
  await db.init();
  return db;
}

// ---------------------------------------------------------------------------
// TelemetryDB — lifecycle
// ---------------------------------------------------------------------------

describe('TelemetryDB', () => {
  let db: TelemetryDB;

  beforeEach(async () => {
    db = await makeDB();
  });

  afterEach(() => {
    db.close();
  });

  test('isReady is false before init', () => {
    const fresh = new TelemetryDB();
    expect(fresh.isReady).toBe(false);
    fresh.close();
  });

  test('isReady is true after init', () => {
    expect(db.isReady).toBe(true);
  });

  test('init is idempotent — second call does not throw', async () => {
    await db.init(); // second call
    expect(db.isReady).toBe(true);
  });

  test('close sets isReady to false', () => {
    db.close();
    expect(db.isReady).toBe(false);
  });

  // -------------------------------------------------------------------------
  // recordToolCall
  // -------------------------------------------------------------------------

  test('recordToolCall — records a successful call', () => {
    db.recordToolCall('read', { path: 'src/foo.ts' }, { success: true }, 42, 100);
    const records = db.query({});
    expect(records.length).toBe(1);
    expect(records[0].tool).toBe('read');
    expect(records[0].status).toBe('ok');
    expect(records[0].duration_ms).toBe(42);
    expect(records[0].tokens).toBe(100);
  });

  test('recordToolCall — marks status as error when result has success:false', () => {
    db.recordToolCall('exec', {}, { success: false, error: 'oops' }, 10, 0);
    const records = db.query({});
    expect(records[0].status).toBe('error');
  });

  test('recordToolCall — marks status as error when result has error field', () => {
    db.recordToolCall('write', {}, { error: 'disk full' }, 5, 0);
    const records = db.query({});
    expect(records[0].status).toBe('error');
  });

  test('recordToolCall — throws if not initialized', () => {
    const fresh = new TelemetryDB();
    expect(() => fresh.recordToolCall('read', {}, {}, 0, 0)).toThrow('not initialized');
  });

  // -------------------------------------------------------------------------
  // query
  // -------------------------------------------------------------------------

  test('query — empty filter returns all records', () => {
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    db.recordToolCall('write', {}, { success: true }, 20, 100);
    expect(db.query({}).length).toBe(2);
  });

  test('query — filter by tool', () => {
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    db.recordToolCall('write', {}, { success: true }, 20, 100);
    const results = db.query({ tool: 'read' });
    expect(results.length).toBe(1);
    expect(results[0].tool).toBe('read');
  });

  test('query — filter by status error', () => {
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    db.recordToolCall('exec', {}, { success: false }, 5, 0);
    const results = db.query({ status: 'error' });
    expect(results.length).toBe(1);
    expect(results[0].tool).toBe('exec');
  });

  test('query — limit respected', () => {
    for (let i = 0; i < 5; i++) {
      db.recordToolCall('read', {}, { success: true }, i, 10);
    }
    const results = db.query({ limit: 3 });
    expect(results.length).toBe(3);
  });

  test('query — since/until filter', () => {
    const before = Date.now() - 5000;
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    const results = db.query({ since: before });
    expect(results.length).toBe(1);
    const resultsNone = db.query({ until: before });
    expect(resultsNone.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // getSummary
  // -------------------------------------------------------------------------

  test('getSummary — empty db returns zeros', () => {
    const s = db.getSummary();
    expect(s.total_calls).toBe(0);
    expect(s.total_tokens).toBe(0);
    expect(s.total_errors).toBe(0);
    expect(s.total_duration_ms).toBe(0);
    expect(Object.keys(s.by_tool).length).toBe(0);
  });

  test('getSummary — aggregates correctly', () => {
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    db.recordToolCall('read', {}, { success: true }, 20, 100);
    db.recordToolCall('write', {}, { success: false }, 5, 0);
    const s = db.getSummary();
    expect(s.total_calls).toBe(3);
    expect(s.total_tokens).toBe(150);
    expect(s.total_errors).toBe(1);
    expect(s.total_duration_ms).toBe(35);
    expect(s.by_tool['read'].calls).toBe(2);
    expect(s.by_tool['read'].tokens).toBe(150);
    expect(s.by_tool['write'].errors).toBe(1);
  });

  // -------------------------------------------------------------------------
  // export
  // -------------------------------------------------------------------------

  test('export — JSON format', () => {
    db.recordToolCall('read', { path: 'foo' }, { success: true }, 10, 50);
    const out = db.export('json');
    const parsed = JSON.parse(out) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });

  test('export — CSV format has header and one data row', () => {
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    const out = db.export('csv');
    const lines = out.split('\n');
    expect(lines[0]).toContain('tool');
    expect(lines.length).toBe(2); // header + 1 row
  });

  test('export — defaults to JSON', () => {
    db.recordToolCall('read', {}, { success: true }, 10, 50);
    const out = db.export();
    expect(() => JSON.parse(out)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // save (in-memory — no path)
  // -------------------------------------------------------------------------

  test('save — returns false for in-memory db (no path)', async () => {
    const saved = await db.save();
    expect(saved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TelemetryDB — error guard
// ---------------------------------------------------------------------------

describe('TelemetryDB — uninitialized guards', () => {
  test('query throws if not initialized', () => {
    const fresh = new TelemetryDB();
    expect(() => fresh.query({})).toThrow('not initialized');
  });

  test('getSummary throws if not initialized', () => {
    const fresh = new TelemetryDB();
    expect(() => fresh.getSummary()).toThrow('not initialized');
  });

  test('export throws if not initialized', () => {
    const fresh = new TelemetryDB();
    expect(() => fresh.export()).toThrow('not initialized');
  });
});
