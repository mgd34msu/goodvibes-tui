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
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('Orchestration posture');
    expect(text).toContain('graphs');
    expect(text).toContain('/orchestration');
    expect(text).toContain('Parallel review graph');
    expect(text).toContain('Recursion guard');
    expect(text).toContain('spawn breadth limit reached');
    expect(text).toContain('Engineer slice');
    expect(text).toContain('Review slice');
    expect(text).toContain('deps:1');
    expect(text).toContain('Contract:');
    expect(text).toContain('tools 3');
    expect(text).toContain('write scope 2');
    expect(text).toContain('gather-plan-apply');
    expect(text).toContain('wrfc');
    expect(text).toContain('parent-only');
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
