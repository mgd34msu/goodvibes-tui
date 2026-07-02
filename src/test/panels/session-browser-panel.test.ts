import { describe, expect, test, mock } from 'bun:test';
import { SessionBrowserPanel } from '../../panels/session-browser-panel.ts';
import type { SessionBrowserQuery } from '../../runtime/ui-service-queries.ts';
import type { SessionInfo } from '@pellux/goodvibes-sdk/platform/sessions';
import type { PanelIntegrationContext } from '../../panels/types.ts';

function makeSession(name: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name,
    title: over.title ?? `Session ${name}`,
    model: over.model ?? 'claude-opus-4-8',
    timestamp: over.timestamp ?? Date.now() - 60_000,
    messageCount: over.messageCount ?? 12,
    titleSource: over.titleSource ?? 'user',
    returnContext: over.returnContext,
    ...over,
  } as SessionInfo;
}

function makeQuery(sessions: SessionInfo[]): SessionBrowserQuery {
  return {
    list: () => sessions,
    search: (q: string) => sessions
      .filter((s) => (s.title ?? '').toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .map((s) => ({ session: s })),
    delete: (_name: string) => {},
  } as unknown as SessionBrowserQuery;
}

function textOf(panel: SessionBrowserPanel, w = 100, h = 24): string {
  return panel.render(w, h).flat().map((c) => c.char).join('');
}

describe('SessionBrowserPanel', () => {
  test('actionable empty state suggests saving a session', () => {
    const panel = new SessionBrowserPanel(makeQuery([]));
    const text = textOf(panel);
    expect(text).toContain('No sessions found');
    expect(text).toContain('/session save');
  });

  test('lists sessions and shows a detail block for the selected one', () => {
    const panel = new SessionBrowserPanel(makeQuery([
      makeSession('s1', { title: 'Refactor auth flow' }),
      makeSession('s2', { title: 'Investigate flaky test' }),
    ]));
    const text = textOf(panel);
    expect(text).toContain('Refactor auth flow');
    expect(text).toContain('Selected');
    expect(text).toContain('claude-opus-4-8');
  });

  test('footer advertises resume/delete only when a session exists', () => {
    const withSessions = new SessionBrowserPanel(makeQuery([makeSession('s1')]));
    const a = textOf(withSessions);
    expect(a).toContain('resume');
    expect(a).toContain('delete');

    const empty = new SessionBrowserPanel(makeQuery([]));
    const b = textOf(empty);
    // 'delete' only appears as a footer hint, which is gated on having a selection.
    expect(b).not.toContain('delete');
    expect(b).toContain('refresh');
  });

  test('every rendered line matches the requested width', () => {
    const panel = new SessionBrowserPanel(makeQuery([makeSession('s1')]));
    for (const line of panel.render(100, 24)) expect(line.length).toBe(100);
  });

  test('focusSession moves the cursor to the matching session (WO-138 routes-panel jump target)', () => {
    // Give s2 a returnContext.activityLabel — this only ever renders inside
    // the "Selected" detail block (never in the plain list rows), so its
    // presence proves the cursor actually moved onto s2 rather than merely
    // that s2's title happens to be visible somewhere in the list.
    const panel = new SessionBrowserPanel(makeQuery([
      makeSession('s1', { title: 'First' }),
      makeSession('s2', { title: 'Second', returnContext: { activityLabel: 'reviewing PR 42' } }),
      makeSession('s3', { title: 'Third' }),
    ]));
    expect(textOf(panel)).not.toContain('reviewing PR 42'); // cursor starts on s1
    panel.focusSession('s2');
    expect(textOf(panel)).toContain('reviewing PR 42');
  });

  test('focusSession on an unknown id clears the filter without crashing', () => {
    const panel = new SessionBrowserPanel(makeQuery([makeSession('s1')]));
    expect(() => panel.focusSession('does-not-exist')).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // WO-141: x = execute the computed next-step command via the bridge
  // ---------------------------------------------------------------------------

  test('x dispatches /session resume <name> via the bridge when no remote runner is present', () => {
    const panel = new SessionBrowserPanel(makeQuery([makeSession('s1')]));
    textOf(panel); // lazy-loads sessions on first render
    expect(panel.handleInput('x')).toBe(true);
    const executeCommand = mock((_name: string, _args: string[]) => Promise.resolve());
    const ctx = { panelManager: { open: mock(() => null) }, executeCommand } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('x', ctx)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('session', ['resume', 's1']);
  });

  test('x dispatches /remote recover <runner> via the bridge when a remote runner is present', () => {
    const panel = new SessionBrowserPanel(makeQuery([
      makeSession('s1', { returnContext: { remoteRunners: ['runner-42'] } }),
    ]));
    textOf(panel); // lazy-loads sessions on first render
    expect(panel.handleInput('x')).toBe(true);
    const executeCommand = mock((_name: string, _args: string[]) => Promise.resolve());
    const ctx = { panelManager: { open: mock(() => null) }, executeCommand } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('x', ctx)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('remote', ['recover', 'runner-42']);
  });

  test('resuming a session with saved returnContext.openPanels re-opens them via PanelManager', () => {
    const panel = new SessionBrowserPanel(makeQuery([
      makeSession('s1', { returnContext: { openPanels: ['tasks', 'inspector'] } }),
    ]));
    textOf(panel); // lazy-loads sessions on first render
    expect(panel.handleInput('return')).toBe(true);
    const open = mock((_id: string) => null);
    const ctx = { panelManager: { open }, executeCommand: mock(() => Promise.resolve()) } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('return', ctx)).toBe(true);
    expect(open).toHaveBeenCalledWith('tasks');
    expect(open).toHaveBeenCalledWith('inspector');
  });
});
