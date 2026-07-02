import { describe, expect, test, mock } from 'bun:test';
import { ForensicsRegistry } from '@/runtime/index.ts';
import type { FailureReport } from '@/runtime/index.ts';
import { IncidentReviewPanel } from '../../panels/incident-review-panel.ts';
import type { Line } from '../../types/grid.ts';
import type { ReplaySnapshotInput } from '@/runtime/index.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeReport(id: string, overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    id,
    traceId: `trace-${id}`,
    sessionId: 'sess-incident',
    generatedAt: Date.now(),
    classification: 'tool_failure',
    summary: 'tool failed during deploy',
    taskId: 'task-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    stopReason: 'tool_loop_circuit_breaker',
    errorMessage: 'tool failed',
    phaseTimings: [{ phase: 'EXECUTE', startedAt: 1, endedAt: 2, durationMs: 1, success: false, error: 'boom' }],
    phaseLedger: [{ seq: 1, domain: 'task', phase: 'EXECUTE', enterEventType: 'TASK_STARTED', enteredAt: 1, exitEventType: 'TASK_FAILED', exitedAt: 2, durationMs: 1, outcome: 'failed', error: 'boom' }],
    causalChain: [{ seq: 1, ts: 1, description: 'tool failure', sourceEventType: 'TASK_FAILED', isRootCause: true }],
    cascadeEvents: [],
    permissionEvidence: [{ callId: 'call-1', tool: 'exec', approved: false, summary: 'denied' }],
    budgetBreaches: [{ callId: 'call-1', tool: 'exec', eventType: 'BUDGET_EXCEEDED_MS', phase: 'EXECUTE', ts: 2, meta: { durationMs: 5000 } }],
    jumpLinks: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PanelIntegrationContext> = {}): PanelIntegrationContext & { executeCommand: ReturnType<typeof mock> } {
  const executeCommand = mock(() => Promise.resolve(undefined));
  const panelManager = { open: mock(() => undefined) } as unknown as PanelManager;
  return { panelManager, executeCommand, ...overrides } as PanelIntegrationContext & { executeCommand: ReturnType<typeof mock> };
}

describe('IncidentReviewPanel', () => {
  test('renders empty guidance when there are no incidents', () => {
    const panel = new IncidentReviewPanel(new ForensicsRegistry());
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Incident Review Workspace');
    expect(text).toContain('No incidents recorded yet');
    expect(text).toContain('/recall capture incident latest');
  });

  test('renders an honest empty state when no forensics registry is wired', () => {
    const panel = new IncidentReviewPanel();
    const text = linesText(panel.render(100, 16));
    expect(text).toContain('Incident Review Workspace');
    expect(text).toContain('not configured');
    expect(text).not.toContain('/incident latest');
    expect(text).not.toContain('/security');
  });

  test('renders bundle evidence, causal chain, and phase timings for the selected incident', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-1'));
    const panel = new IncidentReviewPanel(registry);
    const text = linesText(panel.render(140, 24));
    expect(text).toContain('Incident Review Workspace');
    expect(text).toContain('tool failed during deploy');
    expect(text).toContain('Root cause');
    expect(text).toContain('Permissions denied');
    expect(text).toContain('Budget breaches');
    expect(text).toContain('Related IDs');
    expect(text).toContain('Phase Timings');
    expect(text).toContain('EXECUTE');
    expect(text).toContain('Causal Chain');
    expect(text).toContain('tool failure');
    expect(text).not.toContain('Action Rail');
  });

  test('renders jump links for the selected incident and hints the follow key', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-link', {
      jumpLinks: [
        { label: 'Open security posture', kind: 'panel', target: 'security' },
        { label: 'Show policy preflight', kind: 'command', target: 'policy', args: 'show' },
      ],
    }));
    const panel = new IncidentReviewPanel(registry);
    const text = linesText(panel.render(140, 26));
    expect(text).toContain('Jump Links');
    expect(text).toContain('Open security posture');
    expect(text).toContain('Show policy preflight');
    expect(text).toContain('follow link');
  });

  test('renders replay and permission detail from the selected bundle', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-2'));
    const snapshot: ReplaySnapshotInput = {
      status: 'loaded',
      runId: 'replay-1',
      currentRev: 4,
      totalRevisions: 4,
      mismatches: [
        {
          rev: 4,
          kind: 'state_divergence',
          description: 'terminal outcome drift',
          ownerDomain: 'turn',
          failureMode: 'terminal_outcome',
          relatedTurnId: 'turn-1',
        },
      ],
      turnSummaries: [
        {
          turnId: 'turn-1',
          outcome: 'failed',
          terminalEvent: 'TURN_ERROR',
          terminalRev: 4,
          stopReason: 'tool_loop_circuit_breaker',
        },
      ],
    };
    const panel = new IncidentReviewPanel(registry);
    const originalBuildBundle = registry.buildBundle.bind(registry);
    registry.buildBundle = ((id: string) => originalBuildBundle(id, { replaySnapshot: snapshot })) as typeof registry.buildBundle;
    const text = linesText(panel.render(140, 20));
    expect(text).toContain('Permission:');
    expect(text).toContain('Replay link:');
    expect(text).toContain('Replay owners:');
    expect(text).toContain('turn:1');
  });

  test('supports ↑/↓ navigation and shows selection state for the focused incident', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-3'));
    registry.push(makeReport('incident-4'));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('end')).toBe(true);
    const text = linesText(panel.render(140, 22));
    expect(text).toContain('selected 2/2');
  });

  test('x stages an export and dispatches it via executeCommand through the integration hook', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-export'));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('x')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('x', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    const call = ctx.executeCommand.mock.calls[0]!;
    expect(call[0]).toBe('incident');
    expect(call[1][0]).toBe('export');
    expect(call[1][1]).toBe('incident-export');
    expect(call[1][2]).toContain('incident-export');
    expect(call[1][2]).toContain('goodvibes-exports');
  });

  test('x under an applied filter exports the highlighted (filtered) incident, not the raw index', () => {
    const registry = new ForensicsRegistry();
    const panel = new IncidentReviewPanel(registry);
    registry.push(makeReport('incident-alpha'));
    registry.push(makeReport('incident-beta'));
    registry.push(makeReport('incident-gamma'));

    // getAll() is newest-first, so the raw list is [gamma, beta, alpha];
    // filtering to alpha leaves visible index 0 while raw index 0 is gamma.
    expect(panel.handleInput('/')).toBe(true);
    for (const ch of 'alpha') panel.handleInput(ch);
    expect(panel.handleInput('enter')).toBe(true); // commit filter, keep query

    expect(panel.handleInput('x')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('x', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    const call = ctx.executeCommand.mock.calls[0]!;
    expect(call[1][0]).toBe('export');
    expect(call[1][1]).toBe('incident-alpha');

    // The render header/detail describes the filtered selection too.
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('incident-alpha');
    expect(text).not.toContain('incident-gamma');
  });

  test('c opens a capture confirmation, and confirming dispatches capture via executeCommand', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-capture'));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('c')).toBe(true);
    const confirmText = linesText(panel.render(140, 20));
    expect(confirmText).toContain('Capture');
    expect(confirmText).toContain('incident-capture');

    expect(panel.handleInput('y')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('y', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    const call = ctx.executeCommand.mock.calls[0]!;
    expect(call[0]).toBe('incident');
    expect(call[1]).toEqual(['capture', 'incident-capture']);

    const afterText = linesText(panel.render(140, 20));
    expect(afterText).not.toContain('Confirmation');
  });

  test('cancelling the capture confirmation with Esc clears it without dispatching', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-cancel'));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('c')).toBe(true);
    expect(panel.handleInput('escape')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('escape', ctx)).toBe(false);
    expect(ctx.executeCommand).not.toHaveBeenCalled();
  });

  test('j follows a panel-kind jump link via panelManager.open', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-jump-panel', {
      jumpLinks: [{ label: 'Open security posture', kind: 'panel', target: 'security' }],
    }));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('j')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('j', ctx)).toBe(true);
    expect(ctx.panelManager.open).toHaveBeenCalledWith('security');
    expect(ctx.executeCommand).not.toHaveBeenCalled();
  });

  test('j dispatches a command-kind jump link via executeCommand', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-jump-cmd', {
      jumpLinks: [{ label: 'Show policy preflight', kind: 'command', target: 'policy', args: 'show latest' }],
    }));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('j')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('j', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('policy', ['show', 'latest']);
  });

  test('j is a no-op when the selected incident has no jump links', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-no-jump'));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('j')).toBe(false);
  });

  test('forensics resolves as an alias to the same incident panel instance (WO-114), not a duplicate registration', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-alias'));
    const manager = new PanelManager();
    // Mirrors registerOperationsPanels(): one 'incident' registration plus a
    // 'forensics' compat alias — never a second registerType for 'forensics'.
    manager.registerType({
      id: 'incident',
      name: 'Incident',
      icon: 'N',
      category: 'monitoring',
      description: 'Incident workspace',
      factory: () => new IncidentReviewPanel(registry),
    });
    manager.registerAlias('forensics', 'incident');

    const viaIncident = manager.open('incident');
    const viaForensics = manager.open('forensics');

    // Same instance: repeated /forensics opens must not stack duplicates.
    expect(viaForensics).toBe(viaIncident);
    // The alias id resolves for lookups too (close/activateById/getPanel paths).
    expect(manager.getPanel('forensics')).toBe(viaIncident);
    // The type registry lists Incident exactly once — no phantom 'forensics' type.
    const incidentEntries = manager.getRegisteredTypes().filter((r) => r.id === 'incident' || r.id === 'forensics');
    expect(incidentEntries).toHaveLength(1);
    expect(incidentEntries[0]!.id).toBe('incident');
  });
});
