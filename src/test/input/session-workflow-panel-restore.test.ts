import { describe, expect, test } from 'bun:test';
import type { SessionReturnContextSummary } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { reopenPanelsFromReturnContext } from '../../input/commands/session-workflow.ts';
import { PanelManager } from '../../panels/panel-manager.ts';

function makeCtx(pm: PanelManager, out: string[]): CommandContext {
  return {
    print: (message: string) => out.push(message),
    workspace: { panelManager: pm },
  } as unknown as CommandContext;
}

function makeSummary(openPanels: readonly string[]): SessionReturnContextSummary {
  return {
    activityLabel: 'idle', statusLabel: 'idle', pendingApprovals: 0, toolCallCount: 0,
    toolResultCount: 0, assistantTurnCount: 0, userTurnCount: 0, lines: [], openPanels,
  };
}

// W6 review (finding 3): saved-layout restore must not lie about a
// MIGRATE-TO-MODAL id like 'sessions' — it has no panel to restore (a modal
// isn't part of a saved panel layout), so restoring it must be skipped and
// noted honestly, never silently dropped or claimed as "reopened".
describe('reopenPanelsFromReturnContext — modal-redirect restore honesty (W6 review, finding 3)', () => {
  test("a redirected id ('sessions') is skipped, never opened as a panel, and noted honestly", () => {
    const pm = new PanelManager();
    pm.registerModalRedirect('sessions', 'sessionPicker');
    const opened: string[] = [];
    pm.setOpenModalCallback((name) => opened.push(name));
    const out: string[] = [];

    const reopened = reopenPanelsFromReturnContext(makeCtx(pm, out), makeSummary(['sessions']));

    expect(reopened).toEqual([]); // not counted as a reopened panel
    expect(opened).toEqual([]); // restore never fires the modal open — no phantom picker pop mid-resume
    expect(out.join('\n')).toContain('sessions moved to a modal — reopen via its command instead of as a panel.');
  });

  test('a genuine panel id in the saved layout is actually reopened, unaffected by the redirect check', () => {
    const pm = new PanelManager();
    pm.registerType({
      id: 'git', name: 'Git', icon: 'G', category: 'development', description: '',
      factory: () => ({
        id: 'git', name: 'Git', icon: 'G', category: 'development',
        onActivate: () => {}, onDeactivate: () => {}, onDestroy: () => {}, render: () => [],
        isTransient: false, isPinned: false, needsRender: false,
        invalidate: () => {}, markRendered: () => {},
      }),
    });
    const out: string[] = [];

    const reopened = reopenPanelsFromReturnContext(makeCtx(pm, out), makeSummary(['git']));

    expect(reopened).toEqual(['git']);
    expect(out.join('\n')).not.toContain('moved to a modal');
  });

  test('a mix of a redirected id and a real panel reopens the real one and notes only the redirected one', () => {
    const pm = new PanelManager();
    pm.registerModalRedirect('sessions', 'sessionPicker');
    pm.registerType({
      id: 'git', name: 'Git', icon: 'G', category: 'development', description: '',
      factory: () => ({
        id: 'git', name: 'Git', icon: 'G', category: 'development',
        onActivate: () => {}, onDeactivate: () => {}, onDestroy: () => {}, render: () => [],
        isTransient: false, isPinned: false, needsRender: false,
        invalidate: () => {}, markRendered: () => {},
      }),
    });
    const out: string[] = [];

    const reopened = reopenPanelsFromReturnContext(makeCtx(pm, out), makeSummary(['sessions', 'git']));

    expect(reopened).toEqual(['git']);
    expect(out.join('\n')).toContain('sessions moved to a modal');
  });
});
