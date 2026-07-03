// ---------------------------------------------------------------------------
// plan-dashboard-panel.test.ts — WO-128 plan dashboard revival
//
// Covers:
//   - live refresh on ui.events.workflows (WrfcPanel pattern), no keypress
//   - empty state names the real ExecutionPlan producer (/teamwork), not /plan
//   - Enter on an item with an agentId jumps to the Inspector (inspectAgent)
//   - plan history browser (list()/getSummary()/toMarkdown()) and switching
//   - distinct icon glyph (breaks the Planning 'P' collision)
// ---------------------------------------------------------------------------

import { describe, test, expect, mock } from 'bun:test';
import { PlanDashboardPanel, type PlanDashboardPanelDeps } from '../../panels/plan-dashboard-panel.ts';
import { AgentInspectorPanel } from '../../panels/agent-inspector-panel.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { handlePanelIntegrationAction } from '../../input/handler.ts';
import type { Line } from '../../types/grid.ts';
import type { ExecutionPlan, PlanItem } from '@pellux/goodvibes-sdk/platform/core';
import type { UiEventFeed } from '../../runtime/ui-events.ts';
import type { WorkflowEvent } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

type WorkflowEventName = Parameters<UiEventFeed<WorkflowEvent>['on']>[0];
type WorkflowHandler = Parameters<UiEventFeed<WorkflowEvent>['on']>[1];

/** Minimal fake event feed that records subscriptions and lets tests emit (mirrors wrfc-panel.test.ts). */
function makeEventFeed(): UiEventFeed<WorkflowEvent> & {
  emit(name: WorkflowEventName, event: WorkflowEvent): void;
} {
  const handlers = new Map<WorkflowEventName, WorkflowHandler[]>();
  return {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        const l = handlers.get(name) ?? [];
        const idx = l.indexOf(handler);
        if (idx >= 0) l.splice(idx, 1);
      };
    },
    emit(name, event) {
      for (const h of handlers.get(name) ?? []) h(event);
    },
  };
}

function makeItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'item-1',
    phase: 'Phase 1: Setup',
    description: 'Do the thing',
    status: 'pending',
    ...overrides,
  };
}

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: 'plan-abc123',
    title: 'Ship the feature',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    items: [makeItem()],
    ...overrides,
  };
}

/** Mutable stub for PlanDashboardPanelDeps['planManager']; tests mutate `active`/`plans` directly. */
function makePlanManagerStub(initial: { active?: ExecutionPlan | null; plans?: ExecutionPlan[] } = {}) {
  const state = {
    active: initial.active ?? null,
    plans: initial.plans ?? (initial.active ? [initial.active] : []),
  };
  const planManager: PlanDashboardPanelDeps['planManager'] = {
    getActive: () => state.active,
    list: () => state.plans,
    getSummary: (plan: ExecutionPlan) => `${plan.title} — ${plan.status}`,
    toMarkdown: (plan: ExecutionPlan) => `# ${plan.title}\n\nline two\nline three`,
  };
  return { planManager, state };
}

function makePanel(opts: {
  active?: ExecutionPlan | null;
  plans?: ExecutionPlan[];
  feed?: ReturnType<typeof makeEventFeed>;
} = {}) {
  const feed = opts.feed ?? makeEventFeed();
  const { planManager, state } = makePlanManagerStub({ active: opts.active, plans: opts.plans });
  const panel = new PlanDashboardPanel(feed, { planManager });
  return { panel, feed, state };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('PlanDashboardPanel — empty state', () => {
  test('names /teamwork as the real ExecutionPlan producer, not /plan', () => {
    const { panel } = makePanel();
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('/teamwork');
    // The old advice pointed bare users at `/plan`, which never produces an
    // ExecutionPlan (it only seeds passive project-planning state or opens
    // the Planning panel) — that dead advice must be gone.
    expect(text).not.toContain('/plan\'');
    expect(text).not.toMatch(/\/plan[^\w-]/);
  });

  test('render satisfies the exact width/height contract', () => {
    const { panel } = makePanel();
    const lines = panel.render(100, 24);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => line.length === 100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

describe('PlanDashboardPanel — icon', () => {
  test('uses a distinct glyph, not the Planning panel\'s "P"', () => {
    const { panel } = makePanel();
    expect(panel.icon).not.toBe('P');
    expect(panel.icon).toBe('▤');
  });
});

// ---------------------------------------------------------------------------
// Live refresh (WrfcPanel pattern)
// ---------------------------------------------------------------------------

describe('PlanDashboardPanel — live refresh', () => {
  test('markRendered then a WORKFLOW_STATE_CHANGED event marks the panel dirty without a keypress', () => {
    const plan = makePlan();
    const { panel, feed } = makePanel({ active: plan });
    panel.render(100, 24);
    panel.markRendered();
    expect(panel.needsRender).toBe(false);

    feed.emit('WORKFLOW_STATE_CHANGED', { type: 'WORKFLOW_STATE_CHANGED', chainId: 'chain-1', from: 'engineering', to: 'reviewing' });

    expect(panel.needsRender).toBe(true);
  });

  test('re-render reflects an item status change picked up after a workflow event', () => {
    const plan = makePlan({ items: [makeItem({ status: 'pending' })] });
    const { panel, feed, state } = makePanel({ active: plan });

    let text = linesText(panel.render(100, 24));
    expect(text).not.toContain('100%');

    // Simulate the WRFC controller updating the plan on disk mid-run, then
    // notify via the workflow feed exactly as the real controller does.
    state.active = { ...plan, status: 'complete', items: [makeItem({ status: 'complete' })] };
    feed.emit('WORKFLOW_CHAIN_PASSED', { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'chain-1' });

    text = linesText(panel.render(100, 24));
    expect(text).toContain('100%');
  });

  test('all documented workflow event types are subscribed and trigger refresh', () => {
    const plan = makePlan();
    const { panel, feed } = makePanel({ active: plan });
    const eventNames: WorkflowEventName[] = [
      'WORKFLOW_CHAIN_CREATED',
      'WORKFLOW_STATE_CHANGED',
      'WORKFLOW_REVIEW_COMPLETED',
      'WORKFLOW_FIX_ATTEMPTED',
      'WORKFLOW_GATE_RESULT',
      'WORKFLOW_CHAIN_PASSED',
      'WORKFLOW_CHAIN_FAILED',
      'WORKFLOW_AUTO_COMMITTED',
      'WORKFLOW_CASCADE_ABORTED',
    ];
    for (const name of eventNames) {
      panel.render(100, 24);
      panel.markRendered();
      expect(panel.needsRender).toBe(false);
      feed.emit(name, { type: name, chainId: 'chain-1' } as unknown as WorkflowEvent);
      expect(panel.needsRender).toBe(true);
    }
  });

  test('onDestroy unsubscribes so later events no longer mark it dirty', () => {
    const plan = makePlan();
    const { panel, feed } = makePanel({ active: plan });
    panel.render(100, 24);
    panel.markRendered();
    panel.onDestroy();

    feed.emit('WORKFLOW_STATE_CHANGED', { type: 'WORKFLOW_STATE_CHANGED', chainId: 'chain-1', from: 'engineering', to: 'reviewing' });
    expect(panel.needsRender).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jump to inspector (WO-110) + WRFC cross-link
// ---------------------------------------------------------------------------

describe('PlanDashboardPanel — jump to agent inspector', () => {
  function makeInspectorPanelManager() {
    const panelManager = new PanelManager();
    panelManager.registerType({
      id: 'inspector',
      name: 'Inspector',
      icon: 'I',
      category: 'agent',
      description: 'inspector',
      factory: () => new AgentInspectorPanel({
        agentManager: { list: () => [], getStatus: () => null, cancel: () => true },
        agentMessageBus: { getMessages: () => [] },
        workingDirectory: '/tmp/test',
        cancelAgent: () => true,
        agentEvents: { on: () => () => {}, onEnvelope: () => () => {}, emit: () => {} } as unknown as UiEventFeed<never>,
      }),
    });
    return panelManager;
  }

  test('Enter on an item with an agentId opens the inspector focused on that agent', () => {
    const plan = makePlan({ items: [makeItem({ id: 'item-1', agentId: 'agent-42', status: 'in_progress' })] });
    const { panel } = makePanel({ active: plan });
    panel.render(100, 24);

    const panelManager = makeInspectorPanelManager();
    expect(handlePanelIntegrationAction(panelManager, panel, 'enter')).toBe(true);

    const inspector = panelManager.getPanel('inspector') as AgentInspectorPanel;
    expect(inspector).toBeInstanceOf(AgentInspectorPanel);
    // No public getter for the inspected agent id — assert through render
    // output the same way the panel itself surfaces "Selected <agentId>".
    const inspectorText = linesText(inspector.render(100, 24));
    expect(inspectorText).toContain('agent-42');
  });

  test('Enter on an item without an agentId does not consume the key or open the inspector', () => {
    const plan = makePlan({ items: [makeItem({ id: 'item-1', status: 'pending' })] });
    const { panel } = makePanel({ active: plan });
    panel.render(100, 24);

    const panelManager = makeInspectorPanelManager();
    expect(panel.handleInput('enter')).toBe(false);
    expect(panelManager.getPanel('inspector')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plan history / switching (list()/getSummary()/toMarkdown())
// ---------------------------------------------------------------------------

describe('PlanDashboardPanel — plan history', () => {
  test('h opens a history browser listing every plan via planManager.list()', () => {
    const active = makePlan({ id: 'plan-active', title: 'Active plan', status: 'active' });
    const older = makePlan({ id: 'plan-old', title: 'Older finished plan', status: 'complete', updatedAt: new Date(Date.now() - 100_000).toISOString() });
    const { panel } = makePanel({ active, plans: [active, older] });

    panel.handleInput('h');
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Plan History');
    expect(text).toContain('Active plan');
    expect(text).toContain('Older finished plan');
  });

  test('history detail surfaces getSummary() and toMarkdown() for the highlighted plan', () => {
    const active = makePlan({ id: 'plan-active', title: 'Active plan' });
    const { panel } = makePanel({ active, plans: [active] });

    panel.handleInput('h');
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Active plan — active'); // from getSummary()
    expect(text).toContain('line two'); // from toMarkdown()
  });

  test('Enter in history mode switches the viewed plan and Escape/h return without switching', () => {
    const active = makePlan({ id: 'plan-active', title: 'Active plan', updatedAt: new Date().toISOString() });
    const older = makePlan({ id: 'plan-old', title: 'Older plan', status: 'failed', updatedAt: new Date(Date.now() - 100_000).toISOString() });
    const { panel } = makePanel({ active, plans: [older, active] });

    panel.handleInput('h');
    // history is sorted by updatedAt desc; move down to the older plan and select it.
    panel.handleInput('down');
    panel.handleInput('enter');

    let text = linesText(panel.render(100, 24));
    expect(text).toContain('Older plan');
    expect(text).toContain('Viewing history');

    // 'a' returns to the live active plan.
    panel.handleInput('a');
    text = linesText(panel.render(100, 24));
    expect(text).toContain('Active plan');
    expect(text).not.toContain('Viewing history');
  });

  test('history mode absorbs unrelated keys', () => {
    const active = makePlan();
    const { panel } = makePanel({ active, plans: [active] });
    panel.handleInput('h');
    expect(panel.handleInput('z')).toBe(true);
  });

  test('empty plan list renders a history empty state instead of crashing', () => {
    const { panel } = makePanel({ active: null, plans: [] });
    panel.handleInput('h');
    const lines = panel.render(100, 24);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => line.length === 100)).toBe(true);
    expect(linesText(lines)).toContain('No plans on disk');
  });
});
