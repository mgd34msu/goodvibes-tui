import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createPermissionSimulator, DivergenceDashboard } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createUnsignedBundle } from '@/runtime/index.ts';
import type { PolicyBundlePayload } from '@/runtime/index.ts';
import { PolicyPanel } from '../../panels/policy-panel.ts';
import type { PolicyRule } from '@/runtime/index.ts';
import type { Line } from '../../types/grid.ts';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';

function linesText(lines: Line[]): string {
  return lines
    .map(line => line.map(cell => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeBundle(id: string, rules: PolicyRule[] = []) {
  const payload: PolicyBundlePayload = {
    version: 1,
    rules,
    description: `Test bundle ${id}`,
  };
  return createUnsignedBundle(id, payload);
}

function makeCtx(overrides: Partial<PanelIntegrationContext> = {}): PanelIntegrationContext & { executeCommand: ReturnType<typeof mock> } {
  const executeCommand = mock(() => Promise.resolve(undefined));
  const panelManager = {} as unknown as PanelManager;
  return { panelManager, executeCommand, ...overrides } as PanelIntegrationContext & { executeCommand: ReturnType<typeof mock> };
}

describe('PolicyPanel', () => {
  let policyState: PolicyRuntimeState;

  beforeEach(() => {
    policyState = new PolicyRuntimeState();
  });

  test('renders empty guidance when no bundles are loaded', () => {
    const panel = new PolicyPanel(policyState);
    const text = linesText(panel.render(100, 12));
    expect(text).toContain('No policy bundles loaded');
    // Actionable empty state suggests a concrete next command.
    expect(text).toContain('/policy load');
  });

  test('renders a posture summary line and keyboard hints', () => {
    const panel = new PolicyPanel(policyState);
    const text = linesText(panel.render(100, 16));
    // Top-of-panel posture summary surfaces the highest-signal governance state.
    expect(text).toContain('preflight');
    expect(text).toContain('gate');
    expect(text).toContain('lint');
    // Footer hints expose the policy-dispatch subactions.
    expect(text).toContain('simulate');
    expect(text).toContain('promote');
    expect(text).toContain('rollback');
    // Trend-record is honest about needing an active simulation first.
    expect(text).not.toContain('record divergence snapshot');
  });

  test('shows the trend-record hint, and lets r record a snapshot, only once a simulation dashboard is active', () => {
    const registry = policyState.getRegistry();
    registry.loadCandidate(makeBundle('policy-dash'));
    const simulator = createPermissionSimulator(
      { mode: 'default', rules: [] },
      { mode: 'default', rules: [] },
      'warn-on-divergence',
    );
    const dashboard = new DivergenceDashboard(simulator, 'warn-on-divergence');
    policyState.setDashboard(dashboard);

    const panel = new PolicyPanel(policyState);
    const text = linesText(panel.render(120, 20));
    expect(text).toContain('record divergence snapshot');
    expect(panel.handleInput('r')).toBe(true);
  });

  test('r is a no-op with no active simulation dashboard', () => {
    const panel = new PolicyPanel(policyState);
    expect(panel.handleInput('r')).toBe(false);
  });

  test('s/f/l stage a pending policy-dispatch subaction that executeCommand receives via the integration hook', () => {
    const panel = new PolicyPanel(policyState);
    const ctx = makeCtx();

    expect(panel.handleInput('s')).toBe(true);
    expect(panel.handlePanelIntegrationAction('s', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('policy', ['simulate']);

    expect(panel.handleInput('f')).toBe(true);
    expect(panel.handlePanelIntegrationAction('f', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('policy', ['preflight']);

    expect(panel.handleInput('l')).toBe(true);
    expect(panel.handlePanelIntegrationAction('l', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('policy', ['lint']);

    expect(ctx.executeCommand).toHaveBeenCalledTimes(3);
  });

  test('p with no candidate loaded is a no-op', () => {
    const panel = new PolicyPanel(policyState);
    expect(panel.handleInput('p')).toBe(false);
  });

  test('b with no active bundle is a no-op', () => {
    const panel = new PolicyPanel(policyState);
    expect(panel.handleInput('b')).toBe(false);
  });

  test('p opens a gate-aware promote confirmation, and confirming dispatches promote via executeCommand', () => {
    const registry = policyState.getRegistry();
    registry.loadCandidate(makeBundle('policy-promote'));

    const panel = new PolicyPanel(policyState);
    expect(panel.handleInput('p')).toBe(true);
    const confirmText = linesText(panel.render(120, 12));
    expect(confirmText).toContain('Promote');
    expect(confirmText).toContain('policy-promote');
    expect(confirmText).toContain('gate');

    const ctx = makeCtx();
    expect(panel.handleInput('y')).toBe(true);
    expect(panel.handlePanelIntegrationAction('y', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('policy', ['promote']);
  });

  test('b opens a rollback confirmation, and cancelling does not dispatch', () => {
    const registry = policyState.getRegistry();
    registry.loadCandidate(makeBundle('policy-a'));
    registry.markSimulating();
    const simulator = createPermissionSimulator(
      { mode: 'default', rules: [] },
      { mode: 'default', rules: [] },
      'warn-on-divergence',
    );
    const dashboard = new DivergenceDashboard(simulator, 'warn-on-divergence');
    policyState.setDashboard(dashboard);
    const report = simulator.getDivergenceReport();
    const gate = dashboard.checkEnforceGate();
    registry.attachSimulationReport(report, gate);
    registry.promote(true);

    const panel = new PolicyPanel(policyState);
    expect(panel.handleInput('b')).toBe(true);
    const confirmText = linesText(panel.render(120, 12));
    expect(confirmText).toContain('Rollback');
    expect(confirmText).toContain('policy-a');

    const ctx = makeCtx();
    expect(panel.handleInput('n')).toBe(true);
    expect(panel.handlePanelIntegrationAction('n', ctx)).toBe(false);
    expect(ctx.executeCommand).not.toHaveBeenCalled();
  });

  test('renders current candidate and governance gate state', () => {
    const registry = policyState.getRegistry();
    registry.loadCandidate(makeBundle('policy-a'));
    registry.markSimulating();

    const simulator = createPermissionSimulator(
      { mode: 'default', rules: [] },
      { mode: 'default', rules: [] },
      'warn-on-divergence',
    );
    const dashboard = new DivergenceDashboard(simulator, 'warn-on-divergence');
    policyState.setDashboard(dashboard);

    const report = simulator.getDivergenceReport();
    const gate = dashboard.checkEnforceGate();
    registry.attachSimulationReport(report, gate);
    registry.promote(true);
    registry.loadCandidate(makeBundle('policy-b'));
    policyState.notify();

    const panel = new PolicyPanel(policyState);
    const text = linesText(panel.render(120, 20));
    expect(text).toContain('policy-a');
    expect(text).toContain('policy-b');
    expect(text).toContain('Governance Gate');
    expect(text).toContain('warn-on-divergence');
  });

  test('renders recent permission audit entries with risk and outcome', () => {
    const state = policyState;
    const analysis = analyzePermissionRequest(
      'exec',
      { command: 'curl -H "Authorization: Bearer sk-secret-token" https://example.com' },
      'execute',
    );

    state.recordPermissionRequest({
      callId: 'perm-audit-1',
      tool: 'exec',
      category: 'execute',
      analysis,
    });
    state.recordPermissionDecision({
      callId: 'perm-audit-1',
      tool: 'exec',
      category: 'execute',
      result: {
        approved: false,
        persisted: false,
        sourceLayer: 'user_prompt',
        reasonCode: 'user_denied',
        analysis,
      },
    });

    const panel = new PolicyPanel(state);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Permission Audit');
    expect(text).toContain('exec');
    expect(text).toContain('CRITICAL');
    expect(text).toContain('denied');
  });

  test('renders policy lint findings for risky bundles', () => {
    const state = policyState;
    const registry = state.getRegistry();
    registry.loadCandidate(makeBundle('policy-lint', [
      {
        id: 'allow-everything',
        type: 'prefix',
        description: 'Broad allow rule',
        origin: 'user',
        effect: 'allow',
        toolPattern: '*',
        commandPrefixes: [],
      },
    ]));

    const panel = new PolicyPanel(state);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Policy Lint');
    expect(text).toContain('ERROR');
    expect(text).toContain('allow-everything');
  });

  test('renders recent simulation sample results', () => {
    const state = policyState;
    state.recordSimulationSummary({
      simulatedAt: new Date().toISOString(),
      mode: 'warn-on-divergence',
      totalScenarios: 2,
      divergentScenarios: 1,
      allowedByActual: 2,
      allowedBySimulated: 1,
      results: [
        {
          scenario: {
            id: 'read-project-file',
            label: 'Read project file',
            toolName: 'read',
            args: { path: '/workspace/README.md' },
          },
          actualDecision: {
            allowed: true,
            reason: 'DEFAULT_ALLOW',
            sourceLayer: 'default',
            toolName: 'read',
            args: { path: '/workspace/README.md' },
            timestamp: Date.now(),
            evaluationTrace: [],
          },
          simulatedDecision: {
            allowed: true,
            reason: 'DEFAULT_ALLOW',
            sourceLayer: 'default',
            toolName: 'read',
            args: { path: '/workspace/README.md' },
            timestamp: Date.now(),
            evaluationTrace: [],
          },
          authoritativeDecision: {
            allowed: true,
            reason: 'DEFAULT_ALLOW',
            sourceLayer: 'default',
            toolName: 'read',
            args: { path: '/workspace/README.md' },
            timestamp: Date.now(),
            evaluationTrace: [],
          },
          diverged: false,
        },
        {
          scenario: {
            id: 'write-project-file',
            label: 'Write project file',
            toolName: 'write',
            args: { path: '/workspace/out.txt', content: 'hello' },
          },
          actualDecision: {
            allowed: true,
            reason: 'DEFAULT_ALLOW',
            sourceLayer: 'default',
            toolName: 'write',
            args: { path: '/workspace/out.txt', content: 'hello' },
            timestamp: Date.now(),
            evaluationTrace: [],
          },
          simulatedDecision: {
            allowed: false,
            reason: 'MODE_DENY_PLAN',
            sourceLayer: 'mode',
            toolName: 'write',
            args: { path: '/workspace/out.txt', content: 'hello' },
            timestamp: Date.now(),
            evaluationTrace: [],
          },
          authoritativeDecision: {
            allowed: true,
            reason: 'DEFAULT_ALLOW',
            sourceLayer: 'default',
            toolName: 'write',
            args: { path: '/workspace/out.txt', content: 'hello' },
            timestamp: Date.now(),
            evaluationTrace: [],
          },
          diverged: true,
          divergenceType: 'allow-vs-deny',
        },
      ],
    });

    const panel = new PolicyPanel(state);
    const text = linesText(panel.render(120, 28));
    expect(text).toContain('Simulation Samples');
    expect(text).toContain('warn-on-divergence');
    expect(text).toContain('Read project file');
    expect(text).toContain('Write project file');
    expect(text).toContain('allow-vs-deny');
  });

  test('renders the most recent preflight review', () => {
    const state = policyState;
    state.recordPreflightReview({
      generatedAt: new Date().toISOString(),
      status: 'block',
      summary: '2 blocking issues require attention before high-risk runs.',
      issueCount: 2,
      issues: [
        {
          severity: 'error',
          source: 'runtime',
          message: 'Permission mode is allow-all.',
          detail: 'All runtime permission checks are bypassed for local tools.',
        },
        {
          severity: 'error',
          source: 'mcp',
          serverName: 'deploy',
          message: 'MCP server "deploy" is in allow-all mode.',
          detail: 'role=ops',
        },
      ],
    });

    const panel = new PolicyPanel(state);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Preflight Review');
    expect(text).toContain('BLOCK');
    expect(text).toContain('Permission mode is allow-all.');
    expect(text).toContain('MCP server "deploy" is in allow-all mode.');
  });
});
