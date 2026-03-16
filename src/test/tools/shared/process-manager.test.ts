import { describe, test, expect, beforeEach } from 'bun:test';
import { ProcessManager } from '../../../tools/shared/process-manager.ts';
import type { BackgroundProcess } from '../../../tools/shared/process-manager.ts';

// Reset the singleton before each test to ensure isolation
beforeEach(() => {
  ProcessManager.resetInstance();
});

// ---------------------------------------------------------------------------
// getInstance / resetInstance
// ---------------------------------------------------------------------------

describe('ProcessManager — singleton', () => {
  test('getInstance returns the same instance on repeated calls', () => {
    const a = ProcessManager.getInstance();
    const b = ProcessManager.getInstance();
    expect(a).toBe(b);
  });

  test('resetInstance returns a fresh instance', () => {
    const a = ProcessManager.getInstance();
    ProcessManager.resetInstance();
    const b = ProcessManager.getInstance();
    expect(a).not.toBe(b);
  });

  test('resetInstance clears tracked processes', async () => {
    const pm = ProcessManager.getInstance();
    pm.spawn('echo reset_test', undefined, undefined);
    // Give process a moment to start
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(pm.list()).toHaveLength(1);

    ProcessManager.resetInstance();
    expect(ProcessManager.getInstance().list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('ProcessManager — spawn', () => {
  test('returns a process_id and pid', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('echo hello', undefined, undefined);
    expect(typeof result.process_id).toBe('string');
    expect(result.process_id!.startsWith('bg_')).toBe(true);
    expect(typeof result.pid).toBe('number');
    expect(result.pid!).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.exit_code).toBeNull();
  });

  test('process appears in list() immediately after spawn', () => {
    const pm = ProcessManager.getInstance();
    pm.spawn('sleep 5', undefined, undefined);
    expect(pm.list()).toHaveLength(1);
  });

  test('spawning multiple processes gives unique IDs', () => {
    const pm = ProcessManager.getInstance();
    const r1 = pm.spawn('echo a', undefined, undefined);
    const r2 = pm.spawn('echo b', undefined, undefined);
    expect(r1.process_id).not.toBe(r2.process_id);
  });

  test('process completes and marks done=true', async () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('echo done_check', undefined, undefined);
    const id = result.process_id!;

    // Wait for process to finish
    await new Promise<void>((r) => setTimeout(r, 500));

    const entry = pm.getStatus(id);
    expect(entry).toBeDefined();
    expect((entry as BackgroundProcess).done).toBe(true);
    expect((entry as BackgroundProcess).exitCode).toBe(0);
  }, 3000);
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('ProcessManager — getStatus', () => {
  test('returns entry for known process', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('sleep 5', undefined, undefined);
    const entry = pm.getStatus(result.process_id!);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(result.process_id);
    expect(entry!.cmd).toBe('sleep 5');
  });

  test('returns undefined for unknown ID', () => {
    const pm = ProcessManager.getInstance();
    expect(pm.getStatus('bg_nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getOutput
// ---------------------------------------------------------------------------

describe('ProcessManager — getOutput', () => {
  test('returns undefined for unknown ID', () => {
    const pm = ProcessManager.getInstance();
    expect(pm.getOutput('bg_nonexistent')).toBeUndefined();
  });

  test('returns stdout after process completes', async () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('echo output_check', undefined, undefined);
    const id = result.process_id!;

    // Wait for process to finish
    await new Promise<void>((r) => setTimeout(r, 500));

    const output = pm.getOutput(id);
    expect(output).toBeDefined();
    expect(output!.stdout).toContain('output_check');
  }, 3000);
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('ProcessManager — stop', () => {
  test('returns false for unknown process', () => {
    const pm = ProcessManager.getInstance();
    expect(pm.stop('bg_nonexistent')).toBe(false);
  });

  test('returns true and removes the process', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('sleep 10', undefined, undefined);
    const id = result.process_id!;

    expect(pm.stop(id)).toBe(true);
    expect(pm.getStatus(id)).toBeUndefined();
    expect(pm.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('ProcessManager — list', () => {
  test('returns empty array when no processes', () => {
    expect(ProcessManager.getInstance().list()).toEqual([]);
  });

  test('lists running processes with status=running', () => {
    const pm = ProcessManager.getInstance();
    pm.spawn('sleep 5', undefined, undefined);
    pm.spawn('sleep 5', undefined, undefined);
    const list = pm.list();
    expect(list).toHaveLength(2);
    expect(list[0].status).toBe('running');
    expect(list[1].status).toBe('running');
  });

  test('lists done processes with status containing exit code', async () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('true', undefined, undefined);
    const id = result.process_id!;

    await new Promise<void>((r) => setTimeout(r, 400));

    const list = pm.list();
    const entry = list.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.status).toContain('done');
    expect(entry!.status).toContain('0');
  }, 3000);
});

// ---------------------------------------------------------------------------
// handleCommand
// ---------------------------------------------------------------------------

describe('ProcessManager — handleCommand', () => {
  test('returns null for non-bg commands', () => {
    const pm = ProcessManager.getInstance();
    expect(pm.handleCommand('echo hello')).toBeNull();
    expect(pm.handleCommand('ls -la')).toBeNull();
    expect(pm.handleCommand('npm run build')).toBeNull();
  });

  test('bg_status: returns error for unknown ID', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.handleCommand('bg_status bg_unknown_99999');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.exit_code).toBe(1);
    expect(result!.stderr).toContain('Unknown process');
  });

  test('bg_status: returns running status for active process', () => {
    const pm = ProcessManager.getInstance();
    const spawnResult = pm.spawn('sleep 5', undefined, undefined);
    const id = spawnResult.process_id!;

    const result = pm.handleCommand(`bg_status ${id}`);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const data = JSON.parse(result!.stdout) as Record<string, unknown>;
    expect(data.status).toBe('running');
    expect(data.id).toBe(id);
  });

  test('bg_status: returns done status after completion', async () => {
    const pm = ProcessManager.getInstance();
    const spawnResult = pm.spawn('echo completed', undefined, undefined);
    const id = spawnResult.process_id!;

    await new Promise<void>((r) => setTimeout(r, 400));

    const result = pm.handleCommand(`bg_status ${id}`);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const data = JSON.parse(result!.stdout) as Record<string, unknown>;
    expect(data.status as string).toContain('done');
  }, 3000);

  test('bg_output: returns error for unknown ID', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.handleCommand('bg_output bg_unknown_99999');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  test('bg_output: returns stdout/stderr after completion', async () => {
    const pm = ProcessManager.getInstance();
    const spawnResult = pm.spawn('echo output_via_cmd; echo err_via_cmd >&2', undefined, undefined);
    const id = spawnResult.process_id!;

    await new Promise<void>((r) => setTimeout(r, 400));

    const result = pm.handleCommand(`bg_output ${id}`);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.stdout).toContain('output_via_cmd');
    expect(result!.stderr).toContain('err_via_cmd');
  }, 3000);

  test('bg_stop: returns error for unknown ID', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.handleCommand('bg_stop bg_unknown_99999');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.exit_code).toBe(1);
  });

  test('bg_stop: stops the process and removes it', () => {
    const pm = ProcessManager.getInstance();
    const spawnResult = pm.spawn('sleep 10', undefined, undefined);
    const id = spawnResult.process_id!;

    const stopResult = pm.handleCommand(`bg_stop ${id}`);
    expect(stopResult).not.toBeNull();
    expect(stopResult!.success).toBe(true);
    expect(stopResult!.stdout).toContain(id);

    // Should be gone now
    expect(pm.getStatus(id)).toBeUndefined();
  });

  test('bg_list: returns empty array when no processes', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.handleCommand('bg_list');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(JSON.parse(result!.stdout)).toEqual([]);
  });

  test('bg_list: returns all tracked processes', () => {
    const pm = ProcessManager.getInstance();
    pm.spawn('sleep 5', undefined, undefined);
    pm.spawn('sleep 5', undefined, undefined);

    const result = pm.handleCommand('bg_list');
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

describe('BackgroundProcess — interface shape', () => {
  test('spawned entry has all required fields', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('echo shape_test', undefined, undefined);
    const entry = pm.getStatus(result.process_id!) as BackgroundProcess;

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
