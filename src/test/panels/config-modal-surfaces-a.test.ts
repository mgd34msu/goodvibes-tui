import { describe, expect, test } from 'bun:test';
import { createServicesModalSurface } from '../../panels/modals/services-modal.ts';
import { createSubscriptionModalSurface } from '../../panels/modals/subscription-modal.ts';
import { createRemoteModalSurface } from '../../panels/modals/remote-modal.ts';
import type { ServiceInspectionQuery, SubscriptionAccessQuery } from '@/runtime/index.ts';
import type { UiReadModel, UiRemoteSnapshot } from '../../runtime/ui-read-models.ts';
import type { ConfigModalActionContext, ConfigModalRow } from '../../input/config-modal-types.ts';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function ctx(row: ConfigModalRow | null, extra: Partial<ConfigModalActionContext> = {}): ConfigModalActionContext {
  return {
    row,
    tabId: 't',
    print: () => {},
    requestRender: () => {},
    setStatus: () => {},
    close: () => {},
    ...extra,
  };
}

function rowsText(view: { tabs: readonly { rows: readonly ConfigModalRow[] }[] }, tab = 0): string {
  return view.tabs[tab]!.rows.map((r) => r.label).join('\n');
}

describe('services modal surface', () => {
  const registry = {
    getAll: () => ({
      alpha: { name: 'alpha', authType: 'api-key', baseUrl: 'http://alpha' },
      beta: { name: 'beta', authType: 'oauth', baseUrl: 'http://beta', oauth: {} },
    }),
    inspect: async (name: string) => ({
      config: { name, authType: name === 'beta' ? 'oauth' : 'api-key', baseUrl: `http://${name}` },
      hasPrimaryCredential: name === 'alpha',
      hasWebhookUrl: false, hasSigningSecret: false, hasAppToken: false,
    }),
    testConnection: async (name: string) => ({ ok: true, status: 200, testedUrl: `http://${name}` }),
  } as unknown as ServiceInspectionQuery;
  const subs = { getAccessToken: () => null, get: () => null } as unknown as SubscriptionAccessQuery;

  test('buildView renders a posture header and a row per service after refresh', async () => {
    const surface = createServicesModalSurface(registry, subs);
    surface.onOpen?.(() => {});
    await flush();
    const view = surface.buildView();
    expect(view.tabs[0]!.header?.[0]).toContain('services 2');
    const text = rowsText(view);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).toContain('CONFIGURED'); // alpha has a primary credential
    expect(text).toContain('UNCONFIGURED'); // beta does not
  });

  test('the subscription action jumps to the subscription surface', () => {
    const surface = createServicesModalSurface(registry, subs);
    const opened: string[] = [];
    surface.onAction?.('subscription', ctx({ id: 'svc:alpha', label: '' }, { openModal: (n) => opened.push(n) }));
    expect(opened).toEqual(['subscription-modal']);
  });

  test('the test action runs a live connection check for the selected service', async () => {
    let tested = '';
    const reg2 = { ...registry, testConnection: async (n: string) => { tested = n; return { ok: true, status: 200, testedUrl: n }; } } as unknown as ServiceInspectionQuery;
    const surface = createServicesModalSurface(reg2, subs);
    surface.onOpen?.(() => {});
    await flush();
    surface.onAction?.('test', ctx({ id: 'svc:beta', label: '' }));
    await flush();
    expect(tested).toBe('beta');
  });
});

describe('subscription modal surface', () => {
  test('Enter on an active row needs a second Enter to confirm sign-out', () => {
    const loggedOut: string[] = [];
    const manager = {
      list: () => [{ provider: 'openai' }],
      listPending: () => [],
      get: (p: string) => (p === 'openai' ? { tokenType: 'oauth', expiresAt: Date.now() + 1e9, overrideAmbientApiKeys: true } : null),
      getPending: () => null,
      logout: (p: string) => loggedOut.push(p),
      getAccessToken: () => null,
    } as unknown as SubscriptionAccessQuery;
    const surface = createSubscriptionModalSurface({ getAll: () => ({}) }, manager);
    surface.onOpen?.(() => {});
    const row = { id: 'sub:openai', label: '' };
    surface.onAction?.('primary', ctx(row)); // arm
    expect(loggedOut).toEqual([]);
    surface.onAction?.('primary', ctx(row)); // confirm
    expect(loggedOut).toEqual(['openai']);
    surface.onClose?.();
  });

  test('Enter on an available row starts login via the subscription command', () => {
    const calls: Array<[string, string[]]> = [];
    const manager = {
      list: () => [], listPending: () => [], get: () => null, getPending: () => null,
      logout: () => {}, getAccessToken: () => null,
    } as unknown as SubscriptionAccessQuery;
    const serviceRegistry = {
      getAll: () => ({
        svc: {
          name: 'claude',
          providerId: 'claude',
          authType: 'oauth' as const,
          tokenKey: 'claude-token',
          oauth: { authUrl: 'https://example.test/authorize', tokenUrl: 'https://example.test/token', clientId: 'client-id', redirectUri: 'http://localhost/callback' },
        },
      }),
    };
    const surface = createSubscriptionModalSurface(serviceRegistry, manager);
    surface.onOpen?.(() => {});
    surface.onAction?.('primary', ctx({ id: 'sub:claude', label: '' }, {
      executeCommand: async (name, args) => { calls.push([name, args]); return true; },
    }));
    expect(calls).toEqual([['subscription', ['login', 'claude', 'start']]]);
    surface.onClose?.();
  });
});

describe('remote modal surface', () => {
  const snapshot = {
    daemon: { transportState: 'connected', isRunning: true, reconnectAttempts: 0, runningJobCount: 1, lastError: undefined },
    acp: { transportState: 'connected', totalMessages: 3, activeConnections: [
      { agentId: 'agent-1', label: 'worker', transportState: 'degraded', messageCount: 2, errorCount: 1, lastError: 'boom', taskId: 't1', completing: false, connectedAt: Date.now() },
    ] },
    contracts: [{ runnerId: 'runner-1', template: 'default', trustClass: 'trusted', poolId: 'p', transport: { state: 'connected' }, capabilityCeiling: {} }],
    artifacts: [], pools: {},
    supervisor: { sessions: [] },
    distributed: { pairRequests: [], peers: [], work: [] },
  } as unknown as UiRemoteSnapshot;
  const readModel = { getSnapshot: () => snapshot, subscribe: () => () => {} } as unknown as UiReadModel<UiRemoteSnapshot>;

  test('buildView exposes connections and contracts tabs with live status', () => {
    const surface = createRemoteModalSurface(readModel);
    surface.onOpen?.(() => {});
    const view = surface.buildView();
    expect(view.tabs.map((t) => t.id)).toEqual(['connections', 'contracts']);
    expect(rowsText(view, 0)).toContain('agent-1');
    expect(rowsText(view, 1)).toContain('runner-1');
    expect(view.tabs[0]!.header?.[0]).toContain('daemon CONNECTED');
    surface.onClose?.();
  });

  test('degrades honestly with no read-model', () => {
    const surface = createRemoteModalSurface(undefined);
    const view = surface.buildView();
    expect(view.degraded).toBeTruthy();
  });

  test('recover dispatches /remote recover for the selected runner', () => {
    const calls: Array<[string, string[]]> = [];
    const surface = createRemoteModalSurface(readModel);
    surface.onAction?.('recover', ctx({ id: 'conn:agent-1', label: '' }, {
      executeCommand: async (name, args) => { calls.push([name, args]); return true; },
    }));
    expect(calls).toEqual([['remote', ['recover', 'agent-1']]]);
  });
});
