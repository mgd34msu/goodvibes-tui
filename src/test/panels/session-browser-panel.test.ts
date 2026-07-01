import { describe, expect, test } from 'bun:test';
import { SessionBrowserPanel } from '../../panels/session-browser-panel.ts';
import type { SessionBrowserQuery } from '../../runtime/ui-service-queries.ts';
import type { SessionInfo } from '@pellux/goodvibes-sdk/platform/sessions';

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
});
