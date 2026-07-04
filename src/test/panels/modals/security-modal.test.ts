import { describe, test, expect } from 'bun:test';
import { bindSecurityModal, securityModalGoldenSurface } from '../../../panels/modals/security-modal.ts';
import { EMPTY_VIEW, type ModalViewState } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';
import type { UiReadModel, UiSecuritySnapshot } from '../../../runtime/ui-read-models.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. Mirrors marketplace-modal.test.ts's helper. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

function fixedReadModel(snapshot: UiSecuritySnapshot): UiReadModel<UiSecuritySnapshot> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

const EMPTY_SNAPSHOT: UiSecuritySnapshot = {
  audit: {
    managed: false,
    totalTokens: 0,
    results: [],
    blocked: [],
    scopeViolations: [],
    rotationWarnings: [],
    rotationOverdue: [],
    lastAuditAt: null,
    capturedAt: '2023-11-14T22:13:20.000Z',
  },
  policy: { preflightStatus: 'n/a', preflightIssueCount: 0, lintFindingCount: 0 },
  deniedPermissions: 0,
  incidents: [],
  latestIncident: null,
  mcpServers: [],
  recentMcpDecisions: [],
  attackPathReview: {
    reviewedAt: 1700000000000,
    totalServers: 0,
    connectedServers: 0,
    allowAllServers: 0,
    askOnRiskServers: 0,
    constrainedServers: 0,
    blockedServers: 0,
    quarantinedServers: 0,
    incoherentFindings: 0,
    criticalFindings: 0,
    findings: [],
    summary: 'No MCP servers registered.',
  },
  plugins: [],
  quarantinedPlugins: [],
  untrustedPlugins: [],
};

describe('security modal builder', () => {
  test('empty state names the honest reason (governance data exists, token audit does not)', () => {
    const surface = bindSecurityModal({ readModel: fixedReadModel(EMPTY_SNAPSHOT) });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('No API tokens are registered with the security auditor yet.');
    expect(text).toContain('/storage review');
    expect(text).toContain('/mcp trust');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('golden fixture: populated audit lists tokens with severity coloring and governance summary', () => {
    const surface = securityModalGoldenSurface();
    const config = surface.buildConfig(EMPTY_VIEW);
    const text = configText(config);
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('SLACK_BOT_TOKEN');
    expect(text).toContain('mode MANAGED');
    expect(text).toContain('tokens 2');
    expect(text).toContain('blocked 1');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['tok-openai', 'tok-slack']);
  });

  test('golden fixture: selected-token detail, MCP/plugin quarantine, and attack-path review all render', () => {
    const surface = securityModalGoldenSurface();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    // Selected (index 0) token detail.
    expect(text).toContain('Token OPENAI_API_KEY');
    expect(text).toContain('Scope ok');
    // MCP + plugin quarantine.
    expect(text).toContain('MCP quarantine: fs-server');
    expect(text).toContain('Plugin quarantine: legacy-formatter');
    // Incident.
    expect(text).toContain('Latest incident: permission_denied');
    // Attack-path review.
    expect(text).toContain('MCP Attack-Path Review');
    expect(text).toContain('CRITICAL fs-server');
    expect(text).toContain('critical 1');
  });

  test('query filters the token list and rowIds', () => {
    const surface = securityModalGoldenSurface();
    const view: ModalViewState = { ...EMPTY_VIEW, query: 'slack' };
    const text = configText(surface.buildConfig(view));
    expect(text).toContain('SLACK_BOT_TOKEN');
    expect(text).not.toContain('OPENAI_API_KEY');
    expect(surface.rowIds(view)).toEqual(['tok-slack']);
  });

  test('no wall-clock: two renders at different closure calls produce identical config text', () => {
    const surface = securityModalGoldenSurface();
    const a = configText(surface.buildConfig(EMPTY_VIEW));
    const b = configText(surface.buildConfig(EMPTY_VIEW));
    expect(a).toBe(b);
    // Absolute ISO formatting, never a wall-clock relative string.
    expect(a).toContain('Last audit 2023-11-14T22:13:20.000Z');
  });

  test('preflight action routes to the /policy command path (no modal-ized confirm)', () => {
    const surface = securityModalGoldenSurface();
    expect(surface.actions.preflight!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/policy preflight' });
  });

  test('refresh action asks the host to re-render (read-model surface, no disk reload)', () => {
    const surface = securityModalGoldenSurface();
    expect(surface.actions.refresh!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
  });

  test('jumpToIncident routes to the fleet incident panel when a latest incident exists, no-op otherwise', () => {
    // 'incident' folded into fleet (a live panel, not a modal), so the jump
    // routes to the panel via its command path rather than a modal.
    const withIncident = securityModalGoldenSurface();
    expect(withIncident.actions.jumpToIncident!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/panel open incident' });

    const withoutIncident = bindSecurityModal({ readModel: fixedReadModel(EMPTY_SNAPSHOT) });
    expect(withoutIncident.actions.jumpToIncident!(EMPTY_VIEW)).toEqual({ kind: 'none' });
  });
});
