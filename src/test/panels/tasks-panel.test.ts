import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createInitialTasksState } from '../../runtime/store/domains/tasks.ts';
import { TasksPanel } from '../../panels/tasks-panel.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { RuntimeEventBus } from '../../runtime/events/index.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('TasksPanel', () => {
  const originalCwd = process.cwd();
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-tasks-panel-'));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(join(root, '.goodvibes'), { recursive: true, force: true });
    rmSync(join(originalCwd, '.goodvibes', 'tui', 'worktrees.json'), { force: true });
  });

  test('renders empty guidance when no tasks exist', () => {
    const store = createRuntimeStore();
    const panel = new TasksPanel(store);
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Task Control Room');
    expect(text).toContain('No tasks recorded yet');
  });

  test('renders task summaries and selection detail from the runtime store', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    const worktreeStore = JSON.stringify({
      version: 1,
      records: {
        [join(originalCwd, '.goodvibes', '.worktrees', 'agent-running')]: {
          path: join(originalCwd, '.goodvibes', '.worktrees', 'agent-running'),
          kind: 'agent',
          state: 'paused',
          ownerId: 'agent-running',
          taskId: 'running-1',
          sessionId: 'sess-1',
          updatedAt: now,
        },
      },
    }, null, 2);
    mkdirSync(join(originalCwd, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(originalCwd, '.goodvibes', 'tui', 'worktrees.json'), worktreeStore);
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'worktrees.json'), worktreeStore);
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([
          ['queued-1', {
            id: 'queued-1',
            kind: 'exec',
            title: 'Queued task',
            status: 'queued',
            owner: 'shell',
            cancellable: true,
            childTaskIds: [],
            queuedAt: now - 5_000,
          }],
          ['running-1', {
            id: 'running-1',
            kind: 'agent',
            title: 'Running agent task',
            status: 'running',
            owner: 'agent-orchestrator',
            cancellable: true,
            childTaskIds: ['blocked-1'],
            queuedAt: now - 20_000,
            startedAt: now - 15_000,
            correlationId: 'corr-1',
          }],
          ['blocked-1', {
            id: 'blocked-1',
            kind: 'integration',
            title: 'Blocked integration task',
            status: 'blocked',
            owner: 'plugin:alpha',
            cancellable: false,
            parentTaskId: 'running-1',
            childTaskIds: [],
            queuedAt: now - 18_000,
            startedAt: now - 17_000,
            error: 'waiting on dependency',
          }],
          ['failed-1', {
            id: 'failed-1',
            kind: 'daemon',
            title: 'Failed daemon task',
            status: 'failed',
            owner: 'daemon-server',
            cancellable: true,
            childTaskIds: [],
            queuedAt: now - 60_000,
            startedAt: now - 55_000,
            endedAt: now - 50_000,
            error: 'boom',
          }],
          ['completed-1', {
            id: 'completed-1',
            kind: 'scheduler',
            title: 'Completed scheduler task',
            status: 'completed',
            owner: 'scheduler',
            cancellable: false,
            childTaskIds: [],
            queuedAt: now - 120_000,
            startedAt: now - 100_000,
            endedAt: now - 95_000,
            result: { ok: true },
          }],
        ]),
        queuedIds: ['queued-1'],
        runningIds: ['running-1'],
        blockedIds: ['blocked-1'],
        totalCreated: 5,
        totalCompleted: 1,
        totalFailed: 1,
        totalCancelled: 0,
        maxConcurrency: 8,
      },
    }));

    const panel = new TasksPanel(store);
    const initial = linesText(panel.render(120, 24));
    expect(initial).toContain('Posture');
    expect(initial).toContain('queued 1');
    expect(initial).toContain('running 1');
    expect(initial).toContain('blocked 1');
    expect(initial).toContain('failed 1');
    expect(initial).toContain('completed 1');
    expect(initial).toContain('/teamwork review');
    expect(initial).toContain('Queued task');
    expect(initial).toContain('Status: queued');

    panel.handleInput('down');
    const second = linesText(panel.render(120, 24));
    expect(second).toContain('Running agent task');
    expect(second).toContain('Owner: agent-orchestrator');
    expect(second).toContain('Children: blocked-1');
    expect(second).toContain('Correlation:');
    expect(second).toContain('Worktrees:');
    expect(second).toContain('/worktree recover task running-1');
    expect(second).toContain('running');

    panel.handleInput('end');
    const last = linesText(panel.render(120, 24));
    expect(last).toContain('Completed scheduler task');
    expect(last).toContain('Result:');
  });

  test('is registered as a built-in panel when a runtime store is provided', () => {
    const manager = new PanelManager();
    registerBuiltinPanels(manager, {
      runtimeBus: {} as RuntimeEventBus,
      runtimeStore: createRuntimeStore(),
    });
    expect(manager.getRegisteredTypes().some((entry) => entry.id === 'tasks')).toBe(true);
  });

  test('provider accounts, local auth, and settings sync panels render posture-first summaries', async () => {
    const { ProviderAccountsPanel } = await import('../../panels/provider-accounts-panel.ts');
    const { LocalAuthPanel } = await import('../../panels/local-auth-panel.ts');
    const { SettingsSyncPanel } = await import('../../panels/settings-sync-panel.ts');
    const { getConfigManager } = await import('../../config/index.ts');

    const accountsPanel = new ProviderAccountsPanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const accountsText = linesText(accountsPanel.render(120, 18));
    expect(accountsText).toContain('Posture');
    expect(accountsText).toContain('/accounts repair <provider>');

    const authText = linesText(new LocalAuthPanel().render(120, 18));
    expect(authText).toContain('Posture');
    expect(authText).toContain('/auth local rotate-password <user> <password>');

    const settingsText = linesText(new SettingsSyncPanel(getConfigManager()).render(120, 20));
    expect(settingsText).toContain('Posture');
    expect(settingsText).toContain('/settingssync conflicts');
    expect(settingsText).toContain('/managed review');
  });
});
