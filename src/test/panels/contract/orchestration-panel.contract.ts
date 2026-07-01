import { describe, test, expect } from 'bun:test';
import { OrchestrationPanel } from '../../../panels/orchestration-panel.ts';
import { runBasePanelContractSuite, W, H } from './_shared.ts';

runBasePanelContractSuite({
  label: 'OrchestrationPanel (no readModel)',
  factory: () => new OrchestrationPanel(),
});

// ---------------------------------------------------------------------------
// OrchestrationPanel — populated readModel contract
// ---------------------------------------------------------------------------

describe('OrchestrationPanel — populated readModel', () => {
  const makeReadModel = () => ({
    getSnapshot: () => ({
      graphs: [
        {
          id: 'graph-abc12345',
          title: 'Wave B2 migration batch',
          mode: 'parallel',
          status: 'running',
          nodeOrder: ['node-1'],
          nodes: new Map([['node-1', {
            id: 'node-1',
            role: 'worker',
            title: 'migrate panel',
            status: 'running',
            dependencyNodeIds: [],
            contract: null,
          }]]),
          createdAt: Date.now() - 5000,
          startedAt: Date.now() - 4000,
          endedAt: undefined,
          lastRecursionGuard: undefined,
        },
      ],
      totalGraphs: 1,
      activeGraphIds: ['graph-abc12345'],
      totalCompletedGraphs: 0,
      totalFailedGraphs: 0,
      recursionGuardTrips: 0,
    }),
    subscribe: (_cb: () => void) => () => {},
  } as unknown as import('../../../runtime/ui-read-models.ts').UiReadModel<import('../../../runtime/ui-read-models.ts').UiOrchestrationSnapshot>);

  test('render() returns exactly H lines with populated readModel', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with populated readModel', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: graph title appears in rendered output', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('Wave B2');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(1);
  });
});
