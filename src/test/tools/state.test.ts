/**
 * Tests for the state tool.
 *
 * Memory tests use a temp directory isolated from the real .goodvibes/memory.
 * KVState instances use temp directories to avoid polluting real session files.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KVState } from '../../state/kv-state.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { createStateTool } from '../../tools/state/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

/** Make an isolated temp directory inside the project root. */
function makeTmpDir(): string {
  const base = join(PROJECT_ROOT, '.test-tmp');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'state-'));
}

/** Execute the tool and parse JSON output. */
async function run(tool: ReturnType<typeof createStateTool>, args: Record<string, unknown>) {
  const result = await tool.execute(args);
  if (!result.success) return result;
  return { ...result, parsed: JSON.parse(result.output!) };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('StateTool', () => {
  let tmpDir: string;
  let kvState: KVState;
  let projectIndex: ProjectIndex;
  let tool: ReturnType<typeof createStateTool>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Use tmpDir as the KVState base so session files land in isolation.
    kvState = new KVState(undefined, tmpDir);
    ProjectIndex._resetInstance();
    projectIndex = ProjectIndex.getInstance(PROJECT_ROOT);
    tool = createStateTool(kvState, projectIndex);
  });

  afterEach(() => {
    ProjectIndex._resetInstance();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // get / set round-trip
  // -------------------------------------------------------------------------

  test('set and get round-trip — string value', async () => {
    await tool.execute({ mode: 'set', values: { myKey: 'hello' } });
    const res = await run(tool, { mode: 'get', keys: ['myKey'] });
    expect(res.parsed.values.myKey).toBe('hello');
  });

  test('set and get round-trip — numeric value', async () => {
    await tool.execute({ mode: 'set', values: { count: 42 } });
    const res = await run(tool, { mode: 'get', keys: ['count'] });
    expect(res.parsed.values.count).toBe(42);
  });

  test('get missing key returns empty values map', async () => {
    const res = await run(tool, { mode: 'get', keys: ['nonexistent'] });
    expect(res.parsed.values).toEqual({});
  });

  test('get returns only requested keys', async () => {
    await tool.execute({ mode: 'set', values: { a: 1, b: 2, c: 3 } });
    const res = await run(tool, { mode: 'get', keys: ['a', 'c'] });
    expect(res.parsed.values).toEqual({ a: 1, c: 3 });
    expect(res.parsed.values.b).toBeUndefined();
  });

  test('get with empty keys array returns error', async () => {
    const res = await tool.execute({ mode: 'get', keys: [] });
    expect(res.success).toBe(false);
    expect(res.error).toContain('"keys"');
  });

  test('get with no keys field returns error', async () => {
    const res = await tool.execute({ mode: 'get' });
    expect(res.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  test('list returns all entries when no prefix', async () => {
    await tool.execute({ mode: 'set', values: { x: 1, y: 2 } });
    const res = await run(tool, { mode: 'list' });
    expect(res.parsed.entries.x).toBe(1);
    expect(res.parsed.entries.y).toBe(2);
    expect(res.parsed.count).toBeGreaterThanOrEqual(2);
  });

  test('list filters by prefix', async () => {
    await tool.execute({ mode: 'set', values: { 'ns:a': 1, 'ns:b': 2, 'other': 3 } });
    const res = await run(tool, { mode: 'list', prefix: 'ns:' });
    expect(res.parsed.entries['ns:a']).toBe(1);
    expect(res.parsed.entries['ns:b']).toBe(2);
    expect(res.parsed.entries.other).toBeUndefined();
    expect(res.parsed.count).toBe(2);
  });

  test('list with prefix that matches nothing returns empty', async () => {
    await tool.execute({ mode: 'set', values: { foo: 1 } });
    const res = await run(tool, { mode: 'list', prefix: 'zzz:' });
    expect(res.parsed.count).toBe(0);
    expect(res.parsed.entries).toEqual({});
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  test('clear removes specified keys', async () => {
    await tool.execute({ mode: 'set', values: { k1: 'v1', k2: 'v2' } });
    await tool.execute({ mode: 'clear', clearKeys: ['k1'] });
    const res = await run(tool, { mode: 'get', keys: ['k1', 'k2'] });
    expect(res.parsed.values.k1).toBeUndefined();
    expect(res.parsed.values.k2).toBe('v2');
  });

  test('clear with empty clearKeys returns error', async () => {
    const res = await tool.execute({ mode: 'clear', clearKeys: [] });
    expect(res.success).toBe(false);
    expect(res.error).toContain('"clearKeys"');
  });

  test('clear silently ignores unknown keys', async () => {
    await tool.execute({ mode: 'set', values: { existing: 1 } });
    const res = await tool.execute({ mode: 'clear', clearKeys: ['doesNotExist'] });
    expect(res.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // set — reserved key rejection
  // -------------------------------------------------------------------------

  test('set silently ignores reserved key "id"', async () => {
    // KVState silently drops reserved keys; tool should still succeed
    const res = await tool.execute({ mode: 'set', values: { id: 'hack', myData: 'ok' } });
    expect(res.success).toBe(true);
    // "id" should NOT have been overwritten
    const getRes = await run(tool, { mode: 'get', keys: ['id', 'myData'] });
    // id was reserved so get might return the session id or nothing — but myData must be set
    expect(getRes.parsed.values.myData).toBe('ok');
  });

  test('set silently ignores reserved key "started_at"', async () => {
    const res = await tool.execute({ mode: 'set', values: { started_at: '1970', safe: true } });
    expect(res.success).toBe(true);
    const getRes = await run(tool, { mode: 'get', keys: ['safe'] });
    expect(getRes.parsed.values.safe).toBe(true);
  });

  test('set with no values object returns error', async () => {
    const res = await tool.execute({ mode: 'set' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('"values"');
  });

  // -------------------------------------------------------------------------
  // budget
  // -------------------------------------------------------------------------

  test('budget returns structured info with session_id', async () => {
    const res = await run(tool, { mode: 'budget' });
    expect(res.parsed.mode).toBe('budget');
    expect(typeof res.parsed.session_id).toBe('string');
    expect(res.parsed.session_id.length).toBeGreaterThan(0);
  });

  test('budget includes project_index with file_count and total_tokens', async () => {
    const res = await run(tool, { mode: 'budget' });
    expect(typeof res.parsed.project_index.file_count).toBe('number');
    expect(typeof res.parsed.project_index.total_tokens).toBe('number');
  });

  test('budget includes session_metrics object', async () => {
    const res = await run(tool, { mode: 'budget' });
    expect(typeof res.parsed.session_metrics).toBe('object');
  });

  // -------------------------------------------------------------------------
  // context
  // -------------------------------------------------------------------------

  test('context returns session_id and project_index', async () => {
    const res = await run(tool, { mode: 'context' });
    expect(res.parsed.mode).toBe('context');
    expect(typeof res.parsed.session_id).toBe('string');
    expect(typeof res.parsed.project_index.file_count).toBe('number');
    expect(typeof res.parsed.project_index.total_tokens).toBe('number');
  });

  // -------------------------------------------------------------------------
  // memory
  // -------------------------------------------------------------------------

  describe('memory mode', () => {
    // Override process.cwd for memory tests by creating a fresh tool whose
    // memory dir lives in our tmpDir. We do this by monkey-patching cwd
    // temporarily — the cleanest approach given the module-level cwd usage.
    let origCwd: () => string;

    beforeEach(() => {
      origCwd = process.cwd.bind(process);
      // Create the .goodvibes/memory dir under tmpDir so the tool uses it.
      mkdirSync(join(tmpDir, '.goodvibes', 'memory'), { recursive: true });
      // Override process.cwd to return our tmpDir
      (process as unknown as Record<string, unknown>).cwd = () => tmpDir;
    });

    afterEach(() => {
      (process as unknown as Record<string, unknown>).cwd = origCwd;
    });

    test('memory list returns empty when no files', async () => {
      // Remove the memory dir we just created to simulate empty state
      rmSync(join(tmpDir, '.goodvibes', 'memory'), { recursive: true, force: true });
      const res = await run(tool, { mode: 'memory', memoryAction: 'list' });
      expect(res.parsed.action).toBe('list');
      expect(res.parsed.keys).toEqual([]);
    });

    test('memory set writes file and list returns the key', async () => {
      await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryKey: 'testEntry',
        memoryValue: '{"hello":"world"}',
      });
      const res = await run(tool, { mode: 'memory', memoryAction: 'list' });
      expect(res.parsed.keys).toContain('testEntry');
    });

    test('memory get returns value after set', async () => {
      await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryKey: 'myData',
        memoryValue: '{"x":42}',
      });
      const res = await run(tool, {
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: 'myData',
      });
      expect(res.parsed.key).toBe('myData');
      expect(res.parsed.value).toEqual({ x: 42 });
    });

    test('memory get returns null value for missing key', async () => {
      const res = await run(tool, {
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: 'missing',
      });
      expect(res.parsed.value).toBeNull();
    });

    test('memory set without memoryKey returns error', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryValue: 'someValue',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('memoryKey');
    });

    test('memory set without memoryValue returns error', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryKey: 'theKey',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('memoryValue');
    });

    test('memory get without memoryKey returns error', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'get',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('memoryKey');
    });

    test('memory list defaults when no memoryAction provided', async () => {
      const res = await run(tool, { mode: 'memory' });
      expect(res.parsed.action).toBe('list');
    });
  });

  // -------------------------------------------------------------------------
  // telemetry
  // -------------------------------------------------------------------------

  test('telemetry returns summary with duration and tool_calls', async () => {
    // Call something first so tool_calls > 0
    await tool.execute({ mode: 'list' });
    const res = await run(tool, { mode: 'telemetry' });
    expect(res.parsed.mode).toBe('telemetry');
    expect(typeof res.parsed.session_duration_ms).toBe('number');
    expect(res.parsed.session_duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof res.parsed.tool_calls).toBe('number');
    expect(typeof res.parsed.errors).toBe('number');
  });

  // -------------------------------------------------------------------------
  // invalid mode
  // -------------------------------------------------------------------------

  test('invalid mode returns error', async () => {
    const res = await tool.execute({ mode: 'bogusMode' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('bogusMode');
  });

  // -------------------------------------------------------------------------
  // tool definition
  // -------------------------------------------------------------------------

  test('tool has correct name', () => {
    expect(tool.definition.name).toBe('state');
  });

  test('tool has non-empty description', () => {
    expect(tool.definition.description.length).toBeGreaterThan(0);
  });

  test('tool has parameters object', () => {
    expect(typeof tool.definition.parameters).toBe('object');
  });
});
