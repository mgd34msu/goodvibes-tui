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
import { ModeManager } from '../../state/mode-manager.ts';
import { HookDispatcher } from '../../hooks/dispatcher.ts';
import { createStateTool } from '../../tools/state/index.ts';
import { getTestProjectIndex, resetTestProjectIndexes } from '../helpers/runtime-services.ts';

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

type StateToolParsedResult = Omit<Awaited<ReturnType<ReturnType<typeof createStateTool>['execute']>>, 'callId'> & {
  parsed?: unknown;
};

/** Execute the tool and parse JSON output. */
async function run<TParsed>(tool: ReturnType<typeof createStateTool>, args: Record<string, unknown>): Promise<Omit<StateToolParsedResult, 'parsed'> & { parsed: TParsed }> {
  const result = await tool.execute(args);
  if (!result.success) {
    throw new Error(result.error ?? 'state tool execution failed');
  }
  return { ...result, parsed: JSON.parse(result.output!) as TParsed };
}

type StateGetOutput = { values: Record<string, unknown> };
type StateListOutput = { entries: Record<string, unknown>; count: number };
type StateBudgetOutput = {
  mode: string;
  session_id: string;
  project_index: { file_count: number; total_tokens: number };
  session_metrics: unknown;
};
type StateContextOutput = {
  mode: string;
  session_id: string;
  project_index: { file_count: number; total_tokens: number };
};
type StateMemoryListOutput = { action: string; keys: string[] };
type StateMemoryGetOutput = { key: string; value: unknown };
type StateTelemetryOutput = { mode: string; session_duration_ms: number; tool_calls: number; errors: number };
type StateHooksListOutput = {
  mode: string;
  action: string;
  count: number;
  hooks: Array<{ name: string; type: string; enabled: boolean }>;
};
type StateHooksToggleOutput = { enabled: boolean };
type StateHooksAddRemoveOutput = { action: string; name: string };
type StateModeGetOutput = { mode: string; action: string; name: string; verbosityDefaults: Record<string, string> };
type StateModeListOutput = {
  action: string;
  count: number;
  modes: Array<{ name: string; verbosityDefaults: Record<string, string> }>;
};

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
    resetTestProjectIndexes();
    projectIndex = getTestProjectIndex(PROJECT_ROOT);
    tool = createStateTool(kvState, projectIndex);
  });

  afterEach(() => {
    resetTestProjectIndexes();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // get / set round-trip
  // -------------------------------------------------------------------------

  test('set and get round-trip — string value', async () => {
    await tool.execute({ mode: 'set', values: { myKey: 'hello' } });
    const res = await run<StateGetOutput>(tool, { mode: 'get', keys: ['myKey'] });
    expect(res.parsed.values.myKey).toBe('hello');
  });

  test('set and get round-trip — numeric value', async () => {
    await tool.execute({ mode: 'set', values: { count: 42 } });
    const res = await run<StateGetOutput>(tool, { mode: 'get', keys: ['count'] });
    expect(res.parsed.values.count).toBe(42);
  });

  test('get missing key returns empty values map', async () => {
    const res = await run<StateGetOutput>(tool, { mode: 'get', keys: ['nonexistent'] });
    expect(res.parsed.values).toEqual({});
  });

  test('get returns only requested keys', async () => {
    await tool.execute({ mode: 'set', values: { a: 1, b: 2, c: 3 } });
    const res = await run<StateGetOutput>(tool, { mode: 'get', keys: ['a', 'c'] });
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
    const res = await run<StateListOutput>(tool, { mode: 'list' });
    expect(res.parsed.entries.x).toBe(1);
    expect(res.parsed.entries.y).toBe(2);
    expect(res.parsed.count).toBeGreaterThanOrEqual(2);
  });

  test('list filters by prefix', async () => {
    await tool.execute({ mode: 'set', values: { 'ns:a': 1, 'ns:b': 2, 'other': 3 } });
    const res = await run<StateListOutput>(tool, { mode: 'list', prefix: 'ns:' });
    expect(res.parsed.entries['ns:a']).toBe(1);
    expect(res.parsed.entries['ns:b']).toBe(2);
    expect(res.parsed.entries.other).toBeUndefined();
    expect(res.parsed.count).toBe(2);
  });

  test('list with prefix that matches nothing returns empty', async () => {
    await tool.execute({ mode: 'set', values: { foo: 1 } });
    const res = await run<StateListOutput>(tool, { mode: 'list', prefix: 'zzz:' });
    expect(res.parsed.count).toBe(0);
    expect(res.parsed.entries).toEqual({});
  });

  test('list supports summary view for inventory-only scans', async () => {
    await tool.execute({ mode: 'set', values: { alpha: 1 } });
    const res = await run<{ entries: Array<{ key: string; type: string }> }>(tool, { mode: 'list', view: 'summary' });
    const alpha = res.parsed.entries.find((entry) => entry.key === 'alpha');
    expect(alpha?.type).toBe('number');
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  test('clear removes specified keys', async () => {
    await tool.execute({ mode: 'set', values: { k1: 'v1', k2: 'v2' } });
    await tool.execute({ mode: 'clear', clearKeys: ['k1'] });
    const res = await run<StateGetOutput>(tool, { mode: 'get', keys: ['k1', 'k2'] });
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
    const getRes = await run<StateGetOutput>(tool, { mode: 'get', keys: ['id', 'myData'] });
    // id was reserved so get might return the session id or nothing — but myData must be set
    expect(getRes.parsed.values.myData).toBe('ok');
  });

  test('set silently ignores reserved key "started_at"', async () => {
    const res = await tool.execute({ mode: 'set', values: { started_at: '1970', safe: true } });
    expect(res.success).toBe(true);
    const getRes = await run<StateGetOutput>(tool, { mode: 'get', keys: ['safe'] });
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
    const res = await run<StateBudgetOutput>(tool, { mode: 'budget' });
    expect(res.parsed.mode).toBe('budget');
    expect(typeof res.parsed.session_id).toBe('string');
    expect(res.parsed.session_id.length).toBeGreaterThan(0);
  });

  test('budget includes project_index with file_count and total_tokens', async () => {
    const res = await run<StateBudgetOutput>(tool, { mode: 'budget' });
    expect(typeof res.parsed.project_index.file_count).toBe('number');
    expect(typeof res.parsed.project_index.total_tokens).toBe('number');
  });

  test('budget includes session_metrics object', async () => {
    const res = await run<StateBudgetOutput>(tool, { mode: 'budget' });
    expect(typeof res.parsed.session_metrics).toBe('object');
  });

  // -------------------------------------------------------------------------
  // context
  // -------------------------------------------------------------------------

  test('context returns session_id and project_index', async () => {
    const res = await run<StateContextOutput>(tool, { mode: 'context' });
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
      const res = await run<StateMemoryListOutput>(tool, { mode: 'memory', memoryAction: 'list' });
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
      const res = await run<StateMemoryListOutput>(tool, { mode: 'memory', memoryAction: 'list' });
      expect(res.parsed.keys).toContain('testEntry');
    });

    test('memory get returns value after set', async () => {
      await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryKey: 'myData',
        memoryValue: '{"x":42}',
      });
      const res = await run<StateMemoryGetOutput>(tool, {
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: 'myData',
      });
      expect(res.parsed.key).toBe('myData');
      expect(res.parsed.value).toEqual({ x: 42 });
    });

    test('memory get supports summary view without returning the full value', async () => {
      await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryKey: 'myCompactData',
        memoryValue: '{"x":42}',
      });
      const res = await run<{ key: string; type: string; bytes: number }>(tool, {
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: 'myCompactData',
        view: 'summary',
      });
      expect(res.parsed.key).toBe('myCompactData');
      expect(res.parsed.type).toBe('object');
      expect(res.parsed.bytes).toBeGreaterThan(0);
    });

    test('memory get returns null value for missing key', async () => {
      const res = await run<StateMemoryGetOutput>(tool, {
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
      const res = await run<StateMemoryListOutput>(tool, { mode: 'memory' });
      expect(res.parsed.action).toBe('list');
    });

    test('memory get rejects path traversal in memoryKey', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: '../../etc/passwd',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid memoryKey');
    });

    test('memory set rejects path traversal in memoryKey', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'set',
        memoryKey: '../../../.env',
        memoryValue: 'malicious',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid memoryKey');
    });

    test('memory get rejects memoryKey with forward slash', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: 'sub/dir',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid memoryKey');
    });

    test('memory get rejects memoryKey with null byte', async () => {
      const res = await tool.execute({
        mode: 'memory',
        memoryAction: 'get',
        memoryKey: 'valid\x00extra',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid memoryKey');
    });
  });

  // -------------------------------------------------------------------------
  // telemetry
  // -------------------------------------------------------------------------

  test('telemetry returns summary with duration and tool_calls', async () => {
    // Call something first so tool_calls > 0
    await tool.execute({ mode: 'list' });
    const res = await run<StateTelemetryOutput>(tool, { mode: 'telemetry' });
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
  // hooks mode
  // -------------------------------------------------------------------------

  describe('hooks mode', () => {
    let dispatcher: HookDispatcher;
    let hookTool: ReturnType<typeof createStateTool>;

    beforeEach(() => {
      dispatcher = new HookDispatcher();
      hookTool = createStateTool(kvState, projectIndex, dispatcher);
    });

    test('hooks list returns empty when no hooks registered', async () => {
      const res = await run<StateHooksListOutput>(hookTool, { mode: 'hooks', hookAction: 'list' });
      expect(res.parsed.mode).toBe('hooks');
      expect(res.parsed.action).toBe('list');
      expect(res.parsed.count).toBe(0);
      expect(res.parsed.hooks).toEqual([]);
    });

    test('hooks list defaults when no hookAction provided', async () => {
      const res = await run<StateHooksListOutput>(hookTool, { mode: 'hooks' });
      expect(res.parsed.action).toBe('list');
    });

    test('hooks list shows registered hooks', async () => {
      dispatcher.register('Pre:tool:*', { name: 'myHook', type: 'command', match: 'Pre:tool:*', command: 'echo hi' });
      const res = await run<StateHooksListOutput>(hookTool, { mode: 'hooks', hookAction: 'list' });
      expect(res.parsed.count).toBe(1);
      expect(res.parsed.hooks[0].name).toBe('myHook');
      expect(res.parsed.hooks[0].type).toBe('command');
      expect(res.parsed.hooks[0].enabled).toBe(true);
    });

    test('hooks enable sets hook enabled to true', async () => {
      dispatcher.register('Pre:tool:*', { name: 'toggleHook', type: 'command', match: 'Pre:tool:*', command: 'echo hi', enabled: false });
      const res = await run<StateHooksToggleOutput>(hookTool, { mode: 'hooks', hookAction: 'enable', hookName: 'toggleHook' });
      expect(res.parsed.enabled).toBe(true);
      // Verify via list
      const list = await run<StateHooksListOutput>(hookTool, { mode: 'hooks', hookAction: 'list' });
      expect(list.parsed.hooks[0].enabled).toBe(true);
    });

    test('hooks disable sets hook enabled to false', async () => {
      dispatcher.register('Pre:tool:*', { name: 'disableMe', type: 'command', match: 'Pre:tool:*', command: 'echo hi' });
      const res = await run<StateHooksToggleOutput>(hookTool, { mode: 'hooks', hookAction: 'disable', hookName: 'disableMe' });
      expect(res.parsed.enabled).toBe(false);
    });

    test('hooks enable returns error when hook not found', async () => {
      const res = await hookTool.execute({ mode: 'hooks', hookAction: 'enable', hookName: 'noSuchHook' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('noSuchHook');
    });

    test('hooks disable returns error when hook not found', async () => {
      const res = await hookTool.execute({ mode: 'hooks', hookAction: 'disable', hookName: 'noSuchHook' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('noSuchHook');
    });

    test('hooks enable requires hookName', async () => {
      const res = await hookTool.execute({ mode: 'hooks', hookAction: 'enable' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('hookName');
    });

    test('hooks add registers a new hook', async () => {
      const res = await run<StateHooksAddRemoveOutput>(hookTool, {
        mode: 'hooks',
        hookAction: 'add',
        hookDefinition: {
          eventPattern: 'Post:tool:*',
          name: 'addedHook',
          type: 'command',
          match: 'Post:tool:*',
          command: 'echo done',
        },
      });
      expect(res.parsed.action).toBe('add');
      expect(res.parsed.name).toBe('addedHook');
      // Verify it appears in list
      const list = await run<StateHooksListOutput>(hookTool, { mode: 'hooks', hookAction: 'list' });
      expect(list.parsed.count).toBe(1);
      expect(list.parsed.hooks[0].name).toBe('addedHook');
    });

    test('hooks add requires hookDefinition', async () => {
      const res = await hookTool.execute({ mode: 'hooks', hookAction: 'add' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('hookDefinition');
    });

    test('hooks add requires eventPattern', async () => {
      const res = await hookTool.execute({
        mode: 'hooks',
        hookAction: 'add',
        hookDefinition: { eventPattern: '', type: 'command', match: 'Pre:tool:*', command: 'echo' },
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('eventPattern');
    });

    test('hooks add rejects invalid type', async () => {
      const res = await hookTool.execute({
        mode: 'hooks',
        hookAction: 'add',
        hookDefinition: { eventPattern: 'Pre:tool:*', type: 'prompt' as 'command', match: 'Pre:tool:*' },
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('type');
    });

    test('hooks remove deletes a named hook', async () => {
      dispatcher.register('Pre:tool:*', { name: 'removeMe', type: 'command', match: 'Pre:tool:*', command: 'echo' });
      const res = await run<StateHooksAddRemoveOutput>(hookTool, { mode: 'hooks', hookAction: 'remove', hookName: 'removeMe' });
      expect(res.parsed.action).toBe('remove');
      expect(res.parsed.name).toBe('removeMe');
      // Verify removed
      const list = await run<StateHooksListOutput>(hookTool, { mode: 'hooks', hookAction: 'list' });
      expect(list.parsed.count).toBe(0);
    });

    test('hooks remove returns error when not found', async () => {
      const res = await hookTool.execute({ mode: 'hooks', hookAction: 'remove', hookName: 'missing' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('missing');
    });

    test('hooks remove requires hookName', async () => {
      const res = await hookTool.execute({ mode: 'hooks', hookAction: 'remove' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('hookName');
    });

    test('hooks mode returns error when no dispatcher provided', async () => {
      const noDispatcherTool = createStateTool(kvState, projectIndex);
      const res = await noDispatcherTool.execute({ mode: 'hooks' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('HookDispatcher');
    });
  });

  // -------------------------------------------------------------------------
  // mode mode
  // -------------------------------------------------------------------------

  describe('mode mode', () => {
    let modeMgr: ModeManager;
    let modeTool: ReturnType<typeof createStateTool>;

    beforeEach(() => {
      modeMgr = new ModeManager();
      modeTool = createStateTool(kvState, projectIndex, undefined, modeMgr);
    });

    test('mode get returns current mode name and verbosityDefaults', async () => {
      const res = await run<StateModeGetOutput>(modeTool, { mode: 'mode', modeAction: 'get' });
      expect(res.parsed.mode).toBe('mode');
      expect(res.parsed.action).toBe('get');
      expect(res.parsed.name).toBe('default');
      expect(typeof res.parsed.verbosityDefaults).toBe('object');
    });

    test('mode get defaults when no modeAction provided', async () => {
      const res = await run<StateModeGetOutput>(modeTool, { mode: 'mode' });
      expect(res.parsed.action).toBe('get');
      expect(res.parsed.name).toBe('default');
    });

    test('mode list returns all available modes', async () => {
      const res = await run<StateModeListOutput>(modeTool, { mode: 'mode', modeAction: 'list' });
      expect(res.parsed.action).toBe('list');
      expect(res.parsed.count).toBeGreaterThanOrEqual(3);
      const names = res.parsed.modes.map((m: { name: string }) => m.name);
      expect(names).toContain('default');
      expect(names).toContain('vibecoding');
      expect(names).toContain('justvibes');
    });

    test('mode list includes verbosityDefaults per mode', async () => {
      const res = await run<StateModeListOutput>(modeTool, { mode: 'mode', modeAction: 'list' });
      const def = res.parsed.modes.find((m: { name: string }) => m.name === 'default');
      expect(def).toBeDefined();
      if (!def) {
        throw new Error('default mode missing from mode list');
      }
      expect(typeof def.verbosityDefaults).toBe('object');
      expect(typeof def.verbosityDefaults.write).toBe('string');
    });

    test('mode list supports summary view', async () => {
      const res = await run<{ modes: Array<{ name: string; description: string; enforcement: string }> }>(modeTool, {
        mode: 'mode',
        modeAction: 'list',
        view: 'summary',
      });
      const def = res.parsed.modes.find((m) => m.name === 'default');
      expect(def).toBeDefined();
      expect(def?.description).toBeTruthy();
    });

    test('mode set switches to vibecoding', async () => {
      await modeTool.execute({ mode: 'mode', modeAction: 'set', modeName: 'vibecoding' });
      const res = await run<StateModeGetOutput>(modeTool, { mode: 'mode', modeAction: 'get' });
      expect(res.parsed.name).toBe('vibecoding');
    });

    test('mode set returns new verbosityDefaults', async () => {
      const res = await run<StateModeGetOutput>(modeTool, { mode: 'mode', modeAction: 'set', modeName: 'vibecoding' });
      expect(res.parsed.name).toBe('vibecoding');
      expect(res.parsed.verbosityDefaults.write).toBe('count_only');
    });

    test('mode set unknown mode returns error', async () => {
      const res = await modeTool.execute({ mode: 'mode', modeAction: 'set', modeName: 'bogusMode' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('bogusMode');
    });

    test('mode set requires modeName', async () => {
      const res = await modeTool.execute({ mode: 'mode', modeAction: 'set' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('modeName');
    });

    test('mode uses the provided ModeManager instance', async () => {
      modeMgr.setMode('justvibes');
      const res = await run<StateModeGetOutput>(modeTool, { mode: 'mode', modeAction: 'get' });
      expect(res.parsed.name).toBe('justvibes');
    });
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
