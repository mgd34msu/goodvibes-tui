import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { WorkPlanPanel } from '../../panels/work-plan-panel.ts';
import { WorkPlanStore } from '../../work-plans/work-plan-store.ts';
import { AgentInspectorPanel } from '../../panels/agent-inspector-panel.ts';
import { WrfcPanel } from '../../panels/wrfc-panel.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { handlePanelIntegrationAction } from '../../input/handler.ts';
import type { UiEventFeed } from '../../runtime/ui-events.ts';

function text(lines: ReturnType<WorkPlanPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

function makeStore(): WorkPlanStore {
  return new WorkPlanStore({
    homeDirectory: mkdtempSync(join(tmpdir(), 'gv-work-plan-panel-')),
    projectId: 'project:panel',
    projectRoot: '/tmp/panel',
  });
}

describe('WorkPlanPanel', () => {
  test('renders persistent work plan items and metadata', () => {
    const store = makeStore();
    store.addItem('Confirm WRFC chain topology', { owner: 'tui', source: 'sdk-handoff' });

    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    expect(rendered).toContain('Persistent Work Plan');
    expect(rendered).toContain('Confirm WRFC chain topology');
    expect(rendered).toContain('@tui');
    expect(rendered).toContain('sdk-handoff');
  });

  test('surfaces progress and a context-aware footer', () => {
    const store = makeStore();
    store.addItem('First task');
    const second = store.addItem('Second task');
    store.setItemStatus(second.id, 'done');

    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    // Progress meter reflects 1/2 done at 50%.
    expect(rendered).toContain('Progress');
    expect(rendered).toContain('1/2');
    expect(rendered).toContain('50%');
    // Footer advertises the keys that actually work on a populated plan.
    expect(rendered).toContain('cycle status');
    expect(rendered).toContain('clear done');
  });

  test('shows a detail block for the selected item', () => {
    const store = makeStore();
    store.addItem('Inspect detail block', { owner: 'tui', notes: 'verify rendering' });

    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    expect(rendered).toContain('Selected item');
    expect(rendered).toContain('verify rendering');
  });

  test('empty plan offers an actionable next step', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    expect(rendered).toContain('No work plan items yet');
    // WO-160: '/work-plan add <title>' is no longer printed here — 'a'
    // already opens an in-panel add-item draft from this empty state and is
    // advertised via the footer's 'a: add' hint instead.
    expect(rendered).not.toContain('/work-plan add');
    expect(rendered).toContain('/work-plan list');
  });

  test('a opens an in-panel add-item draft from the empty state (no printed command needed)', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    expect(panel.handleInput('a')).toBe(true);
    const rendered = text(panel.render(120, 28));
    expect(rendered).toContain('Title');
  });

  test('keyboard status changes persist through the store', () => {
    const store = makeStore();
    const item = store.addItem('Add panel tests');
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    expect(panel.handleInput('2')).toBe(true);
    expect(store.getActivePlan().items.find((entry) => entry.id === item.id)?.status).toBe('in_progress');

    expect(panel.handleInput('4')).toBe(true);
    expect(store.getActivePlan().items.find((entry) => entry.id === item.id)?.status).toBe('done');

    expect(panel.handleInput('c')).toBe(true);
    expect(store.getActivePlan().items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Draft-input: add / edit
// ---------------------------------------------------------------------------

describe('WorkPlanPanel add/edit draft', () => {
  test('a opens an add draft; typing + Enter creates the item', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    expect(panel.handleInput('a')).toBe(true);
    expect(text(panel.render(120, 32))).toContain('Add Work Plan Item');

    for (const ch of 'New drafted item') panel.handleInput(ch);
    expect(panel.handleInput('enter')).toBe(true);

    const items = store.getActivePlan().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('New drafted item');
  });

  test('Tab cycles fields and owner/notes are saved', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    panel.handleInput('a');
    for (const ch of 'Title text') panel.handleInput(ch);
    panel.handleInput('tab');
    for (const ch of 'owner-a') panel.handleInput(ch);
    panel.handleInput('tab');
    for (const ch of 'some notes') panel.handleInput(ch);
    panel.handleInput('enter');

    const item = store.getActivePlan().items[0];
    expect(item?.title).toBe('Title text');
    expect(item?.owner).toBe('owner-a');
    expect(item?.notes).toBe('some notes');
  });

  test('Escape cancels the add draft without creating an item', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    panel.handleInput('a');
    for (const ch of 'Abandoned') panel.handleInput(ch);
    expect(panel.handleInput('escape')).toBe(true);

    expect(store.getActivePlan().items).toHaveLength(0);
    expect(text(panel.render(120, 32))).not.toContain('Add Work Plan Item');
  });

  test('e opens an edit draft pre-filled with the selected item', () => {
    const store = makeStore();
    store.addItem('Existing item', { owner: 'orig-owner', notes: 'orig notes' });
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    expect(panel.handleInput('e')).toBe(true);
    const rendered = text(panel.render(120, 32));
    expect(rendered).toContain('Edit Work Plan Item');
    expect(rendered).toContain('Existing item');

    // Backspace edits the active (title) field, then retype and save.
    for (let i = 0; i < 'Existing item'.length; i++) panel.handleInput('backspace');
    for (const ch of 'Renamed item') panel.handleInput(ch);
    panel.handleInput('enter');

    const items = store.getActivePlan().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Renamed item');
    expect(items[0]?.owner).toBe('orig-owner');
  });

  test('e with no items selected does not consume the key', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    expect(panel.handleInput('e')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('WorkPlanPanel export', () => {
  test('x exports the plan to markdown and shows a status line', () => {
    const store = makeStore();
    store.addItem('Export me');
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    expect(panel.handleInput('x')).toBe(true);
    const rendered = text(panel.render(120, 32));
    expect(rendered).toContain('Exported to');
  });
});

// ---------------------------------------------------------------------------
// Linked ids + cross-panel jump keys
// ---------------------------------------------------------------------------

describe('WorkPlanPanel linked ids and jump keys', () => {
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
    panelManager.registerType({
      id: 'wrfc',
      name: 'WRFC',
      icon: 'W',
      category: 'agent',
      description: 'wrfc',
      factory: () => new WrfcPanel(
        { on: () => () => {} } as unknown as UiEventFeed<never>,
        { controller: { listChains: () => [{ id: 'chain-1', state: 'passed', task: 'Linked chain', ownerAgentId: 'agent-1', allAgentIds: ['agent-1'], reviewCycles: 0, fixAttempts: 0, reviewScores: [], constraints: [], gateResults: [], syntheticIssues: [], createdAt: Date.now() }], resumeChain: () => false }, cancelChain: () => true },
      ),
    });
    return panelManager;
  }

  test('renders linked ids with jump-key hints for the selected item', () => {
    const store = makeStore();
    store.addItem('Linked item', { linked: { agentId: 'agent-9', wrfcId: 'chain-9' } });
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    const rendered = text(panel.render(120, 32));
    expect(rendered).toContain('agent:agent-9');
    expect(rendered).toContain('wrfc:chain-9');
  });

  test('i jumps to the linked agent in the Inspector', () => {
    const store = makeStore();
    store.addItem('Linked item', { linked: { agentId: 'agent-9' } });
    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    panel.render(120, 24);

    const panelManager = makeInspectorPanelManager();
    expect(handlePanelIntegrationAction(panelManager, panel, 'i')).toBe(true);

    const inspector = panelManager.getPanel('inspector') as AgentInspectorPanel;
    expect(inspector).toBeInstanceOf(AgentInspectorPanel);
    const inspectorText = inspector.render(100, 24).map((line) => line.map((cell) => cell.char).join('')).join('\n');
    expect(inspectorText).toContain('agent-9');
  });

  test('w jumps to the linked chain in the WRFC panel', () => {
    const store = makeStore();
    store.addItem('Linked item', { linked: { wrfcId: 'chain-1' } });
    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    panel.render(120, 24);

    const panelManager = makeInspectorPanelManager();
    expect(handlePanelIntegrationAction(panelManager, panel, 'w')).toBe(true);

    const wrfc = panelManager.getPanel('wrfc') as WrfcPanel;
    expect(wrfc).toBeInstanceOf(WrfcPanel);
    const wrfcText = wrfc.render(100, 24).map((line) => line.map((cell) => cell.char).join('')).join('\n');
    expect(wrfcText).toContain('Linked chain');
  });

  test('i/w without a linked target do not consume the key', () => {
    const store = makeStore();
    store.addItem('Unlinked item');
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    expect(panel.handleInput('i')).toBe(false);
    expect(panel.handleInput('w')).toBe(false);
  });
});
