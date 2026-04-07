import { afterEach, describe, expect, test } from 'bun:test';
import { SecurityPanel } from '../../panels/security-panel.ts';
import {
  ApiTokenAuditor,
  _resetTokenAuditorForTesting,
} from '../../security/token-audit.ts';
import type { Line } from '../../types/grid.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import type { PluginManagerObserver } from '../../plugins/manager.ts';
import type { McpDecisionRecord } from '../../runtime/mcp/types.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeAuditor(): ApiTokenAuditor {
  const auditor = new ApiTokenAuditor({ managed: true });
  auditor.registerPolicy({
    id: 'openai',
    name: 'OpenAI API',
    allowedScopes: ['models:read', 'responses:write'],
    rotationCadenceMs: 90 * 24 * 60 * 60 * 1000,
    rotationWarningThresholdMs: 14 * 24 * 60 * 60 * 1000,
  });
  return auditor;
}

describe('SecurityPanel', () => {
  afterEach(() => {
    _resetTokenAuditorForTesting();
    resetPolicyRuntimeStateForTests();
  });

  test('renders empty guidance when no tokens are registered', () => {
    const panel = new SecurityPanel(makeAuditor());
    const text = linesText(panel.render(120, 16));
    expect(text).toContain('Security Control Room');
    expect(text).toContain('Token audit');
    expect(text).toContain('No API tokens are registered');
    expect(text).toContain('/policy preflight');
  });

  test('renders token audit posture and details', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken({
      id: 'tok-main',
      label: 'OPENAI_API_KEY',
      issuedAt: now - 100 * 24 * 60 * 60 * 1000,
      grantedScopes: ['models:read', 'responses:write', 'admin:full'],
      policyId: 'openai',
    });
    const panel = new SecurityPanel(auditor);
    const text = linesText(panel.render(140, 14));
    expect(text).toContain('MANAGED');
    expect(text).toContain('scope violations');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('admin:full');
    expect(text).toContain('rotation');
  });

  test('renders policy posture, MCP quarantine, and incident pressure', () => {
    const auditor = makeAuditor();
    auditor.registerToken({
      id: 'tok-main',
      label: 'OPENAI_API_KEY',
      issuedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      grantedScopes: ['models:read', 'responses:write'],
      policyId: 'openai',
    });

    const policyState = getPolicyRuntimeState();
    policyState.recordPreflightReview({
      generatedAt: new Date().toISOString(),
      status: 'warn',
      summary: '1 warning detected in the current policy posture.',
      issueCount: 1,
      issues: [{
        severity: 'warn',
        source: 'mcp',
        serverName: 'ops',
        message: 'Ops MCP server remains quarantined pending operator review.',
      }],
    });

    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      permissions: {
        ...state.permissions,
        denialCount: 2,
      },
      mcp: {
        ...state.mcp,
        servers: new Map([
          ['ops', {
            name: 'ops',
            displayName: 'Ops',
            status: 'degraded',
            transport: 'stdio',
            toolCount: 1,
            toolNames: ['ops__deploy'],
            callCount: 0,
            errorCount: 1,
            reconnectAttempts: 1,
            trustMode: 'allow-all',
            role: 'ops',
            allowedPaths: ['/srv'],
            allowedHosts: ['deploy.example.com'],
            schemaFreshness: 'quarantined',
            quarantineReason: 'operator_flagged',
            quarantineDetail: 'unexpected deploy surface',
          }],
        ]),
        connectedServerNames: [],
      },
    }));

    const registry = new ForensicsRegistry();
    registry.push({
      id: 'incident-1',
      traceId: 'trace-1',
      sessionId: 'session-1',
      generatedAt: Date.now(),
      classification: 'permission_denied',
      summary: 'permission denied during risky deploy attempt',
      phaseTimings: [],
      phaseLedger: [],
      causalChain: [],
      cascadeEvents: [],
      permissionEvidence: [],
      budgetBreaches: [],
      jumpLinks: [],
    });

    const plugins: PluginManagerObserver = {
      subscribe: () => () => {},
      list: () => [
        {
          name: 'dangerous-plugin',
          version: '1.0.0',
          description: 'dangerous plugin',
          enabled: true,
          active: false,
          trustTier: 'untrusted',
          quarantined: true,
        },
      ],
      capabilities: () => null,
      getTrustRecord: () => undefined,
      getQuarantineRecord: () => undefined,
    };

    const mcpSource = {
      listRecentSecurityDecisions: (_limit = 8): McpDecisionRecord[] => [
        {
          serverName: 'ops',
          toolName: 'exec_shell',
          verdict: 'deny',
          riskLevel: 'critical',
          capability: 'exec',
          incoherent: true,
          reason: 'request is incoherent for ops server',
          profileMode: 'ask-on-risk',
          evaluatedAt: Date.now(),
        },
      ],
    };

    const panel = new SecurityPanel(auditor, policyState, store, registry, plugins, mcpSource);
    const text = linesText(panel.render(160, 28));
    expect(text).toContain('preflight');
    expect(text).toContain('quarantined MCP');
    expect(text).toContain('quarantined plugins');
    expect(text).toContain('denied permissions');
    expect(text).toContain('Latest incident');
    expect(text).toContain('Plugin quarantine');
    expect(text).toContain('unexpected deploy surface');
    expect(text).toContain('attack paths');
    expect(text).toContain('MCP attack-path review');
    expect(text).toContain('exec_shell');
  });
});
