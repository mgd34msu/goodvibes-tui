import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { BackgroundProcess } from '@pellux/goodvibes-sdk/platform/tools';

let processManager: ProcessManager;

beforeEach(() => {
  processManager = new ProcessManager();
});

afterEach(() => {
  for (const entry of processManager.list()) {
    processManager.stop(entry.id);
  }
});

// ---------------------------------------------------------------------------
// construction / isolation
// ---------------------------------------------------------------------------

describe('ProcessManager: construction', () => {
  test('fresh instances are independent', () => {
    const a = new ProcessManager();
    const b = new ProcessManager();
    expect(a).not.toBe(b);
    expect(a.list()).toEqual([]);
    expect(b.list()).toEqual([]);
  });

  test('fresh suite-owned instance starts with no tracked processes', () => {
    expect(processManager.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('ProcessManager: spawn', () => {
  test('returns a process_id and pid', async () => {
    const result = await processManager.spawn('echo hello', undefined, undefined);
    expect(typeof result.process_id).toBe('string');
    expect(result.process_id!.startsWith('bg_')).toBe(true);
    expect(typeof result.pid).toBe('number');
    expect(result.pid!).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.exit_code).toBeNull();
  });

  test('process appears in list() immediately after spawn', async () => {
    await processManager.spawn('sleep 5', undefined, undefined);
    expect(processManager.list()).toHaveLength(1);
  });

  test('spawning multiple processes gives unique IDs', async () => {
    const r1 = await processManager.spawn('echo a', undefined, undefined);
    const r2 = await processManager.spawn('echo b', undefined, undefined);
    expect(r1.process_id).not.toBe(r2.process_id);
  });

  test('process completes and marks done=true', async () => {
    const result = await processManager.spawn('echo done_check', undefined, undefined);
    const id = result.process_id!;

    await new Promise<void>((r) => setTimeout(r, 500));

    const entry = processManager.getStatus(id);
    expect(entry).toBeDefined();
    expect((entry as BackgroundProcess).done).toBe(true);
    expect((entry as BackgroundProcess).exitCode).toBe(0);
  }, 3000);
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('ProcessManager: getStatus', () => {
  test('returns entry for known process', async () => {
    const result = await processManager.spawn('sleep 5', undefined, undefined);
    const entry = processManager.getStatus(result.process_id!);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(result.process_id as string);
    expect(entry!.cmd).toBe('sleep 5');
  });

  test('returns undefined for unknown ID', () => {
    expect(processManager.getStatus('bg_nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getOutput
// ---------------------------------------------------------------------------

describe('ProcessManager: getOutput', () => {
  test('returns undefined for unknown ID', () => {
    expect(processManager.getOutput('bg_nonexistent')).toBeUndefined();
  });

  test('returns stdout after process completes', async () => {
    const result = await processManager.spawn('echo output_check', undefined, undefined);
    const id = result.process_id!;

    await new Promise<void>((r) => setTimeout(r, 500));

    const output = processManager.getOutput(id);
    expect(output).toBeDefined();
    expect(output!.stdout).toContain('output_check');
  }, 3000);
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('ProcessManager: stop', () => {
  test('returns false for unknown process', () => {
    expect(processManager.stop('bg_nonexistent')).toBe(false);
  });

  test('returns true and removes the process', async () => {
    const result = await processManager.spawn('sleep 10', undefined, undefined);
    const id = result.process_id!;

    expect(processManager.stop(id)).toBe(true);
    expect(processManager.getStatus(id)).toBeUndefined();
    expect(processManager.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('ProcessManager: list', () => {
  test('returns empty array when no processes', () => {
    expect(processManager.list()).toEqual([]);
  });

  test('lists running processes with status=running', async () => {
    await processManager.spawn('sleep 5', undefined, undefined);
    await processManager.spawn('sleep 5', undefined, undefined);
    const list = processManager.list();
    expect(list).toHaveLength(2);
    expect(list[0].status).toBe('running');
    expect(list[1].status).toBe('running');
  });

  test('lists done processes with status containing exit code', async () => {
    const result = await processManager.spawn('true', undefined, undefined);
    const id = result.process_id!;

    await new Promise<void>((r) => setTimeout(r, 400));

    const list = processManager.list();
    const entry = list.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.status).toContain('done');
    expect(entry!.status).toContain('0');
  }, 3000);
});

// ---------------------------------------------------------------------------
// handleCommand
// ---------------------------------------------------------------------------

describe('ProcessManager: handleCommand', () => {
  test('returns null for non-bg commands', () => {
    expect(processManager.handleCommand('echo hello')).toBeNull();
    expect(processManager.handleCommand('ls -la')).toBeNull();
    expect(processManager.handleCommand('npm run build')).toBeNull();
  });

  test('bg_status: returns error for unknown ID', () => {
    const result = processManager.handleCommand('bg_status bg_unknown_99999');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.exit_code).toBe(1);
    expect(result!.stderr).toContain('Unknown process');
  });

  test('bg_status: returns running status for active process', async () => {
    const spawnResult = await processManager.spawn('sleep 5', undefined, undefined);
    const id = spawnResult.process_id!;

    const result = processManager.handleCommand(`bg_status ${id}`);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const data = JSON.parse(result!.stdout) as Record<string, unknown>;
    expect(data.status).toBe('running');
    expect(data.id).toBe(id);
  });

  test('bg_status: returns done status after completion', async () => {
    const spawnResult = await processManager.spawn('echo completed', undefined, undefined);
    const id = spawnResult.process_id!;

    await new Promise<void>((r) => setTimeout(r, 400));

    const result = processManager.handleCommand(`bg_status ${id}`);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const data = JSON.parse(result!.stdout) as Record<string, unknown>;
    expect(data.status as string).toContain('done');
  }, 3000);

  test('bg_output: returns error for unknown ID', () => {
    const result = processManager.handleCommand('bg_output bg_unknown_99999');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  test('bg_output: returns stdout/stderr after completion', async () => {
    const spawnResult = await processManager.spawn('echo output_via_cmd; echo err_via_cmd >&2', undefined, undefined);
    const id = spawnResult.process_id!;

    await new Promise<void>((r) => setTimeout(r, 400));

    const result = processManager.handleCommand(`bg_output ${id}`);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.stdout).toContain('output_via_cmd');
    expect(result!.stderr).toContain('err_via_cmd');
  }, 3000);

  test('bg_stop: returns error for unknown ID', () => {
    const result = processManager.handleCommand('bg_stop bg_unknown_99999');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.exit_code).toBe(1);
  });

  test('bg_stop: stops the process and removes it', async () => {
    const spawnResult = await processManager.spawn('sleep 10', undefined, undefined);
    const id = spawnResult.process_id!;

    const stopResult = processManager.handleCommand(`bg_stop ${id}`);
    expect(stopResult).not.toBeNull();
    expect(stopResult!.success).toBe(true);
    expect(stopResult!.stdout).toContain(id);

    expect(processManager.getStatus(id)).toBeUndefined();
  });

  test('bg_list: returns empty array when no processes', () => {
    const result = processManager.handleCommand('bg_list');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(JSON.parse(result!.stdout)).toEqual([]);
  });

  test('bg_list: returns all tracked processes', async () => {
    await processManager.spawn('sleep 5', undefined, undefined);
    await processManager.spawn('sleep 5', undefined, undefined);

    const result = processManager.handleCommand('bg_list');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const list = JSON.parse(result!.stdout) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[0].status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// BackgroundProcess interface shape
// ---------------------------------------------------------------------------

describe('BackgroundProcess: interface shape', () => {
  test('spawned entry has all required fields', async () => {
    const result = await processManager.spawn('echo shape_test', undefined, undefined);
    const entry = processManager.getStatus(result.process_id!) as BackgroundProcess;

    expect(typeof entry.id).toBe('string');
    expect(typeof entry.pid).toBe('number');
    expect(typeof entry.cmd).toBe('string');
    expect(typeof entry.startTime).toBe('number');
    expect(Array.isArray(entry.stdout)).toBe(true);
    expect(Array.isArray(entry.stderr)).toBe(true);
    expect(entry.exitCode).toBeNull();
    expect(typeof entry.done).toBe('boolean');
  });
});
