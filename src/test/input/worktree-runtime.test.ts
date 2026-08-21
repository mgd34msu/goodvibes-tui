import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import {
  formatSetupDetail,
  formatSetupTag,
  registerWorktreeRuntimeCommands,
} from '../../input/commands/worktree-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { ManagedWorktreeMeta, WorktreeStatusRecord } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// formatSetupTag / formatSetupDetail, pure formatting helpers
// ---------------------------------------------------------------------------

describe('formatSetupTag', () => {
  test('absent when setup has never run', () => {
    expect(formatSetupTag(undefined)).toBe('');
  });

  test('marks a failed setup prominently', () => {
    const setup: NonNullable<ManagedWorktreeMeta['setup']> = {
      state: 'failed',
      startedAt: 0,
      completedAt: 1,
      steps: [],
      error: 'bun install exited 1',
    };
    expect(formatSetupTag(setup)).toBe(' setup:FAILED');
  });

  test('shows ok for a succeeded setup and skipped for skipped', () => {
    const succeeded: NonNullable<ManagedWorktreeMeta['setup']> = { state: 'succeeded', startedAt: 0, completedAt: 1, steps: [] };
    const skipped: NonNullable<ManagedWorktreeMeta['setup']> = { state: 'skipped', startedAt: 0, completedAt: 1, steps: [] };
    expect(formatSetupTag(succeeded)).toBe(' setup:ok');
    expect(formatSetupTag(skipped)).toBe(' setup:skipped');
  });
});

describe('formatSetupDetail', () => {
  test('reports never run when absent', () => {
    expect(formatSetupDetail(undefined)).toEqual(['  setup: never run']);
  });

  test('surfaces the real failing step and its captured output on failure', () => {
    const setup: NonNullable<ManagedWorktreeMeta['setup']> = {
      state: 'failed',
      startedAt: 0,
      completedAt: 1,
      error: 'setup command exited 1: bun install',
      steps: [
        { kind: 'command', label: 'bun install', ok: false, exitCode: 1, output: 'ENOENT: some error' },
      ],
    };
    const lines = formatSetupDetail(setup);
    expect(lines[0]).toContain('FAILED');
    expect(lines[0]).toContain('setup command exited 1: bun install');
    expect(lines.some((l) => l.includes('bun install') && l.includes('exit 1'))).toBe(true);
    expect(lines.some((l) => l.includes('ENOENT: some error'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /worktree command
// ---------------------------------------------------------------------------

function makeCtx(overrides: {
  rows?: WorktreeStatusRecord[];
  configGet?: (key: string) => unknown;
} = {}): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  const rows = overrides.rows ?? [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: {
      shellPaths: { workingDirectory: '/tmp/goodvibes-worktree-test' } as CommandContext['workspace']['shellPaths'],
      worktreeRegistry: {
        list: async () => rows,
        attach: () => {},
        setState: () => {},
        cleanup: async () => {},
      } as unknown as CommandContext['workspace']['worktreeRegistry'],
    } as CommandContext['workspace'],
    platform: {
      configManager: {
        get: (key: string) => (overrides.configGet ? overrides.configGet(key) : undefined),
        setDynamic: () => {},
      } as unknown as CommandContext['platform']['configManager'],
    } as CommandContext['platform'],
  } as unknown as CommandContext & { printed: string[] };
}

function makeRow(overrides: Partial<WorktreeStatusRecord> = {}): WorktreeStatusRecord {
  return {
    path: '/tmp/wt/agent-1',
    kind: 'agent',
    state: 'active',
    branch: 'ws/abc/def',
    head: 'deadbeef',
    updatedAt: Date.now(),
    ...overrides,
  } as WorktreeStatusRecord;
}

describe('/worktree review', () => {
  function makeRegistry() {
    const registry = new CommandRegistry();
    registerWorktreeRuntimeCommands(registry);
    return registry;
  }

  test('shows no worktrees message when the registry is empty', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx({ rows: [] });
    await registry.get('worktree')!.handler([], ctx);
    expect(ctx.printed.join('\n')).toContain('No worktrees discovered');
  });

  test('marks a failed setup prominently on its row, and leaves a never-run row quiet', async () => {
    const registry = makeRegistry();
    const failedRow = makeRow({
      path: '/tmp/wt/failed',
      setup: { state: 'failed', startedAt: 0, completedAt: 1, steps: [], error: 'bun install exited 1' },
    });
    const quietRow = makeRow({ path: '/tmp/wt/quiet' });
    const ctx = makeCtx({ rows: [failedRow, quietRow] });
    await registry.get('worktree')!.handler([], ctx);
    const text = ctx.printed.join('\n');
    expect(text).toContain('setup:FAILED');
    // The row with no setup history never claims a setup outcome it doesn't have.
    const quietLine = text.split('\n').find((line) => line.includes('/tmp/wt/quiet'));
    expect(quietLine).toBeDefined();
    expect(quietLine).not.toContain('setup:');
  });
});

describe('/worktree setup', () => {
  function makeRegistry() {
    const registry = new CommandRegistry();
    registerWorktreeRuntimeCommands(registry);
    return registry;
  }

  test('usage message when path is missing', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    await registry.get('worktree')!.handler(['setup'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /worktree setup <path>');
  });

  test('honestly reports the live round-trip as unavailable when no daemon is reachable', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    await registry.get('worktree')!.handler(['setup', '/tmp/wt/agent-1'], ctx);
    const text = ctx.printed.join('\n');
    expect(text).toContain('[worktree setup]');
    expect(text).toContain('no control-plane base URL is configured');
  });
});

// ---------------------------------------------------------------------------
// /worktree discard, the real destructive act (worktrees.discard), no longer
// a metadata setState flip.
// ---------------------------------------------------------------------------

describe('/worktree discard', () => {
  function ctxWithSetStateSpy(daemonEnabled: boolean): { ctx: CommandContext; printed: string[]; setStateCalls: Array<[string, string]> } {
    const printed: string[] = [];
    const setStateCalls: Array<[string, string]> = [];
    const ctx = {
      print: (t: string) => { printed.push(t); },
      renderRequest: () => {},
      workspace: {
        shellPaths: { workingDirectory: '/tmp/x', homeDirectory: '/tmp/home' } as CommandContext['workspace']['shellPaths'],
        worktreeRegistry: {
          list: async () => [],
          attach: () => {},
          setState: (p: string, s: string) => { setStateCalls.push([p, s]); },
          cleanup: async () => {},
        } as unknown as CommandContext['workspace']['worktreeRegistry'],
      } as CommandContext['workspace'],
      platform: {
        configManager: {
          get: (key: string) => (key === 'daemon.enabled' ? daemonEnabled : undefined),
          setDynamic: () => {},
        } as unknown as CommandContext['platform']['configManager'],
      } as CommandContext['platform'],
    } as unknown as CommandContext;
    return { ctx, printed, setStateCalls };
  }

  function makeRegistry() {
    const registry = new CommandRegistry();
    registerWorktreeRuntimeCommands(registry);
    return registry;
  }

  test('routes through the worktrees.discard operator verb, never a metadata setState flip', async () => {
    const { ctx, printed, setStateCalls } = ctxWithSetStateSpy(false);
    await makeRegistry().get('worktree')!.handler(['discard', '/tmp/wt/agent-1'], ctx);
    // Discard is a real act now, it must NOT silently flip the persisted state.
    expect(setStateCalls).toEqual([]);
    // With no daemon reachable it prints the honest operator-rpc unavailable reason.
    expect(printed.at(-1)).toContain('[worktree discard]');
    expect(printed.at(-1)).toContain('daemon is disabled');
  });

  test('missing path prints the discard usage', async () => {
    const { ctx, printed } = ctxWithSetStateSpy(false);
    await makeRegistry().get('worktree')!.handler(['discard'], ctx);
    expect(printed.at(-1)).toBe('Usage: /worktree discard <path>');
  });

  test('pause/resume/keep still flip the persisted metadata state', async () => {
    const { ctx, setStateCalls } = ctxWithSetStateSpy(false);
    const registry = makeRegistry();
    await registry.get('worktree')!.handler(['keep', '/tmp/wt/a'], ctx);
    await registry.get('worktree')!.handler(['pause', '/tmp/wt/b'], ctx);
    await registry.get('worktree')!.handler(['resume', '/tmp/wt/c'], ctx);
    expect(setStateCalls).toEqual([['/tmp/wt/a', 'kept'], ['/tmp/wt/b', 'paused'], ['/tmp/wt/c', 'active']]);
  });
});
