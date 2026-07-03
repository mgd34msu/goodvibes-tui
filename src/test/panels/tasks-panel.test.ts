import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createInitialTasksState } from '@/runtime/index.ts';
import type { OpsApi } from '@/runtime/index.ts';
import { TasksPanel } from '../../panels/tasks-panel.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { Line } from '../../types/grid.ts';
import type { UiWorktreeSnapshot } from '../../runtime/ui-read-models.ts';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createStaticUiReadModel, createTasksReadModel } from '../helpers/ui-read-models.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

// Seam-stubbed OpsApi — records every dispatched call (mirrors the stub in
// ops-control-panel.test.ts) so tests can assert TasksPanel drives the real
// cancel interface rather than mutating local state.
interface RecordedOpsCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeStubOpsApi(): OpsApi & { readonly calls: RecordedOpsCall[] } {
  const calls: RecordedOpsCall[] = [];
  const notImplemented = () => { throw new Error('not implemented in stub'); };
  return {
    calls,
    tasks: {
      snapshot: () => ({ tasks: [] }),
      list: () => [],
      get: () => null,
      running: () => [],
      create: notImplemented,
      update: notImplemented,
      complete: notImplemented,
      fail: notImplemented,
      cancel: (taskId: string, note?: string) => { calls.push({ method: 'tasks.cancel', args: [taskId, note] }); },
      pause: notImplemented,
      resume: notImplemented,
      retry: notImplemented,
    },
    agents: {
      cancel: notImplemented,
    },
  } as unknown as OpsApi & { readonly calls: RecordedOpsCall[] };
}

describe('TasksPanel', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-tasks-panel-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createConfigManager(): ConfigManager {
    return new ConfigManager({ surfaceRoot: 'tui',
      workingDir: root,
      homeDir: root,
      configDir: join(root, '.goodvibes', 'global-tui'),
    });
  }

  test('renders empty guidance when no tasks exist', () => {
    const store = createRuntimeStore();
    const panel = new TasksPanel(createTasksReadModel(store));
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Task Control Room');
    expect(text).toContain('No tasks recorded yet');
  });

  test('renders task summaries and selection detail from the runtime store', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    const worktrees = createStaticUiReadModel<UiWorktreeSnapshot>({
      summary: {
        total: 1,
        active: 0,
        paused: 1,
        pendingCleanup: 0,
        discard: 0,
      },
      records: [{
        path: join(root, '.goodvibes', '.worktrees', 'agent-running'),
        kind: 'agent',
        state: 'paused',
        ownerId: 'agent-running',
        taskId: 'queued-1',
        sessionId: 'sess-1',
        updatedAt: now,
      }],
    });
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
            childTaskIds: ['blocked-1'],
            queuedAt: now - 5_000,
            correlationId: 'corr-1',
          }],
          ['running-1', {
            id: 'running-1',
            kind: 'agent',
            title: 'Running agent task',
            status: 'running',
            owner: 'agent-orchestrator',
            cancellable: true,
            childTaskIds: [],
            queuedAt: now - 20_000,
            startedAt: now - 15_000,
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

    const panel = new TasksPanel(createTasksReadModel(store), worktrees);
    const initial = linesText(panel.render(120, 24));
    expect(initial).toContain('Task posture');
    expect(initial).toContain('queued 1');
    expect(initial).toContain('running 1');
    expect(initial).toContain('blocked 1');
    expect(initial).toContain('failed 1');
    expect(initial).toContain('completed 1');
    expect(initial).toContain('/teamwork review');
    expect(initial).toContain('Queued task');
    // WO-131: the deep per-task field dump no longer renders inline in list
    // mode — it moves behind an Enter-toggled detail view so the list itself
    // keeps full viewport.
    expect(initial).not.toContain('Status: queued');

    // Enter on the selected (non-agent) task opens the detail view — this is
    // where the deep fields (children/correlation/worktrees) now live.
    panel.handleInput('enter');
    const detail = linesText(panel.render(120, 24));
    expect(detail).toContain('Status: queued');
    expect(detail).toContain('Children: blocked-1');
    expect(detail).toContain('Correlation:');
    expect(detail).toContain('Worktrees:');
    expect(detail).toContain('review worktree ownership');

    // Esc collapses back to the list, which keeps the posture summary.
    panel.handleInput('escape');
    const backToList = linesText(panel.render(120, 24));
    expect(backToList).toContain('Task posture');
    expect(backToList).not.toContain('Status: queued');

    // Down selects the agent-kind task — Enter does NOT open a local detail
    // view for it (subagent detail lives in the Inspector panel); it queues
    // an agent-jump follow-up instead.
    panel.handleInput('down');
    expect(panel.consumePendingFollowUp()).toBeNull(); // nothing queued yet
    panel.handleInput('enter');
    expect(panel.consumePendingFollowUp()).toEqual({ kind: 'agent-jump', agentId: 'agent-orchestrator' });
    // Re-render still shows the list, not a local detail dump for the agent task.
    const afterAgentEnter = linesText(panel.render(120, 24));
    expect(afterAgentEnter).not.toContain('Correlation:');

    panel.handleInput('end');
    panel.handleInput('enter');
    const last = linesText(panel.render(120, 24));
    expect(last).toContain('Completed scheduler task');
    expect(last).toContain('Result:');
  });

  test('Enter on a non-agent task detail view queues the worktree-review follow-up, dispatched via ctx.executeCommand', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([
          ['exec-1', {
            id: 'exec-1',
            kind: 'exec',
            title: 'Exec task',
            status: 'running',
            owner: 'shell',
            cancellable: true,
            childTaskIds: [],
            queuedAt: now - 5_000,
            startedAt: now - 4_000,
          }],
        ]),
        queuedIds: [],
        runningIds: ['exec-1'],
        totalCreated: 1,
      },
    }));
    const panel = new TasksPanel(createTasksReadModel(store));

    panel.handleInput('enter'); // open detail view
    expect(panel.consumePendingFollowUp()).toBeNull(); // opening detail queues nothing
    panel.handleInput('enter'); // second Enter, already in detail mode
    expect(panel.consumePendingFollowUp()).toEqual({ kind: 'worktree-review', taskId: 'exec-1' });
    // consuming clears it — a third read returns null
    expect(panel.consumePendingFollowUp()).toBeNull();
  });

  test('c cancels a cancellable task via OpsApi.tasks.cancel behind the confirm contract', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([
          ['cancellable-1', {
            id: 'cancellable-1',
            kind: 'exec',
            title: 'Cancellable task',
            status: 'running',
            owner: 'shell',
            cancellable: true,
            childTaskIds: [],
            queuedAt: now - 5_000,
            startedAt: now - 4_000,
          }],
        ]),
        runningIds: ['cancellable-1'],
        totalCreated: 1,
      },
    }));
    const opsApi = makeStubOpsApi();
    const panel = new TasksPanel(createTasksReadModel(store), undefined, opsApi);

    panel.handleInput('c');
    expect(opsApi.calls).toHaveLength(0); // confirm pending, not yet dispatched
    const confirming = linesText(panel.render(120, 20));
    expect(confirming).toContain('Cancel');

    panel.handleInput('y');
    expect(opsApi.calls).toEqual([{ method: 'tasks.cancel', args: ['cancellable-1', undefined] }]);
  });

  test('c is a no-op for a non-cancellable task', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([
          ['locked-1', {
            id: 'locked-1',
            kind: 'scheduler',
            title: 'Non-cancellable task',
            status: 'completed',
            owner: 'scheduler',
            cancellable: false,
            childTaskIds: [],
            queuedAt: now - 5_000,
          }],
        ]),
        totalCreated: 1,
      },
    }));
    const opsApi = makeStubOpsApi();
    const panel = new TasksPanel(createTasksReadModel(store), undefined, opsApi);

    const consumed = panel.handleInput('c');
    expect(consumed).toBe(false);
    expect(opsApi.calls).toHaveLength(0);
  });

  test('selection is preserved across onActivate (WO-131)', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([
          ['t1', { id: 't1', kind: 'exec', title: 'Task one', status: 'queued', owner: 'shell', cancellable: true, childTaskIds: [], queuedAt: now - 3_000 }],
          ['t2', { id: 't2', kind: 'exec', title: 'Task two', status: 'queued', owner: 'shell', cancellable: true, childTaskIds: [], queuedAt: now - 2_000 }],
        ]),
        queuedIds: ['t1', 't2'],
        totalCreated: 2,
      },
    }));
    const panel = new TasksPanel(createTasksReadModel(store));
    panel.render(120, 20);
    panel.handleInput('down');
    const selectedBefore = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(selectedBefore).toBe(1);

    panel.onActivate();
    const selectedAfter = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(selectedAfter).toBe(selectedBefore);
  });

  test('context-aware footer reflects browse vs filter state', () => {
    const store = createRuntimeStore();
    const now = Date.now();
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
        ]),
        queuedIds: ['queued-1'],
        totalCreated: 1,
      },
    }));
    const panel = new TasksPanel(createTasksReadModel(store));

    const browse = linesText(panel.render(120, 20));
    // Browsing footer shows position + the navigation/filter affordances.
    expect(browse).toContain('1/1');
    expect(browse).toContain('filter');

    // Enter filter mode: footer must switch to the keys that work while typing.
    panel.handleInput('/');
    const filtering = linesText(panel.render(120, 20));
    expect(filtering).toContain('filter tasks');
    expect(filtering).toContain('apply');
    expect(filtering).toContain('clear');
  });

  test('is registerable in a panel manager when a runtime store is provided', () => {
    const manager = new PanelManager();
    manager.registerType({
      id: 'tasks',
      name: 'Tasks',
      icon: 'T',
      category: 'session',
      description: 'Task Control Room',
      factory: () => new TasksPanel(createTasksReadModel(createRuntimeStore())),
    });
    expect(manager.getRegisteredTypes().some((entry) => entry.id === 'tasks')).toBe(true);
  });

  test('local auth and settings sync panels render posture-first summaries', async () => {
    const { LocalAuthPanel } = await import('../../panels/local-auth-panel.ts');
    const { SettingsSyncPanel } = await import('../../panels/settings-sync-panel.ts');

    const authText = linesText(new LocalAuthPanel(new UserAuthManager({
      bootstrapFilePath: join(root, '.goodvibes', 'tui', 'auth-users.json'),
      bootstrapCredentialPath: join(root, '.goodvibes', 'tui', 'auth-bootstrap.txt'),
    })).render(120, 18));
    expect(authText).toContain('Local auth posture');
    // WO-139: p/a/d are now real in-panel keys (rotate/add/delete), not a
    // printed "/auth local rotate-password <user>" signpost.
    expect(authText).toContain('rotate password');
    expect(authText).toContain('masked in-panel entry');
    // Masked-entry guidance replaced the argv-password form; the old string must never return.
    expect(authText).not.toContain('<user> <password>');

    const settingsText = linesText(new SettingsSyncPanel(createConfigManager()).render(120, 20));
    expect(settingsText).toContain('Settings posture');
    // WO-124: conflict resolution and managed review are now bound to real
    // keys (Enter / m), not printed as slash-command signposts.
    expect(settingsText).not.toContain('/settings-sync conflicts');
    expect(settingsText).not.toContain('/managed review');
    expect(settingsText).toContain('resolve conflict');
    expect(settingsText).toContain('managed review');
  });
});
