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
    expect(text).toContain('Selected Workspace');
    expect(text).toContain('/orchestration');
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

  test('inspect handler fires for both enter and return keys', () => {
    const openedIds: string[] = [];
    const panel = new CockpitPanel(
      undefined,
      makeRosterReadModel('agent-abc'),
      { openAgentDetail: (id) => { openedIds.push(id); } },
    );
    // Navigate to agents workspace (4 rights from default 'flow')
    panel.handleInput('right'); // governance
    panel.handleInput('right'); // health
    panel.handleInput('right'); // domains
    panel.handleInput('right'); // agents

    // 'enter' should trigger inspect
    panel.handleInput('enter');
    expect(openedIds).toEqual(['agent-abc']);

    // 'return' should also trigger inspect
    panel.handleInput('return');
    expect(openedIds).toEqual(['agent-abc', 'agent-abc']);
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
    const panel = new CockpitPanel(createCockpitReadModel({
      runningTasks: 0,
      blockedTasks: 0,
      failedTasks: 0,
      activeGraphs: 0,
      guardTrips: 0,
      blockedMessages: 0,
      pendingPermissions: 0,
      deniedPermissions: 0,
      preflightStatus: 'n/a',
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
    }));
    expect(panel.handleInput('right')).toBe(true);
    expect(panel.handleInput('right')).toBe(true);
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('focus=health');
    expect(text).toContain('Selected Workspace');
    expect(text).toContain('/incident latest');
  });
});
