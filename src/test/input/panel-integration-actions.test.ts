import { describe, expect, mock, test } from 'bun:test';
import { handlePanelIntegrationAction } from '../../input/handler.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import type { Panel } from '../../panels/types.ts';

// W6.1 (the purge): this file used to cover an instanceof-based cross-panel
// routing table (explorer -> preview, preview -> symbols, tasks/orchestration
// -> inspector, approval -> executeCommand, etc.) hardcoded in
// panel-integration-actions.ts. Every one of those branches targeted a panel
// class that is now DELETE- or RETIRE-disposition (FileExplorerPanel,
// FilePreviewPanel, SymbolOutlinePanel, ApprovalPanel, TasksPanel,
// OrchestrationPanel, AgentInspectorPanel) and was removed along with them —
// see .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1). What remains of
// handlePanelIntegrationAction is a thin passthrough to a panel's own
// `Panel.handlePanelIntegrationAction` hook, which is what this file now
// tests. Surviving panels that implement the hook (diff-panel.ts,
// skills-panel.ts) cover their own cross-panel behavior in their own test
// files.

function makePanel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'test-panel',
    name: 'Test',
    icon: 'T',
    category: 'development',
    isTransient: false,
    isPinned: false,
    needsRender: true,
    onActivate: () => {},
    onDeactivate: () => {},
    onDestroy: () => {},
    render: () => [],
    invalidate() { this.needsRender = true; },
    markRendered() { this.needsRender = false; },
    ...overrides,
  };
}

describe('handlePanelIntegrationAction', () => {
  test('returns false when there is no active panel', () => {
    const panelManager = createTestManagers().panelManager;
    expect(handlePanelIntegrationAction(panelManager, null, 'enter')).toBe(false);
  });

  test('returns false when the active panel has no integration hook', () => {
    const panelManager = createTestManagers().panelManager;
    const panel = makePanel();
    expect(handlePanelIntegrationAction(panelManager, panel, 'enter')).toBe(false);
  });

  test('delegates to the panel\'s own handlePanelIntegrationAction hook and honors true', () => {
    const panelManager = createTestManagers().panelManager;
    const hook = mock((_key: string, _ctx: unknown) => true);
    const panel = makePanel({ handlePanelIntegrationAction: hook });

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter')).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    const [key, ctx] = hook.mock.calls[0]!;
    expect(key).toBe('enter');
    expect((ctx as { panelManager: unknown }).panelManager).toBe(panelManager);
  });

  test('falls through to false when the hook declines the key', () => {
    const panelManager = createTestManagers().panelManager;
    const hook = mock((_key: string, _ctx: unknown) => false);
    const panel = makePanel({ handlePanelIntegrationAction: hook });

    expect(handlePanelIntegrationAction(panelManager, panel, 'x')).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('threads commandContext.executeCommand into the hook context', () => {
    const panelManager = createTestManagers().panelManager;
    const executeCommand = mock(async () => true);
    let seenExecuteCommand: unknown;
    const panel = makePanel({
      handlePanelIntegrationAction: (_key, ctx) => {
        seenExecuteCommand = ctx.executeCommand;
        return true;
      },
    });

    handlePanelIntegrationAction(panelManager, panel, 'enter', { executeCommand } as never);
    expect(seenExecuteCommand).toBe(executeCommand);
  });
});
