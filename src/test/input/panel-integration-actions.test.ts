import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePanelIntegrationAction } from '../../input/handler.ts';
import { FileExplorerPanel } from '../../panels/file-explorer-panel.ts';
import { FilePreviewPanel } from '../../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';
import { ApprovalPanel } from '../../panels/approval-panel.ts';
import { TasksPanel } from '../../panels/tasks-panel.ts';
import { OrchestrationPanel } from '../../panels/orchestration-panel.ts';
import { AgentInspectorPanel } from '../../panels/agent-inspector-panel.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createInitialTasksState, createInitialOrchestrationState } from '@/runtime/index.ts';
import { createTasksReadModel, createOrchestrationReadModel } from '../helpers/ui-read-models.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
}

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Register a 'diff' panel type whose showFileDiffs calls are captured instead of shelling out to git. */
function registerCapturingDiffPanel(
  panelManager: ReturnType<typeof createTestManagers>['panelManager'],
  workingDirectory: string,
): Array<{ files: string[]; ref?: string }> {
  const calls: Array<{ files: string[]; ref?: string }> = [];
  panelManager.registerType({
    id: 'diff',
    name: 'Diff',
    icon: 'D',
    category: 'development',
    description: 'diff',
    factory: () => {
      const diffPanel = new DiffPanel(workingDirectory);
      diffPanel.showFileDiffs = (async (files: string[], ref?: string) => {
        calls.push({ files, ref });
      }) as typeof diffPanel.showFileDiffs;
      return diffPanel;
    },
  });
  return calls;
}

function registerInspectorPanel(panelManager: ReturnType<typeof createTestManagers>['panelManager']) {
  const agentManager = {
    list: mock(() => []),
    getStatus: mock(() => null),
    cancel: mock(() => true),
  };
  const agentMessageBus = { getMessages: mock(() => []) };
  const agentEvents = {
    on: () => () => {},
    onEnvelope: () => () => {},
    emit: () => {},
  } as unknown as import('../../runtime/ui-events.ts').UiEventFeed<import('@/runtime/index.ts').AgentEvent>;

  panelManager.registerType({
    id: 'inspector',
    name: 'Inspector',
    icon: 'I',
    category: 'agent',
    description: 'inspector',
    factory: () => new AgentInspectorPanel({
      agentManager,
      agentMessageBus,
      workingDirectory: '/tmp/test',
      cancelAgent: () => true,
      agentEvents,
    }),
  });
}

let panelManager = createTestManagers().panelManager;

// SymbolOutlinePanel.loadFile() parses via a background tree-sitter query
// (WASM), so tests that need parsed symbols poll until getSelectedLocation()
// resolves rather than asserting synchronously right after loadFile().
async function waitForSymbolLocation(
  panel: SymbolOutlinePanel,
  timeoutMs = 2000,
): Promise<{ path: string; line: number } | null> {
  const start = Date.now();
  let location = panel.getSelectedLocation();
  while (location === null && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
    location = panel.getSelectedLocation();
  }
  return location;
}

describe('panel integration actions', () => {
  afterEach(() => {
    panelManager.destroyAll();
    mock.restore();
  });

  test('explorer selection opens the file in preview and syncs symbols', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-bridge-'));
    const filePath = join(root, 'demo.ts');
    writeFileSync(filePath, 'export function alpha() {}\nexport const beta = 1;\n');

    panelManager = createTestManagers().panelManager;
    panelManager.registerType({
      id: 'preview',
      name: 'Preview',
      icon: 'P',
      category: 'development',
      description: 'preview',
      factory: () => new FilePreviewPanel(),
    });
    panelManager.registerType({
      id: 'symbols',
      name: 'Symbols',
      icon: 'S',
      category: 'development',
      description: 'symbols',
      factory: () => new SymbolOutlinePanel(),
    });

    const symbolsPanel = panelManager.open('symbols', 'top');
    expect(symbolsPanel).toBeInstanceOf(SymbolOutlinePanel);

    const explorer = new FileExplorerPanel(root, root);
    explorer.onActivate();
    await explorer.awaitReady();

    expect(handlePanelIntegrationAction(panelManager, explorer, 'enter')).toBe(true);

    const preview = panelManager.getPanel('preview');
    expect(preview).toBeInstanceOf(FilePreviewPanel);
    expect((preview as FilePreviewPanel).getCurrentFilePath()).toBe(filePath);

    const symbols = panelManager.getPanel('symbols');
    expect(symbols).toBeInstanceOf(SymbolOutlinePanel);
    const location = await waitForSymbolLocation(symbols as SymbolOutlinePanel);
    expect(location).toEqual({ path: filePath, line: 1 });

    rmSync(root, { recursive: true, force: true });
  });

  test('WO-133: explorer lazily loads a directory\'s children on expand instead of an eager recursive scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-lazy-'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'deep.ts'), 'export const x = 1;\n');

    const explorer = new FileExplorerPanel(root, root);
    explorer.onActivate();
    await explorer.awaitReady();

    // The initial (lazy) build only loads the root's immediate children —
    // 'nested' shows up as an unexpanded directory row; its own contents
    // are not read from disk until it is actually expanded.
    expect(explorer.getFocusedNode()?.name).toBe('nested');
    expect(explorer.handleInput('right')).toBe(true); // expand -> triggers the lazy per-directory load

    // render() is non-destructive to cursor state, unlike handleInput('down'),
    // so it's safe to poll while the async per-directory load settles.
    await waitFor(() => linesText(explorer.render(80, 20)).includes('deep.ts'));
    expect(explorer.handleInput('down')).toBe(true);
    expect(explorer.getFocusedFilePath()).toBe(join(root, 'nested', 'deep.ts'));

    rmSync(root, { recursive: true, force: true });
  });

  test('WO-133: explorer d diffs the focused file against HEAD via the DiffPanel bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-diff-explorer-'));
    const filePath = join(root, 'demo.ts');
    writeFileSync(filePath, 'export const a = 1;\n');

    panelManager = createTestManagers().panelManager;
    const diffCalls = registerCapturingDiffPanel(panelManager, root);

    const explorer = new FileExplorerPanel(root, root);
    explorer.onActivate();
    await explorer.awaitReady();

    expect(explorer.handleInput('d')).toBe(true);
    expect(handlePanelIntegrationAction(panelManager, explorer, 'd')).toBe(true);

    expect(diffCalls).toEqual([{ files: [filePath], ref: 'HEAD' }]);
    expect(panelManager.getPanel('diff')).toBeInstanceOf(DiffPanel);

    rmSync(root, { recursive: true, force: true });
  });

  test('WO-133: preview d diffs the open file against HEAD via the DiffPanel bridge', () => {
    panelManager = createTestManagers().panelManager;
    const diffCalls = registerCapturingDiffPanel(panelManager, '/tmp');

    const preview = new FilePreviewPanel();
    preview.openFile('/tmp/gv-panel-diff-preview-demo/demo.ts'); // path only matters for 'd' — no read required

    expect(preview.handleInput('d')).toBe(true);
    expect(handlePanelIntegrationAction(panelManager, preview, 'd')).toBe(true);

    expect(diffCalls).toEqual([{ files: ['/tmp/gv-panel-diff-preview-demo/demo.ts'], ref: 'HEAD' }]);
  });

  test('WO-133: preview r reloads the file from disk and re-syncs the symbol outline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-reload-'));
    const filePath = join(root, 'demo.ts');
    writeFileSync(filePath, 'export function alpha() {}\n');

    panelManager = createTestManagers().panelManager;
    panelManager.registerType({
      id: 'preview',
      name: 'Preview',
      icon: 'P',
      category: 'development',
      description: 'preview',
      factory: () => new FilePreviewPanel(),
    });
    panelManager.registerType({
      id: 'symbols',
      name: 'Symbols',
      icon: 'S',
      category: 'development',
      description: 'symbols',
      factory: () => new SymbolOutlinePanel(),
    });
    panelManager.open('symbols', 'top');

    const preview = panelManager.open('preview', 'top') as FilePreviewPanel;
    preview.openFile(filePath);
    const symbols = panelManager.getPanel('symbols') as SymbolOutlinePanel;
    symbols.loadFile(filePath, 'export function alpha() {}\n');
    await waitForSymbolLocation(symbols);

    // Simulate an agent edit landing on disk after the preview was opened.
    writeFileSync(filePath, 'export function alpha() {}\nexport function beta() {}\n');

    expect(preview.handleInput('r')).toBe(true);
    expect(handlePanelIntegrationAction(panelManager, preview, 'r')).toBe(true);

    await waitFor(() => (preview.getSource() ?? '').includes('beta'));
    expect(preview.getSource()).toContain('beta');

    // The outline re-parse runs on a background tree-sitter query — poll its
    // rendered rows for the newly-added symbol rather than asserting the
    // instant handlePanelIntegrationAction() returns.
    await waitFor(() => linesText(symbols.render(80, 20)).includes('beta'));
    expect(linesText(symbols.render(80, 20))).toContain('beta');

    rmSync(root, { recursive: true, force: true });
  });

  test('symbol enter jumps preview to the selected location', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-bridge-'));
    const filePath = join(root, 'demo.ts');
    writeFileSync(filePath, 'export function alpha() {}\nexport function beta() {}\n');

    panelManager = createTestManagers().panelManager;
    panelManager.registerType({
      id: 'preview',
      name: 'Preview',
      icon: 'P',
      category: 'development',
      description: 'preview',
      factory: () => new FilePreviewPanel(),
    });

    const preview = panelManager.open('preview', 'top') as FilePreviewPanel;
    preview.openFile(filePath);

    const symbols = new SymbolOutlinePanel();
    symbols.loadFile(filePath, 'export function alpha() {}\nexport function beta() {}\n');
    await waitForSymbolLocation(symbols); // wait for the background parse to populate rows
    symbols.handleInput('down');

    expect(handlePanelIntegrationAction(panelManager, symbols, 'enter')).toBe(true);
    expect(preview.getCurrentFilePath()).toBe(filePath);
    expect(preview.getScrollOffset()).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  test('symbol enter is not swallowed when there is no symbol selected', () => {
    const symbols = new SymbolOutlinePanel(); // no file loaded — nothing to select
    expect(symbols.handleInput('enter')).toBe(false);
    expect(handlePanelIntegrationAction(panelManager, symbols, 'enter')).toBe(false);
  });

  test('approval enter executes the selected review command', async () => {
    const executeCommand = mock(async () => true);
    // The panel is data-driven: it surfaces the live permission-audit requests
    // and resolves the next-step review command from the selected request's
    // lane. Seed a pending "file"-lane request so Enter dispatches its review.
    const policyDep = {
      getSnapshot: () => ({
        recentPermissionAudit: [{
          callId: 'call-0',
          tool: 'Write',
          category: 'file',
          approved: undefined,
          riskLevel: 'high',
          classification: 'destructive',
          summary: 'write secret-bearing config',
          reasons: ['config mutation'],
          requestedAt: Date.now() - 5000,
        }],
      }),
    } as unknown as ConstructorParameters<typeof ApprovalPanel>[0];
    const panel = new ApprovalPanel(policyDep);
    panel.handleInput('down');

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter', { executeCommand } as never)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('approval', ['review', 'file']);
  });

  test('WO-131: Tasks Enter on an agent-kind task jumps to the Inspector and inspects that agent', () => {
    panelManager = createTestManagers().panelManager;
    registerInspectorPanel(panelManager);

    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([['agent-task-1', {
          id: 'agent-task-1',
          kind: 'agent',
          title: 'Delegated agent task',
          status: 'running',
          owner: 'agent-77',
          cancellable: true,
          childTaskIds: [],
          queuedAt: now - 1_000,
        }]]),
        runningIds: ['agent-task-1'],
        totalCreated: 1,
      },
    }));
    const panel = new TasksPanel(createTasksReadModel(store));
    panel.handleInput('enter'); // queues the agent-jump follow-up

    // Open the Inspector once up front and patch inspectAgent so we can
    // assert the call without needing a fully live AgentManager status lookup.
    const inspector = panelManager.open('inspector', 'top') as AgentInspectorPanel;
    const inspectSpy = mock(() => {});
    inspector.inspectAgent = inspectSpy as never;

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter')).toBe(true);
    expect(inspectSpy).toHaveBeenCalledWith('agent-77');
  });

  test('WO-131: Tasks Enter (in detail mode, second press) dispatches the worktree-review follow-up via ctx.executeCommand', () => {
    panelManager = createTestManagers().panelManager;
    const executeCommand = mock(async () => true);

    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      tasks: {
        ...createInitialTasksState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        tasks: new Map([['exec-task-1', {
          id: 'exec-task-1',
          kind: 'exec',
          title: 'Exec task',
          status: 'running',
          owner: 'shell',
          cancellable: true,
          childTaskIds: [],
          queuedAt: now - 1_000,
        }]]),
        runningIds: ['exec-task-1'],
        totalCreated: 1,
      },
    }));
    const panel = new TasksPanel(createTasksReadModel(store));
    panel.handleInput('enter'); // opens detail mode — no follow-up queued yet
    panel.handleInput('enter'); // second press, already expanded — queues the follow-up

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter', { executeCommand } as never)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('worktree', ['task', 'exec-task-1']);
  });

  test('Tasks w dispatches the advertised /teamwork review via ctx.executeCommand', () => {
    panelManager = createTestManagers().panelManager;
    const executeCommand = mock(async () => true);

    const panel = new TasksPanel(createTasksReadModel(createRuntimeStore()));
    expect(panel.handleInput('w')).toBe(true); // queues the teamwork-review follow-up

    expect(handlePanelIntegrationAction(panelManager, panel, 'w', { executeCommand } as never)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('teamwork', ['review']);
  });

  test('WO-131: Orchestration Enter on a node-focused, agent-backed node jumps to the Inspector', () => {
    panelManager = createTestManagers().panelManager;
    registerInspectorPanel(panelManager);
    const inspector = panelManager.open('inspector', 'top') as AgentInspectorPanel;
    const inspectSpy = mock(() => {});
    inspector.inspectAgent = inspectSpy as never;

    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...createInitialOrchestrationState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        graphs: new Map([['graph-a', {
          id: 'graph-a',
          title: 'Graph A',
          mode: 'single-worker',
          status: 'running',
          nodeOrder: ['node-1'],
          nodes: new Map([['node-1', {
            id: 'node-1',
            title: 'Engineer node',
            role: 'engineer',
            status: 'running',
            childNodeIds: [],
            dependencyNodeIds: [],
            agentId: 'agent-node-1',
          }]]),
          createdAt: now,
        }]]),
        activeGraphIds: ['graph-a'],
        totalGraphs: 1,
      },
    }));
    const panel = new OrchestrationPanel(createOrchestrationReadModel(store));
    panel.render(140, 20); // establish selection
    panel.handleInput('tab'); // graph focus -> node focus
    panel.handleInput('enter'); // queues the agent-jump

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter')).toBe(true);
    expect(inspectSpy).toHaveBeenCalledWith('agent-node-1');
  });

  test('WO-131: Orchestration Enter on a node-focused, task-backed (non-agent) node jumps to Tasks', () => {
    panelManager = createTestManagers().panelManager;
    panelManager.registerType({
      id: 'tasks',
      name: 'Tasks',
      icon: 'J',
      category: 'runtime-ops',
      description: 'tasks',
      factory: () => new TasksPanel(createTasksReadModel(createRuntimeStore())),
    });

    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...createInitialOrchestrationState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        graphs: new Map([['graph-b', {
          id: 'graph-b',
          title: 'Graph B',
          mode: 'single-worker',
          status: 'running',
          nodeOrder: ['node-1'],
          nodes: new Map([['node-1', {
            id: 'node-1',
            title: 'Exec node',
            role: 'engineer',
            status: 'running',
            childNodeIds: [],
            dependencyNodeIds: [],
            taskId: 'task-abc',
          }]]),
          createdAt: now,
        }]]),
        activeGraphIds: ['graph-b'],
        totalGraphs: 1,
      },
    }));
    const panel = new OrchestrationPanel(createOrchestrationReadModel(store));
    panel.render(140, 20);
    panel.handleInput('tab');
    panel.handleInput('enter');

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter')).toBe(true);
    expect(panelManager.getPanel('tasks')).toBeInstanceOf(TasksPanel);
  });
});
