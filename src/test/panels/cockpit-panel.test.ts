import { describe, expect, test } from 'bun:test';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { CockpitPanel } from '../../panels/cockpit-panel.ts';
import type { Line } from '../../types/grid.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import { ApiTokenAuditor } from '../../security/token-audit.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('CockpitPanel', () => {
  test('renders policy preflight posture when policy runtime is wired', () => {
    resetPolicyRuntimeStateForTests();
    const store = createRuntimeStore();
    const policyState = getPolicyRuntimeState();
    policyState.recordPreflightReview({
      generatedAt: new Date().toISOString(),
      status: 'warn',
      summary: '1 warning detected in the current policy posture.',
      issueCount: 1,
      issues: [
        {
          severity: 'warn',
          source: 'mcp',
          serverName: 'docs',
          message: 'MCP server "docs" requires approval for risky actions.',
        },
      ],
    });

    const text = linesText(new CockpitPanel(store, policyState).render(140, 12));
    expect(text).toContain('policy preflight');
    expect(text).toContain('WARN');
    expect(text).toContain('preflight issues');
  });

  test('renders empty guidance when the runtime store is missing', () => {
    const panel = new CockpitPanel();
    const text = linesText(panel.render(100, 10));
    expect(text).toContain('Operator Cockpit');
    expect(text).toContain('Runtime store not wired');
  });

  test('renders summary counts across orchestration, communication, permissions, mcp, and plugins', () => {
    const store = createRuntimeStore();
    const registry = new ForensicsRegistry();
    const tokenAuditor = new ApiTokenAuditor({ managed: true });
    tokenAuditor.registerPolicy({
      id: 'openai',
      name: 'OpenAI API',
      allowedScopes: ['models:read'],
      rotationCadenceMs: 90 * 24 * 60 * 60 * 1000,
      rotationWarningThresholdMs: 14 * 24 * 60 * 60 * 1000,
    });
    tokenAuditor.registerToken({
      id: 'tok-ops',
      label: 'OPENAI_API_KEY',
      issuedAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
      grantedScopes: ['models:read', 'admin:full'],
      policyId: 'openai',
    });
    registry.push({
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
    });
    store.setState((state) => ({
      ...state,
      permissions: {
        ...state.permissions,
        awaitingDecision: true,
        denialCount: 2,
      },
      communication: {
        ...state.communication,
        totalBlocked: 2,
      },
      orchestration: {
        ...state.orchestration,
        totalGraphs: 2,
        activeGraphIds: ['graph-a'],
        recursionGuardTrips: 1,
      },
      mcp: {
        ...state.mcp,
        servers: new Map([
          ['docs', { name: 'docs', displayName: 'Docs', status: 'connected', transport: 'stdio', toolCount: 2, toolNames: ['docs__search'], callCount: 0, errorCount: 0, reconnectAttempts: 0, trustMode: 'ask-on-risk', role: 'docs', allowedPaths: [], allowedHosts: [], schemaFreshness: 'fresh' }],
          ['ops', { name: 'ops', displayName: 'Ops', status: 'degraded', transport: 'stdio', toolCount: 1, toolNames: ['ops__deploy'], callCount: 3, errorCount: 1, reconnectAttempts: 1, trustMode: 'allow-all', role: 'ops', allowedPaths: ['/srv'], allowedHosts: ['deploy.example.com'], schemaFreshness: 'quarantined', quarantineReason: 'operator_flagged', quarantineDetail: 'unexpected deploy surface' }],
        ]),
        connectedServerNames: ['docs'],
      },
      plugins: {
        ...state.plugins,
        plugins: new Map([
          ['alpha', { name: 'alpha', displayName: 'Alpha', version: '1.0.0', description: 'alpha plugin', status: 'active', enabled: true, active: true, toolCount: 1, config: {}, hookInvocations: 0 }],
          ['beta', { name: 'beta', displayName: 'Beta', version: '1.0.0', description: 'beta plugin', status: 'error', enabled: true, active: false, toolCount: 0, error: 'boom', config: {}, hookInvocations: 0 }],
        ]),
        erroredPluginNames: ['beta'],
      },
      integrations: {
        ...state.integrations,
        integrations: new Map([
          ['webhook', { id: 'webhook', displayName: 'Webhook', category: 'communication', status: 'healthy', enabled: true, successCount: 1, errorCount: 0, meta: {} }],
          ['notify', { id: 'notify', displayName: 'Notify', category: 'communication', status: 'error', enabled: true, successCount: 0, errorCount: 1, meta: {} }],
        ]),
      },
    }));

    const text = linesText(new CockpitPanel(store, undefined, registry, tokenAuditor).render(140, 14));
    expect(text).toContain('Operator Cockpit');
    expect(text).toContain('active graphs');
    expect(text).toContain('blocked comms');
    expect(text).toContain('policy preflight');
    expect(text).toContain('token blocked');
    expect(text).toContain('allow-all MCP');
    expect(text).toContain('incidents');
    expect(text).toContain('latest incident');
    expect(text).toContain('errored plugins');
    expect(text).toContain('Use /cockpit');
  });
});
