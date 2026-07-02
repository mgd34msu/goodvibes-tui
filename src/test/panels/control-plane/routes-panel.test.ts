import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RoutesPanel } from '../../../panels/routes-panel.ts';
import { SessionBrowserPanel } from '../../../panels/session-browser-panel.ts';
import type { PanelIntegrationContext } from '../../../panels/types.ts';
import type { SessionBrowserQuery } from '../../../runtime/ui-service-queries.ts';
import { createRoutesReadModel } from '../../helpers/ui-read-models.ts';
import { baseRoute, createDomainDispatch, createRuntimeStore, linesText, setupControlPlaneBrokers, teardownControlPlaneBrokers } from './_shared.ts';

function emptySessionQuery(): SessionBrowserQuery {
  return { list: () => [], search: () => [], delete: () => {} } as unknown as SessionBrowserQuery;
}

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = setupControlPlaneBrokers().root;
  });

  afterEach(() => {
    teardownControlPlaneBrokers(root);
  });

  test('RoutesPanel renders bound surface/session context', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRouteBinding(baseRoute(), 'test');

    const panel = new RoutesPanel(createRoutesReadModel(store));
    const text = linesText(panel.render(100, 26));
    expect(text).toContain('Route Bindings');
    expect(text).toContain('slack');
    expect(text).toContain('session-shared');
    expect(text).toContain('build-alerts');
  });

  test('Enter opens the session browser focused on the binding session (WO-138)', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRouteBinding(baseRoute(), 'test'); // sessionId: 'session-shared'

    const panel = new RoutesPanel(createRoutesReadModel(store));
    panel.render(100, 26); // populate getVisibleItems()/selectedIndex
    expect(panel.handleInput('enter')).toBe(true);

    const sessionsPanel = new SessionBrowserPanel(emptySessionQuery());
    const focusCalls: string[] = [];
    const originalFocusSession = sessionsPanel.focusSession.bind(sessionsPanel);
    sessionsPanel.focusSession = (sessionId: string) => { focusCalls.push(sessionId); originalFocusSession(sessionId); };

    const opens: string[] = [];
    const ctx = {
      panelManager: { open: (id: string) => { opens.push(id); return sessionsPanel; } },
    } as unknown as PanelIntegrationContext;

    expect(panel.handlePanelIntegrationAction?.('enter', ctx)).toBe(true);
    expect(opens).toEqual(['sessions']);
    expect(focusCalls).toEqual(['session-shared']);
  });

  test('c opens the communication panel', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRouteBinding(baseRoute(), 'test');

    const panel = new RoutesPanel(createRoutesReadModel(store));
    panel.render(100, 26);
    expect(panel.handleInput('c')).toBe(true);

    const opens: string[] = [];
    const ctx = {
      panelManager: { open: (id: string) => { opens.push(id); return null as never; } },
    } as unknown as PanelIntegrationContext;

    expect(panel.handlePanelIntegrationAction?.('c', ctx)).toBe(true);
    expect(opens).toEqual(['communication']);
  });

  test('routes footer no longer advertises a slash command as a keybinding', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRouteBinding(baseRoute(), 'test');

    const panel = new RoutesPanel(createRoutesReadModel(store));
    const text = linesText(panel.render(100, 26));
    expect(text).not.toContain('/communication');
  });
});
