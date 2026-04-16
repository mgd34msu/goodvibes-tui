import { afterEach, describe, expect, test } from 'bun:test';
import { SecurityPanel } from '../../panels/security-panel.ts';
import {
  ApiTokenAuditor,
} from '@pellux/goodvibes-sdk/platform/security/token-audit';
import type { Line } from '../../types/grid.ts';
import { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/registry';
import type { PluginManagerObserver, PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import type { McpDecisionRecord } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';
import type { UiSecuritySnapshot } from '../../runtime/ui-read-models.ts';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import { buildMcpAttackPathReview } from '@pellux/goodvibes-sdk/platform/runtime/mcp/index';

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

function makePlugins(entries: PluginStatus[] = []): PluginManagerObserver {
  return {
    subscribe: () => () => {},
    list: () => entries,
    capabilities: () => null,
    getTrustRecord: () => undefined,
    getQuarantineRecord: () => undefined,
  };
}

function createSecurityPanel(snapshot: UiSecuritySnapshot): SecurityPanel {
  return new SecurityPanel(createStaticUiReadModel(snapshot));
}

function createSecuritySnapshot(input: {
  auditor: ApiTokenAuditor;
  policyStatus?: UiSecuritySnapshot['policy']['preflightStatus'];
  policyIssueCount?: number;
  lintFindingCount?: number;
  deniedPermissions?: number;
  incidents?: UiSecuritySnapshot['incidents'];
  latestIncident?: UiSecuritySnapshot['latestIncident'];
  mcpServers?: UiSecuritySnapshot['mcpServers'];
  recentMcpDecisions?: UiSecuritySnapshot['recentMcpDecisions'];
  plugins?: PluginStatus[];
}): UiSecuritySnapshot {
  const report = input.auditor.auditAll(Date.now());
  const mcpServers = input.mcpServers ?? [];
  const recentMcpDecisions = input.recentMcpDecisions ?? [];
  const plugins = input.plugins ?? [];
  return {
    audit: {
      managed: input.auditor.isManaged,
      totalTokens: input.auditor.tokenCount,
      results: report.results,
      blocked: report.blocked,
      scopeViolations: report.scopeViolations,
      rotationWarnings: report.rotationWarnings,
      rotationOverdue: report.rotationOverdue,
      lastAuditAt: report.capturedAt,
      capturedAt: new Date(report.capturedAt).toISOString(),
    },
    policy: {
      preflightStatus: input.policyStatus ?? 'n/a',
      preflightIssueCount: input.policyIssueCount ?? 0,
      lintFindingCount: input.lintFindingCount ?? 0,
    },
    deniedPermissions: input.deniedPermissions ?? 0,
    incidents: input.incidents ?? [],
    latestIncident: input.latestIncident,
    mcpServers,
    recentMcpDecisions,
    attackPathReview: buildMcpAttackPathReview({
      servers: mcpServers,
      recentDecisions: recentMcpDecisions,
    }),
    plugins,
    quarantinedPlugins: plugins.filter((plugin) => plugin.quarantined),
    untrustedPlugins: plugins.filter((plugin) => plugin.trustTier === 'untrusted'),
  };
}

describe('SecurityPanel', () => {
  test('renders empty guidance when no tokens are registered', () => {
    const panel = createSecurityPanel(createSecuritySnapshot({ auditor: makeAuditor() }));
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
    const panel = createSecurityPanel(createSecuritySnapshot({
      auditor,
      plugins: makePlugins().list(),
    }));
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

    const policyState = new PolicyRuntimeState();
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

    const plugins = makePlugins([
      {
        name: 'dangerous-plugin',
        version: '1.0.0',
        description: 'dangerous plugin',
        enabled: true,
        active: false,
        trustTier: 'untrusted',
        quarantined: true,
      },
    ]);

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

    const panel = createSecurityPanel(createSecuritySnapshot({
      auditor,
      policyStatus: 'warn',
      policyIssueCount: 1,
      deniedPermissions: 2,
      incidents: registry.getAll(),
      latestIncident: registry.latest(),
      mcpServers: [{
        name: 'ops',
        role: 'ops',
        trustMode: 'allow-all',
        allowedPaths: ['/srv'],
        allowedHosts: ['deploy.example.com'],
        schemaFreshness: 'quarantined',
        quarantineReason: 'operator_flagged',
        quarantineDetail: 'unexpected deploy surface',
        connected: true,
      }],
      recentMcpDecisions: mcpSource.listRecentSecurityDecisions(),
      plugins: plugins.list(),
    }));
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
