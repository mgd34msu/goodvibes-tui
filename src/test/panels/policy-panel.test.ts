import { beforeEach, describe, expect, test } from 'bun:test';
import { createPermissionSimulator, DivergenceDashboard } from '@pellux/goodvibes-sdk/platform/runtime/permissions/index';
import { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import { createUnsignedBundle } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';
import type { PolicyBundlePayload } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';
import { PolicyPanel } from '../../panels/policy-panel.ts';
import type { PolicyRule } from '@pellux/goodvibes-sdk/platform/runtime/permissions/types';
import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions/analysis';

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

describe('PolicyPanel', () => {
  let policyState: PolicyRuntimeState;

  beforeEach(() => {
    policyState = new PolicyRuntimeState();
  });

  test('renders empty guidance when no bundles are loaded', () => {
    const panel = new PolicyPanel(policyState);
    const text = linesText(panel.render(100, 12));
    expect(text).toContain('No policy bundles loaded');
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
