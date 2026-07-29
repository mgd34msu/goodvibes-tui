import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { createLocalAuthModalSurface } from '../../panels/modals/local-auth-modal.ts';
import { createSandboxModalSurface } from '../../panels/modals/sandbox-modal.ts';
import type { LocalAuthInspectionQuery } from '../../runtime/ui-service-queries.ts';
import type { ConfigModalActionContext, ConfigModalRow } from '../../input/config-modal-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

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

const FAKE_PASSWORD = 'super-secret-hunter2';

describe('local-auth modal surface', () => {
  function makeAuthManager(withMutations: boolean): LocalAuthInspectionQuery {
    const base = {
      inspect: () => ({
        userStorePath: '/tmp/gv-test/users.json',
        bootstrapCredentialPath: '/tmp/gv-test/bootstrap.json',
        persisted: true,
        bootstrapCredentialPresent: true,
        userCount: 2,
        sessionCount: 1,
        users: [
          { username: 'alice', roles: ['admin'] },
          { username: 'bob', roles: [] },
        ],
        sessions: [{ tokenFingerprint: 'fp1', username: 'alice', expiresAt: Date.now() + 1_000 }],
      }),
    };
    const mutations = withMutations
      ? {
          addUser: () => ({ username: 'x', roles: [] }),
          deleteUser: () => true,
          rotatePassword: () => {},
          clearBootstrapCredentialFile: () => true,
        }
      : {};
    return { ...base, ...mutations } as unknown as LocalAuthInspectionQuery;
  }

  test('buildView renders a fixed one-line posture header and one row per user', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    const view = surface.buildView();
    expect(view.degraded).toBeUndefined();
    expect(view.tabs).toHaveLength(1);
    expect(view.tabs[0]!.id).toBe('users');
    expect(view.tabs[0]!.header).toHaveLength(1);
    expect(view.tabs[0]!.header?.[0]).toContain('users 2');
    expect(view.tabs[0]!.header?.[0]).toContain('sessions 1');
    expect(view.tabs[0]!.header?.[0]).toContain('bootstrap present');
    const text = rowsText(view);
    expect(text).toContain('alice');
    expect(text).toContain('bob');
  });

  test('no password string ever appears in a rendered row label', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    const view = surface.buildView();
    const text = rowsText(view);
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).not.toContain('password');
  });

  test('degrades honestly when mutations are unavailable', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(false));
    const view = surface.buildView();
    expect(view.degraded).toContain('not available');
    // Read-only degraded state still shows the honest posture + rows.
    expect(rowsText(view)).toContain('alice');
  });

  test('degrades honestly when inspect() throws', () => {
    const broken = { inspect: () => { throw new Error('boom'); } } as unknown as LocalAuthInspectionQuery;
    const surface = createLocalAuthModalSurface(broken);
    const view = surface.buildView();
    expect(view.degraded).toContain('boom');
    expect(view.tabs[0]!.rows).toHaveLength(0);
  });

  test('the delete action is confirm:true and dispatches /local-auth delete-user for the selected username', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    const deleteAction = surface.actions?.find((a) => a.id === 'delete');
    expect(deleteAction?.confirm).toBe(true);
    const calls: Array<[string, string[]]> = [];
    surface.onAction?.('delete', ctx({ id: 'user:alice', label: '' }, {
      executeCommand: async (name, args) => { calls.push([name, args]); return true; },
    }));
    expect(calls).toEqual([['local-auth', ['delete-user', 'alice']]]);
  });

  test('add-user points at the masked /local-auth command instead of dispatching under the modal', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    const calls: Array<[string, string[]]> = [];
    const printed: string[] = [];
    surface.onAction?.('add-user', ctx(null, {
      print: (m) => printed.push(m),
      executeCommand: async (name, args) => { calls.push([name, args]); return true; },
    }));
    // Masked entry cannot render under a fullscreen modal — no command is
    // dispatched into a hidden surface; the operator is pointed at the command.
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('/local-auth add-user');
  });

  test('rotate-pw points at the masked /local-auth command for the selected username', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    const calls: Array<[string, string[]]> = [];
    const printed: string[] = [];
    surface.onAction?.('rotate-pw', ctx({ id: 'user:bob', label: '' }, {
      print: (m) => printed.push(m),
      executeCommand: async (name, args) => { calls.push([name, args]); return true; },
    }));
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('/local-auth rotate-password bob');
  });

  test('clear-bootstrap dispatches /local-auth clear-bootstrap-file', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    const calls: Array<[string, string[]]> = [];
    surface.onAction?.('clear-bootstrap', ctx(null, {
      executeCommand: async (name, args) => { calls.push([name, args]); return true; },
    }));
    expect(calls).toEqual([['local-auth', ['clear-bootstrap-file']]]);
  });

  test('rotate-pw/delete are gated to a user row and clear-bootstrap to bootstrap-present', () => {
    const surface = createLocalAuthModalSurface(makeAuthManager(true));
    surface.buildView(); // populate the enabledFor cache (bootstrapPresent)
    const rotate = surface.actions?.find((a) => a.id === 'rotate-pw');
    const del = surface.actions?.find((a) => a.id === 'delete');
    const clearBootstrap = surface.actions?.find((a) => a.id === 'clear-bootstrap');
    expect(rotate?.enabledFor?.(null, 'users')).toBe(false);
    expect(rotate?.enabledFor?.({ id: 'user:alice', label: '' }, 'users')).toBe(true);
    expect(del?.enabledFor?.(null, 'users')).toBe(false);
    expect(del?.enabledFor?.({ id: 'user:alice', label: '' }, 'users')).toBe(true);
    expect(clearBootstrap?.enabledFor?.(null, 'users')).toBe(true); // fixture has bootstrapCredentialPresent: true
  });
});

describe('sandbox modal surface', () => {
  interface FakeSession {
    id: string;
    profileId: string;
    state: string;
    backend: string;
    resolvedBackend?: string;
    executionCount?: number;
  }

  function makeRegistry(sessions: FakeSession[]) {
    const calls = {
      start: [] as Array<{ profileId: string; label: unknown }>,
      stop: [] as string[],
      execute: [] as Array<{ sessionId: string; command: string; args: string[] }>,
    };
    const registry = {
      list: () => sessions,
      start: async (profileId: string, label: string | undefined) => {
        calls.start.push({ profileId, label });
        return { id: 'new-session', profileId } as unknown;
      },
      stop: (sessionId: string) => {
        calls.stop.push(sessionId);
        return null;
      },
      execute: (sessionId: string, command: string, args: string[]) => {
        calls.execute.push({ sessionId, command, args });
        return { exitCode: 0 } as unknown;
      },
    };
    return { calls, registry: registry as unknown as SandboxSessionRegistry };
  }

  function makeConfig(): ConfigManager {
    const root = makeProjectTempDir('gv-sandbox-modal');
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    config.set('sandbox.replIsolation', 'shared-vm');
    config.set('sandbox.mcpIsolation', 'disabled');
    config.set('sandbox.windowsMode', 'native-basic');
    config.set('sandbox.vmBackend', 'local');
    return config;
  }

  test('buildView exposes profiles and sessions tabs with a fixed one-line posture header', () => {
    const { registry } = makeRegistry([
      { id: 's1', profileId: 'eval-py', state: 'running', backend: 'local', resolvedBackend: 'local', executionCount: 2 },
    ]);
    const surface = createSandboxModalSurface(makeConfig(), registry, () => {});
    const view = surface.buildView();
    expect(view.tabs.map((t) => t.id)).toEqual(['profiles', 'sessions']);
    expect(view.tabs[0]!.header).toHaveLength(1);
    expect(view.tabs[1]!.header).toHaveLength(1);
    expect(rowsText(view, 0)).toContain('eval-py');
    expect(rowsText(view, 1)).toContain('s1');
  });

  test('s starts a sandbox session for the selected profile row', () => {
    const { calls, registry } = makeRegistry([]);
    const surface = createSandboxModalSurface(makeConfig(), registry, () => {});
    surface.onAction?.('start', ctx({ id: 'profile:eval-py', label: '' }));
    expect(calls.start).toEqual([{ profileId: 'eval-py', label: undefined }]);
  });

  test('x is a confirm action and dispatches stop for the selected session row', () => {
    const { calls, registry } = makeRegistry([
      { id: 's1', profileId: 'eval-py', state: 'running', backend: 'local', resolvedBackend: 'local', executionCount: 0 },
    ]);
    const surface = createSandboxModalSurface(makeConfig(), registry, () => {});
    const stopAction = surface.actions?.find((a) => a.id === 'stop');
    expect(stopAction?.confirm).toBe(true);
    surface.onAction?.('stop', ctx({ id: 'session:s1', label: '' }));
    expect(calls.stop).toEqual(['s1']);
  });

  test('e executes a probe against the selected session row', () => {
    const { calls, registry } = makeRegistry([
      { id: 's1', profileId: 'eval-py', state: 'running', backend: 'local', resolvedBackend: 'local', executionCount: 0 },
    ]);
    const surface = createSandboxModalSurface(makeConfig(), registry, () => {});
    surface.onAction?.('execute', ctx({ id: 'session:s1', label: '' }));
    expect(calls.execute).toHaveLength(1);
    expect(calls.execute[0]?.sessionId).toBe('s1');
  });

  test('start/stop/execute are gated to the right tab and row kind', () => {
    const { registry } = makeRegistry([
      { id: 's1', profileId: 'eval-py', state: 'running', backend: 'local', resolvedBackend: 'local', executionCount: 0 },
    ]);
    const surface = createSandboxModalSurface(makeConfig(), registry, () => {});
    surface.buildView();
    const start = surface.actions?.find((a) => a.id === 'start');
    const stop = surface.actions?.find((a) => a.id === 'stop');
    const execute = surface.actions?.find((a) => a.id === 'execute');
    expect(start?.enabledFor?.({ id: 'profile:eval-py', label: '' }, 'profiles')).toBe(true);
    expect(start?.enabledFor?.({ id: 'session:s1', label: '' }, 'sessions')).toBe(false);
    expect(stop?.enabledFor?.({ id: 'session:s1', label: '' }, 'sessions')).toBe(true);
    expect(stop?.enabledFor?.({ id: 'profile:eval-py', label: '' }, 'profiles')).toBe(false);
    expect(execute?.enabledFor?.({ id: 'session:s1', label: '' }, 'sessions')).toBe(true);
  });

  test('degrades honestly when the sandbox review throws', () => {
    const badConfig = {
      get: () => { throw new Error('config exploded'); },
    } as unknown as ConfigManager;
    const { registry } = makeRegistry([]);
    const surface = createSandboxModalSurface(badConfig, registry, () => {});
    const view = surface.buildView();
    expect(view.degraded).toBeTruthy();
  });
});
