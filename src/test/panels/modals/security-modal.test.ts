import { describe, test, expect } from 'bun:test';
import { createSecurityModalSurface, securityModalGoldenSurface } from '../../../panels/modals/security-modal.ts';
import type { UiReadModel, UiSecuritySnapshot } from '../../../runtime/ui-read-models.ts';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';

function fixedReadModel(snapshot: UiSecuritySnapshot): UiReadModel<UiSecuritySnapshot> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}
const EMPTY_SNAPSHOT: UiSecuritySnapshot = {
  audit: { managed: false, totalTokens: 0, results: [], blocked: [], scopeViolations: [], rotationWarnings: [], rotationOverdue: [], lastAuditAt: null, capturedAt: '2023-11-14T22:13:20.000Z' },
  policy: { preflightStatus: 'n/a', preflightIssueCount: 0, lintFindingCount: 0 },
  deniedPermissions: 0, incidents: [], latestIncident: null, mcpServers: [], recentMcpDecisions: [],
  attackPathReview: { reviewedAt: 1700000000000, totalServers: 0, connectedServers: 0, allowAllServers: 0, askOnRiskServers: 0, constrainedServers: 0, blockedServers: 0, quarantinedServers: 0, incoherentFindings: 0, criticalFindings: 0, findings: [], summary: 'No MCP servers registered.' },
  plugins: [], quarantinedPlugins: [], untrustedPlugins: [],
};

describe('security modal surface', () => {
  test('surface identity', () => { expect(createSecurityModalSurface({ readModel: fixedReadModel(EMPTY_SNAPSHOT) }).name).toBe('security-modal'); });

  test('empty state names the honest reason (governance exists, token audit does not)', () => {
    const text = tabText(open(createSecurityModalSurface({ readModel: fixedReadModel(EMPTY_SNAPSHOT) })), 'tokens');
    expect(text).toContain('No API tokens are registered with the security auditor yet.');
    expect(text).toContain('/storage review');
    expect(text).toContain('/mcp trust');
  });

  test('golden fixture: Tokens tab lists tokens under the governance summary header', () => {
    const view = open(securityModalGoldenSurface());
    expect(view.tabs.map((t) => t.id)).toEqual(['tokens', 'governance']);
    const tokens = tabText(view, 'tokens');
    expect(tokens).toContain('OPENAI_API_KEY');
    expect(tokens).toContain('SLACK_BOT_TOKEN');
    expect(tokens).toContain('mode MANAGED');
    expect(tokens).toContain('tokens 2');
    expect(tokens).toContain('blocked 1');
    expect(view.tabs[0]!.rows.some((r) => r.id === 'tok-openai')).toBe(true);
    // Absolute ISO audit timestamp, never a wall-clock relative string.
    expect(tokens).toContain('Last audit 2023-11-14T22:13:20.000Z');
  });

  test('golden fixture: Governance tab renders MCP/plugin quarantine, incident, and attack-path review', () => {
    const gov = tabText(open(securityModalGoldenSurface()), 'governance');
    expect(gov).toContain('MCP quarantine: fs-server');
    expect(gov).toContain('Plugin quarantine: legacy-formatter');
    expect(gov).toContain('Latest incident: permission_denied');
    expect(gov).toContain('MCP Attack-Path Review');
    expect(gov).toContain('CRITICAL fs-server');
    expect(gov).toContain('critical 1');
  });

  test('preflight routes to /policy; jumpToIncident routes to fleet only when an incident exists', () => {
    const surface = securityModalGoldenSurface();
    open(surface);
    const preflight = captureCommands();
    surface.onAction?.('preflight', actionCtx(null, preflight.extra));
    expect(preflight.calls).toEqual([['policy', ['preflight']]]);

    expect(findAction(surface, 'jumpToIncident')?.enabledFor?.(null, 'tokens')).toBe(true);
    const jump = captureCommands();
    surface.onAction?.('jumpToIncident', actionCtx(null, jump.extra));
    expect(jump.calls).toEqual([['panel', ['open', 'incident']]]);

    const noIncident = createSecurityModalSurface({ readModel: fixedReadModel(EMPTY_SNAPSHOT) });
    open(noIncident);
    expect(findAction(noIncident, 'jumpToIncident')?.enabledFor?.(null, 'tokens')).toBe(false);
    const noop = captureCommands();
    noIncident.onAction?.('jumpToIncident', actionCtx(null, noop.extra));
    expect(noop.calls).toEqual([]);
  });
});
