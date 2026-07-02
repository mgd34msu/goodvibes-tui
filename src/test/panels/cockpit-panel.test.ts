import { describe, expect, test } from 'bun:test';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { CockpitPanel } from '../../panels/cockpit-panel.ts';
import type { FailureReport } from '@/runtime/index.ts';
import type { Line } from '../../types/grid.ts';
import { createCockpitReadModel } from '../helpers/ui-read-models.ts';
import type { CockpitRosterReadModel, CockpitRosterSnapshot } from '../../panels/cockpit-read-model.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

// All-zero cockpit snapshot shared by tests that only care about workspace
// navigation/rendering mechanics, not specific stat values.
const EMPTY_SNAPSHOT = {
  runningTasks: 0,
  blockedTasks: 0,
  failedTasks: 0,
  activeGraphs: 0,
  guardTrips: 0,
  blockedMessages: 0,
  pendingPermissions: 0,
  deniedPermissions: 0,
  preflightStatus: 'n/a' as const,
  preflightIssueCount: 0,
  lintFindingCount: 0,
  tokenBlockedCount: 0,
  tokenRotationOverdueCount: 0,
  tokenScopeViolationCount: 0,
  tokenRotationWarningCount: 0,
  incidentCount: 0,
  latestIncident: undefined,
  elevatedMcp: 0,
  unhealthyMcp: 0,
  erroredPlugins: 0,
  failingIntegrations: 0,
  taskCount: 0,
  agentCount: 0,
  totalGraphs: 0,
  communicationCount: 0,
  mcpServerCount: 0,
  pluginCount: 0,
};

describe('CockpitPanel', () => {
  test('renders policy preflight posture when policy runtime is wired', () => {
    const text = linesText(new CockpitPanel(createCockpitReadModel({
      runningTasks: 0,
      blockedTasks: 0,
      failedTasks: 0,
      activeGraphs: 0,
      guardTrips: 0,
      blockedMessages: 0,
      pendingPermissions: 0,
      deniedPermissions: 0,
      preflightStatus: 'warn',
      preflightIssueCount: 1,
      lintFindingCount: 0,
      tokenBlockedCount: 0,
      tokenRotationOverdueCount: 0,
      tokenScopeViolationCount: 0,
      tokenRotationWarningCount: 0,
      incidentCount: 0,
      latestIncident: undefined,
      elevatedMcp: 0,
      unhealthyMcp: 0,
      erroredPlugins: 0,
      failingIntegrations: 0,
      taskCount: 0,
      agentCount: 0,
      totalGraphs: 0,
      communicationCount: 0,
      mcpServerCount: 0,
      pluginCount: 0,
    })).render(140, 12));
    expect(text).toContain('preflight');
    expect(text).toContain('WARN');
    expect(text).toContain('issues');
  });

  test('renders empty guidance when the runtime store is missing', () => {
    const panel = new CockpitPanel();
    const text = linesText(panel.render(100, 10));
    expect(text).toContain('Operator Cockpit');
    expect(text).toContain('Runtime read model not wired');
  });

  test('renders summary counts across orchestration, communication, permissions, mcp, and plugins', () => {
    const latestIncident: FailureReport = {
      id: 'incident-1',
      traceId: 'trace-1',
      sessionId: 'session-1',
      generatedAt: Date.now(),
      classification: 'llm_error',
      summary: 'provider timed out during verification',
      turnId: 'turn-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      phaseTimings: [],
      phaseLedger: [],
      causalChain: [],
      cascadeEvents: [],
      jumpLinks: [],
      permissionEvidence: [],
      budgetBreaches: [],
    };

    const text = linesText(new CockpitPanel(createCockpitReadModel({
      runningTasks: 0,
      blockedTasks: 0,
      failedTasks: 0,
      activeGraphs: 1,
      guardTrips: 1,
      blockedMessages: 2,
      pendingPermissions: 1,
      deniedPermissions: 2,
      preflightStatus: 'n/a',
      preflightIssueCount: 0,
      lintFindingCount: 0,
      tokenBlockedCount: 1,
      tokenRotationOverdueCount: 1,
      tokenScopeViolationCount: 1,
      tokenRotationWarningCount: 0,
      incidentCount: 1,
      latestIncident,
      elevatedMcp: 1,
      unhealthyMcp: 1,
      erroredPlugins: 1,
      failingIntegrations: 1,
      taskCount: 0,
      agentCount: 0,
      totalGraphs: 2,
      communicationCount: 0,
      mcpServerCount: 2,
      pluginCount: 2,
    })).render(140, 18));
    expect(text).toContain('Operator Cockpit');
    expect(text).toContain('graphs');
    expect(text).toContain('blocked comms');
    expect(text).toContain('Governance');
    expect(text).toContain('token blocked');
    expect(text).toContain('allow-all MCP');
    expect(text).toContain('incidents');
    expect(text).toContain('latest incident');
    expect(text).toContain('plugins');
    expect(text).toContain('Workspace · flow');
    // Live domain mini-summary cards replace the old '/orchestration' signpost.
    expect(text).toContain('Orchestration');
    expect(text).not.toContain('/orchestration');
  });

  // ---------------------------------------------------------------------------
  // Helper: build a minimal CockpitRosterReadModel with one active agent
  // ---------------------------------------------------------------------------
  function makeRosterReadModel(agentId: string): CockpitRosterReadModel {
    const snapshot: CockpitRosterSnapshot = {
      roster: [{
        id: agentId,
        task: 'test task',
        model: 'claude-sonnet',
        status: 'running',
        stalled: false,
        inputTokens: null,
        outputTokens: null,
        cost: null,
      }],
      stalledAgentCount: 0,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCost: null,
    };
    return {
      getSnapshot: () => snapshot,
      markDirty: () => { /* noop */ },
      subscribe: (_listener: () => void) => () => { /* noop */ },
    };
  }

  test('roster enter/return jumps to inspector.inspectAgent for both keys', () => {
    const inspectedIds: string[] = [];
    const panel = new CockpitPanel(
      undefined,
      makeRosterReadModel('agent-abc'),
      { inspectAgent: (id) => { inspectedIds.push(id); } },
    );
    // Navigate to agents workspace (4 rights from default 'flow')
    panel.handleInput('right'); // governance
    panel.handleInput('right'); // health
    panel.handleInput('right'); // domains
    panel.handleInput('right'); // agents

    // 'enter' should deep-link into the inspector
    panel.handleInput('enter');
    expect(inspectedIds).toEqual(['agent-abc']);

    // 'return' should also deep-link into the inspector
    panel.handleInput('return');
    expect(inspectedIds).toEqual(['agent-abc', 'agent-abc']);
  });

  test('i key still opens the quick-peek agent detail modal (distinct from enter)', () => {
    const openedIds: string[] = [];
    const inspectedIds: string[] = [];
    const panel = new CockpitPanel(
      undefined,
      makeRosterReadModel('agent-abc'),
      {
        openAgentDetail: (id) => { openedIds.push(id); },
        inspectAgent: (id) => { inspectedIds.push(id); },
      },
    );
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right');

    panel.handleInput('i');
    expect(openedIds).toEqual(['agent-abc']);
    expect(inspectedIds).toEqual([]);
  });

  test('cancel-confirm handler accepts both enter and return as confirmation', () => {
    const cancelledIds: string[] = [];
    const panel = new CockpitPanel(
      undefined,
      makeRosterReadModel('agent-xyz'),
      { cancelAgent: (id) => { cancelledIds.push(id); return true; } },
    );
    // Navigate to agents workspace
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right');

    // Initiate cancel — 'c' puts panel into pending-cancel state
    panel.handleInput('c');

    // Confirm with 'enter'
    panel.handleInput('enter');
    expect(cancelledIds).toEqual(['agent-xyz']);

    // Re-initiate cancel to test 'return' path
    panel.handleInput('c');
    panel.handleInput('return');
    expect(cancelledIds).toEqual(['agent-xyz', 'agent-xyz']);
  });

  test('supports workspace focus changes with targeted action rails', () => {
    const panel = new CockpitPanel(createCockpitReadModel(EMPTY_SNAPSHOT));
    expect(panel.handleInput('right')).toBe(true);
    expect(panel.handleInput('right')).toBe(true);
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('Workspace · health');
    // Live domain mini-summary card replaces the old '/incident latest' signpost.
    expect(text).toContain('Incidents');
    expect(text).not.toContain('/incident latest');
  });

  test('pressing c on a selected agent renders a visible confirm bar (the visible-confirm UX fix)', () => {
    // Short id (<= 8 chars) so the roster's shortId truncation is a no-op and
    // the id appears verbatim in the confirm label.
    const panel = new CockpitPanel(
      createCockpitReadModel(EMPTY_SNAPSHOT),
      makeRosterReadModel('agent-01'),
    );
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right'); // agents workspace

    panel.handleInput('c');
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('Cancel');
    expect(text).toContain('agent-01');
    expect(text).toContain('confirm');
    expect(text).toContain('cancel');
  });

  test('roster rows show per-agent model and cost columns', () => {
    const panel = new CockpitPanel(
      createCockpitReadModel(EMPTY_SNAPSHOT),
      makeRosterReadModel('agent-abc'),
    );
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right');
    panel.handleInput('right'); // agents workspace

    const text = linesText(panel.render(140, 18));
    expect(text).toContain('claude-sonnet');
    expect(text).toContain('n/a'); // no usage data → cost/tokens are honestly 'n/a'
  });

  test('domain-card Enter jumps to the target panel via deps.openPanel (flow workspace)', () => {
    const openedPanels: string[] = [];
    const panel = new CockpitPanel(createCockpitReadModel(EMPTY_SNAPSHOT), undefined, { openPanel: (id) => { openedPanels.push(id); } });

    // Default workspace is 'flow'; its first card targets 'orchestration'.
    panel.handleInput('enter');
    expect(openedPanels).toEqual(['orchestration']);

    // Move the card cursor down to the second card ('tasks') and jump again.
    panel.handleInput('down');
    panel.handleInput('enter');
    expect(openedPanels).toEqual(['orchestration', 'tasks']);
  });

  test('periodic tick: onActivate starts a refresh timer that stops on onDeactivate', () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const active = new Set<ReturnType<typeof setInterval>>();
    globalThis.setInterval = ((handler: () => void, timeout?: number, ...args: unknown[]) => {
      const id = realSet(handler, timeout, ...args);
      active.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      if (id !== undefined) active.delete(id);
      realClear(id);
    }) as typeof clearInterval;

    try {
      const panel = new CockpitPanel();
      const baseline = active.size; // constructor does not start the timer
      panel.onActivate();
      expect(active.size).toBe(baseline + 1);
      panel.onDeactivate();
      expect(active.size).toBe(baseline);
      panel.onActivate();
      expect(active.size).toBe(baseline + 1);
      panel.onDestroy();
      expect(active.size).toBe(baseline);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
