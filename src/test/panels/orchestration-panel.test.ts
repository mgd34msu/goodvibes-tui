import { describe, expect, test } from 'bun:test';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createInitialOrchestrationState } from '@/runtime/index.ts';
import { OrchestrationPanel } from '../../panels/orchestration-panel.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { SystemMessagesPanel } from '../../panels/system-messages-panel.ts';
import type { Line } from '../../types/grid.ts';
import { createOrchestrationReadModel } from '../helpers/ui-read-models.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('OrchestrationPanel', () => {
  test('renders empty guidance when no graphs exist', () => {
    const store = createRuntimeStore();
    const panel = new OrchestrationPanel(createOrchestrationReadModel(store));
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Orchestration Control Room');
    expect(text).toContain('Orchestration posture');
    expect(text).toContain('No orchestration graphs recorded yet');
  });

  test('renders graphs, nodes, and recursion guard details from the runtime store', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...createInitialOrchestrationState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        graphs: new Map([
          ['graph-a', {
            id: 'graph-a',
            title: 'Parallel review graph',
            mode: 'parallel-workers',
            status: 'running',
            nodeOrder: ['node-1', 'node-2'],
            nodes: new Map([
              ['node-1', {
                id: 'node-1',
                title: 'Engineer slice',
                role: 'engineer',
                status: 'running',
                childNodeIds: [],
                dependencyNodeIds: [],
                startedAt: now - 10_000,
                contract: {
                  allowedTools: ['read', 'edit', 'write'],
                  capabilityCeiling: ['read', 'edit', 'write'],
                  requiredEvidence: ['diff summary', 'tests'],
                  writeScope: ['src/runtime', 'src/tools'],
                  executionProtocol: 'gather-plan-apply',
                  reviewMode: 'wrfc',
                  inheritsParentConstraints: true,
                  communicationLane: 'parent-only',
                },
              }],
              ['node-2', {
                id: 'node-2',
                title: 'Review slice',
                role: 'reviewer',
                status: 'blocked',
                childNodeIds: [],
                dependencyNodeIds: ['node-1'],
                error: 'waiting on engineer',
              }],
            ]),
            createdAt: now - 20_000,
            startedAt: now - 15_000,
            lastRecursionGuard: {
              depth: 2,
              activeAgents: 6,
              reason: 'spawn breadth limit reached',
              nodeId: 'node-1',
              triggeredAt: now - 5_000,
            },
          }],
        ]),
        activeGraphIds: ['graph-a'],
        totalGraphs: 1,
        totalCompletedGraphs: 0,
        totalFailedGraphs: 0,
        recursionGuardTrips: 1,
      },
    }));

    const panel = new OrchestrationPanel(createOrchestrationReadModel(store));
    // Tall viewport: this render exercises every section (posture, graphs,
    // selected-graph detail with full node contract, nodes, and the new
    // guard-trip history list), which needs more than a minimal 18 rows.
    const text = linesText(panel.render(140, 32));
    expect(text).toContain('Orchestration posture');
    expect(text).toContain('graphs');
    // WO-131: the self-referential "/orchestration" guidance line is removed —
    // the panel no longer tells the operator to reopen the panel they're in.
    expect(text).not.toContain('/orchestration');
    expect(text).toContain('Parallel review graph');
    expect(text).toContain('Engineer slice');
    expect(text).toContain('Review slice');
    expect(text).toContain('deps:1');
    // WO-131: node contract exposes full values (allowedTools/requiredEvidence/
    // writeScope), not just counts — for whichever node the node-cursor points
    // at (defaults to the first node).
    expect(text).toContain('Allowed tools:');
    expect(text).toContain('read, edit, write');
    expect(text).toContain('Required evidence:');
    expect(text).toContain('diff summary, tests');
    expect(text).toContain('Write scope:');
    expect(text).toContain('src/runtime, src/tools');
    expect(text).toContain('gather-plan-apply');
    expect(text).toContain('wrfc');
    expect(text).toContain('parent-only');
    // WO-131: recursion guard trips render as a history list, not just a
    // single inline "Recursion guard:" line off the last-trip pointer.
    expect(text).toContain('Guard trips');
    expect(text).toContain('spawn breadth limit reached');
    // New UX: selected-graph detail surfaces live/duration, footer surfaces
    // position + only the keys that work in this view.
    expect(text).toContain('Live:');
    expect(text).toContain('Duration:');
    expect(text).toContain('1/1');
    expect(text).toContain('select');
  });

  test('node cursor: Tab switches graph/node focus, up/down moves the node cursor, and the contract panel follows it', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...createInitialOrchestrationState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        graphs: new Map([
          ['graph-a', {
            id: 'graph-a',
            title: 'Two-node graph',
            mode: 'parallel-workers',
            status: 'running',
            nodeOrder: ['node-1', 'node-2'],
            nodes: new Map([
              ['node-1', {
                id: 'node-1',
                title: 'Planner node',
                role: 'planner',
                status: 'completed',
                childNodeIds: [],
                dependencyNodeIds: [],
                contract: { allowedTools: ['plan'], executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'direct' },
              }],
              ['node-2', {
                id: 'node-2',
                title: 'Engineer node',
                role: 'engineer',
                status: 'running',
                childNodeIds: [],
                dependencyNodeIds: ['node-1'],
                agentId: 'agent-eng-1',
                taskId: 'task-eng-1',
                contract: { allowedTools: ['read', 'write'], executionProtocol: 'gather-plan-apply', reviewMode: 'wrfc', communicationLane: 'cohort' },
              }],
            ]),
            createdAt: now - 10_000,
            startedAt: now - 9_000,
          }],
        ]),
        activeGraphIds: ['graph-a'],
        totalGraphs: 1,
        recursionGuardTrips: 0,
      },
    }));

    const panel = new OrchestrationPanel(createOrchestrationReadModel(store));
    const initial = linesText(panel.render(140, 20));
    // Before Tab, the node cursor defaults to the first node's contract.
    expect(initial).toContain('direct');

    panel.handleInput('tab'); // graph focus -> node focus
    panel.handleInput('down'); // move node cursor from node-1 to node-2
    const afterNodeMove = linesText(panel.render(140, 20));
    expect(afterNodeMove).toContain('gather-plan-apply');
    expect(afterNodeMove).toContain('wrfc');
    expect(afterNodeMove).toContain('cohort');

    // Enter on the node-focused, agent-backed node-2 queues an agent-jump.
    panel.handleInput('enter');
    expect(panel.consumePendingNodeJump()).toEqual({ kind: 'agent-jump', id: 'agent-eng-1' });

    panel.handleInput('up'); // back to node-1 (no agentId/taskId)
    panel.handleInput('enter');
    expect(panel.consumePendingNodeJump()).toBeNull();
  });

  test('selection is stable across re-sorts, keyed by graph id (WO-131)', () => {
    const store = createRuntimeStore();
    const now = Date.now();
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...createInitialOrchestrationState(),
        revision: 1,
        lastUpdatedAt: now,
        source: 'test',
        graphs: new Map([
          ['graph-old', {
            id: 'graph-old',
            title: 'Older graph',
            mode: 'single-worker',
            status: 'running',
            nodeOrder: [],
            nodes: new Map(),
            createdAt: now - 10_000,
          }],
        ]),
        activeGraphIds: ['graph-old'],
        totalGraphs: 1,
      },
    }));

    const panel = new OrchestrationPanel(createOrchestrationReadModel(store));
    panel.render(140, 18); // establishes selection on graph-old

    // A newer graph is created — it sorts ahead of graph-old (createdAt desc),
    // which would silently shift a raw-index selection onto the wrong graph.
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...state.orchestration,
        graphs: new Map([
          ...state.orchestration.graphs,
          ['graph-new', {
            id: 'graph-new',
            title: 'Newer graph',
            mode: 'single-worker',
            status: 'running',
            nodeOrder: [],
            nodes: new Map(),
            createdAt: now,
          }],
        ]),
        totalGraphs: 2,
      },
    }));

    const text = linesText(panel.render(140, 18));
    expect(text).toContain('Older graph'); // still selected/shown in detail, not silently swapped
    const selectedIndex = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(selectedIndex).toBe(1); // graph-old is now second (newer graph sorts first)
  });

  test('is registered as a built-in panel when a runtime store is provided', () => {
    const manager = new PanelManager();
    const root = process.cwd();
    const services = createRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'tui',
        workingDir: root,
        homeDir: root,
        configDir: `${root}/.goodvibes/test-orchestration-panel`,
      }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir: root,
      homeDirectory: root,
    });
    const uiServices = createUiRuntimeServices(services);
    registerBuiltinPanels(manager, {
      providerRegistry: services.providerRegistry,
      uiServices,
      tokenAuditor: services.tokenAuditor,
      componentHealthMonitor: services.componentHealthMonitor,
      worktreeRegistry: services.worktreeRegistry,
      sandboxSessionRegistry: services.sandboxSessionRegistry,
      systemMessagesPanel: new SystemMessagesPanel(services.configManager, services.componentHealthMonitor),
    });
    expect(manager.getRegisteredTypes().some((entry) => entry.id === 'orchestration')).toBe(true);
  });
});
