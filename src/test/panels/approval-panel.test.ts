import { describe, expect, test, mock } from 'bun:test';
import { ApprovalPanel } from '../../panels/approval-panel.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import type { PermissionAuditEntry } from '@/runtime/index.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';

type PolicyDep = ConstructorParameters<typeof ApprovalPanel>[0];

function makeAudit(entries: Array<Partial<PermissionAuditEntry>>): PolicyDep {
  const audit = entries.map((e, i): PermissionAuditEntry => ({
    callId: `call-${i}`,
    tool: e.tool ?? 'Bash',
    category: e.category ?? 'shell',
    approved: e.approved,
    riskLevel: e.riskLevel ?? 'high',
    classification: e.classification ?? 'destructive',
    summary: e.summary ?? 'rm -rf build artifacts',
    reasons: e.reasons ?? ['destructive filesystem operation'],
    requestedAt: e.requestedAt ?? Date.now() - 5000,
    decidedAt: e.decidedAt,
    target: e.target,
    host: e.host,
  }));
  return {
    getSnapshot: () => ({ recentPermissionAudit: audit }),
  } as unknown as PolicyDep;
}

function textOf(panel: ApprovalPanel, w = 100, h = 24): string {
  return panel.render(w, h).flat().map((cell) => cell.char).join('');
}

describe('ApprovalPanel', () => {
  test('renders an actionable empty state when there is no approval pressure', () => {
    const panel = new ApprovalPanel(new PolicyRuntimeState());
    const text = textOf(panel);
    expect(text).toContain('Approval Control Room');
    expect(text).toContain('pending');
    expect(text).toContain('approved');
    expect(text).toContain('denied');
    expect(text).toContain('No approval pressure');
  });

  test('surfaces a pending request first with its risk and summary', () => {
    const panel = new ApprovalPanel(makeAudit([
      { tool: 'Bash', approved: undefined, riskLevel: 'high', summary: 'rm -rf node_modules' },
      { tool: 'Read', approved: true, riskLevel: 'low', summary: 'read package.json' },
    ]));
    const text = textOf(panel);
    expect(text).toContain('awaiting a decision');
    expect(text).toContain('Bash');
    expect(text).toContain('rm -rf node_modules');
  });

  test('selecting a request shows its detail block and review path', () => {
    const panel = new ApprovalPanel(makeAudit([
      { tool: 'mcp__fetch', category: 'mcp', approved: undefined, summary: 'connect to external host' },
    ]));
    const text = textOf(panel, 100, 24);
    expect(text).toContain('Request');
    expect(text).toContain('lane');
    expect(text).toContain('/mcp trust');
    expect(panel.getSelectedCommand()).toBe('/mcp trust');
  });

  test('footer only advertises the review key when a request is selected', () => {
    const withReq = new ApprovalPanel(makeAudit([{ tool: 'Bash', approved: undefined }]));
    expect(textOf(withReq)).toContain('review');

    const empty = new ApprovalPanel(new PolicyRuntimeState());
    const emptyText = textOf(empty);
    // No selectable request => no review key advertised in the hints row.
    expect(emptyText).toContain('select');
    expect(emptyText).not.toContain('Enter review');
  });

  // ---------------------------------------------------------------------------
  // WO-141: rule suggestions dispatchable via 1/2/3; '/policy simulate' via 'p'
  // ---------------------------------------------------------------------------

  test('p dispatches /policy simulate via the bridge when no request is pending', () => {
    const panel = new ApprovalPanel(new PolicyRuntimeState());
    expect(textOf(panel)).toContain('/policy simulate');
    expect(panel.handleInput('p')).toBe(true);
    const executeCommand = mock((_name: string, _args: string[]) => Promise.resolve());
    const ctx = { panelManager: {}, executeCommand } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('p', ctx)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('policy', ['simulate']);
  });

  test('1 dispatches a repeated-denial rule suggestion command via the bridge', () => {
    const panel = new ApprovalPanel(makeAudit([
      { tool: 'Bash', approved: false, target: 'rm -rf', summary: 'destructive delete' },
      { tool: 'Bash', approved: false, target: 'rm -rf', summary: 'destructive delete' },
    ]));
    const text = textOf(panel);
    expect(text).toContain('Suggested durable rules');
    expect(panel.handleInput('1')).toBe(true);
    const executeCommand = mock((_name: string, _args: string[]) => Promise.resolve());
    const ctx = { panelManager: {}, executeCommand } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('1', ctx)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('policy', expect.arrayContaining(['simulate', 'Bash']));
  });

  test('digit key with no matching suggestion is not consumed', () => {
    const panel = new ApprovalPanel(new PolicyRuntimeState());
    expect(panel.handleInput('1')).toBe(false);
  });
});
