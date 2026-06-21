import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';

import {
  RouteStore,
  parseChannelId,
  buildChannelId,
  resolveProfile,
  createRoutingResolver,
  registerRoutingMethods,
  WILDCARD_SURFACE,
  type RoutingChannelRoute,
  type RoutingListOutput,
  type RoutingAssignOutput,
  type RoutingDeleteOutput,
  type RoutingRegistration,
} from '../../../daemon/channels/routing/index.ts';
import type { OperatorContext, OperatorLogger } from '../../../daemon/operator/index.ts';
import { REQUIRE_CONFIRM } from '../../../daemon/operator/index.ts';

function noopLogger(): OperatorLogger {
  return { info() {}, warn() {}, error() {} };
}

/** Build an OperatorContext whose only meaningful field is workingDirectory + catalog. */
function makeContext(workingDirectory: string, catalog: GatewayMethodCatalog): OperatorContext {
  return {
    catalog,
    // The routing surface never touches secrets/configManager; cast a minimal stub.
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory,
    homeDirectory: workingDirectory,
    logger: noopLogger(),
  };
}

/** Capture the `.code` of an OperatorError thrown by an async invocation. */
async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect((thrown as { code?: string }).code).toBe(code);
}

async function invoke<T>(
  catalog: GatewayMethodCatalog,
  methodId: string,
  body: unknown,
  options: { principalId?: string; explicitUserRequest?: boolean } = {},
): Promise<T> {
  const metadata = options.explicitUserRequest === undefined
    ? undefined
    : { explicitUserRequest: options.explicitUserRequest };
  return (await catalog.invoke(methodId, {
    body,
    context: { principalId: options.principalId ?? 'tester', metadata },
  })) as T;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-routing-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseChannelId / buildChannelId
// ---------------------------------------------------------------------------

describe('parseChannelId / buildChannelId', () => {
  test('parses surface-only channelId', () => {
    expect(parseChannelId('slack')).toEqual({ surfaceKind: 'slack' });
  });

  test('parses composite channelId on first colon', () => {
    expect(parseChannelId('slack:C123')).toEqual({ surfaceKind: 'slack', routeId: 'C123' });
  });

  test('keeps later colons inside routeId', () => {
    expect(parseChannelId('slack:C123:thread')).toEqual({
      surfaceKind: 'slack',
      routeId: 'C123:thread',
    });
  });

  test('collapses a trailing colon to surface-only', () => {
    expect(parseChannelId('discord:')).toEqual({ surfaceKind: 'discord' });
  });

  test('throws on empty channelId', () => {
    expect(() => parseChannelId('   ')).toThrow();
  });

  test('buildChannelId round-trips', () => {
    expect(buildChannelId('slack')).toBe('slack');
    expect(buildChannelId('slack', 'C123')).toBe('slack:C123');
    expect(buildChannelId('slack', '')).toBe('slack');
  });
});

// ---------------------------------------------------------------------------
// RouteStore
// ---------------------------------------------------------------------------

describe('RouteStore', () => {
  test('inserts a new assignment and persists the sqlite file', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    try {
      const { route, created } = await store.upsert({
        channelId: 'slack:C123',
        profileId: 'profile-a',
        label: 'Support',
      });
      expect(created).toBe(true);
      expect(route.assignmentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(route.channelId).toBe('slack:C123');
      expect(route.surfaceKind).toBe('slack');
      expect(route.routeId).toBe('C123');
      expect(route.profileId).toBe('profile-a');
      expect(route.label).toBe('Support');
      expect(route.createdAt).toBe(route.updatedAt);
      expect(existsSync(store.dbPath)).toBe(true);
      expect(store.dbPath).toContain(join('.goodvibes', 'tui', 'operator', 'channel-routes.sqlite'));
    } finally {
      store.close();
    }
  });

  test('updates an existing channel keeping a stable assignmentId', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    try {
      const first = await store.upsert({ channelId: 'slack:C123', profileId: 'profile-a' });
      const second = await store.upsert({ channelId: 'slack:C123', profileId: 'profile-b', label: 'X' });
      expect(second.created).toBe(false);
      expect(second.route.assignmentId).toBe(first.route.assignmentId);
      expect(second.route.profileId).toBe('profile-b');
      expect(second.route.label).toBe('X');
      expect(store.listAll()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('filters list by profileId and surfaceKind', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    try {
      await store.upsert({ channelId: 'slack:C1', profileId: 'p1' });
      await store.upsert({ channelId: 'slack:C2', profileId: 'p2' });
      await store.upsert({ channelId: 'discord:D1', profileId: 'p1' });
      expect(store.list({ profileId: 'p1' })).toHaveLength(2);
      expect(store.list({ surfaceKind: 'slack' })).toHaveLength(2);
      expect(store.list({ surfaceKind: 'slack', profileId: 'p1' })).toHaveLength(1);
      expect(store.list()).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  test('delete removes a row and returns false for unknown ids', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    try {
      const { route } = await store.upsert({ channelId: 'slack', profileId: 'p1' });
      expect(await store.delete(route.assignmentId)).toBe(true);
      expect(store.listAll()).toHaveLength(0);
      expect(await store.delete(route.assignmentId)).toBe(false);
      expect(await store.delete('does-not-exist')).toBe(false);
    } finally {
      store.close();
    }
  });

  test('rejects empty profileId / assignmentId', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    try {
      await expect(store.upsert({ channelId: 'slack', profileId: '   ' })).rejects.toThrow();
      await expect(store.delete('   ')).rejects.toThrow();
    } finally {
      store.close();
    }
  });

  test('persists assignments across store reopen', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    await store.upsert({ channelId: 'slack:C9', profileId: 'p9' });
    store.close();

    const reopened = new RouteStore({ workingDirectory: workDir });
    await reopened.init();
    try {
      const routes = reopened.listAll();
      expect(routes).toHaveLength(1);
      expect(routes[0]?.channelId).toBe('slack:C9');
      expect(routes[0]?.profileId).toBe('p9');
    } finally {
      reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProfile / createRoutingResolver
// ---------------------------------------------------------------------------

function route(partial: Partial<RoutingChannelRoute>): RoutingChannelRoute {
  return {
    assignmentId: partial.assignmentId ?? 'a',
    channelId: partial.channelId ?? 'slack',
    surfaceKind: partial.surfaceKind ?? 'slack',
    routeId: partial.routeId,
    profileId: partial.profileId ?? 'p',
    label: partial.label,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveProfile', () => {
  test('prefers exact (surfaceKind + routeId) match', () => {
    const routes = [
      route({ surfaceKind: 'slack', routeId: 'C123', profileId: 'exact' }),
      route({ surfaceKind: 'slack', profileId: 'surface' }),
      route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' }),
    ];
    expect(resolveProfile(routes, 'slack', 'C123')).toBe('exact');
  });

  test('falls back to surface-only when routeId does not match', () => {
    const routes = [
      route({ surfaceKind: 'slack', routeId: 'C123', profileId: 'exact' }),
      route({ surfaceKind: 'slack', profileId: 'surface' }),
      route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' }),
    ];
    expect(resolveProfile(routes, 'slack', 'OTHER')).toBe('surface');
  });

  test('falls back to wildcard when no surface match exists', () => {
    const routes = [
      route({ surfaceKind: 'discord', profileId: 'd' }),
      route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' }),
    ];
    expect(resolveProfile(routes, 'slack', 'C123')).toBe('wild');
    expect(resolveProfile(routes, 'slack')).toBe('wild');
  });

  test('returns null when nothing matches', () => {
    expect(resolveProfile([route({ surfaceKind: 'discord', profileId: 'd' })], 'slack')).toBeNull();
    expect(resolveProfile([], 'slack')).toBeNull();
    expect(resolveProfile([route({})], '')).toBeNull();
  });

  test('surface-only resolution ignores routes that carry a routeId', () => {
    const routes = [route({ surfaceKind: 'slack', routeId: 'C123', profileId: 'exact' })];
    // No surface-only route exists — a routed entry must not satisfy a bare surface lookup.
    expect(resolveProfile(routes, 'slack')).toBeNull();
  });

  test('createRoutingResolver reads live store state', async () => {
    const store = new RouteStore({ workingDirectory: workDir });
    await store.init();
    try {
      const resolver = createRoutingResolver(store);
      expect(resolver.getProfileForChannel('slack', 'C1')).toBeNull();
      await store.upsert({ channelId: 'slack:C1', profileId: 'live' });
      expect(resolver.getProfileForChannel('slack', 'C1')).toBe('live');
      // resolveProfile alias mirrors getProfileForChannel.
      expect(resolver.resolveProfile('slack', 'C1')).toBe('live');
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Operator method registration (against the real SDK catalog)
// ---------------------------------------------------------------------------

describe('channels.routing.* operator methods', () => {
  let catalog: GatewayMethodCatalog;
  let registration: RoutingRegistration;

  beforeEach(() => {
    catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    registration = registerRoutingMethods(makeContext(workDir, catalog));
  });

  afterEach(() => {
    registration();
  });

  test('registers all three methods with correct metadata', () => {
    const list = catalog.get('channels.routing.list');
    const assign = catalog.get('channels.routing.assign');
    const del = catalog.get('channels.routing.delete');
    expect(list?.scopes).toEqual(['channels:routing:read']);
    expect(assign?.scopes).toEqual(['channels:routing:write']);
    expect(del?.scopes).toEqual(['channels:routing:write']);
    expect(list?.access).toBe('authenticated');
    // Daemon source maps to 'builtin' at the catalog layer.
    expect(assign?.source).toBe('builtin');
  });

  test('assign creates then updates, list reflects it, delete removes it', async () => {
    const created = await invoke<RoutingAssignOutput>(
      catalog,
      'channels.routing.assign',
      { channelId: 'slack:C123', profileId: 'profile-a', label: 'Support', confirm: true },
      { explicitUserRequest: true },
    );
    expect(created.created).toBe(true);
    expect(created.channelId).toBe('slack:C123');
    expect(created.profileId).toBe('profile-a');
    expect(created.assignmentId).toMatch(/^[0-9a-f-]{36}$/);

    const updated = await invoke<RoutingAssignOutput>(
      catalog,
      'channels.routing.assign',
      { channelId: 'slack:C123', profileId: 'profile-b', confirm: true },
      { explicitUserRequest: true },
    );
    expect(updated.created).toBe(false);
    expect(updated.assignmentId).toBe(created.assignmentId);
    expect(updated.profileId).toBe('profile-b');

    const listed = await invoke<RoutingListOutput>(catalog, 'channels.routing.list', {});
    expect(listed.routes).toHaveLength(1);
    expect(listed.routes[0]?.profileId).toBe('profile-b');

    const filtered = await invoke<RoutingListOutput>(
      catalog,
      'channels.routing.list',
      { surfaceKind: 'slack', profileId: 'profile-b' },
    );
    expect(filtered.routes).toHaveLength(1);

    const removed = await invoke<RoutingDeleteOutput>(
      catalog,
      'channels.routing.delete',
      { assignmentId: created.assignmentId, confirm: true },
      { explicitUserRequest: true },
    );
    expect(removed.deleted).toBe(true);

    const afterDelete = await invoke<RoutingListOutput>(catalog, 'channels.routing.list', {});
    expect(afterDelete.routes).toHaveLength(0);
  });

  test('delete returns deleted:false for unknown assignmentId', async () => {
    const removed = await invoke<RoutingDeleteOutput>(
      catalog,
      'channels.routing.delete',
      { assignmentId: 'missing', confirm: true },
      { explicitUserRequest: true },
    );
    expect(removed.deleted).toBe(false);
  });

  test('assign requires confirmation (confirm + explicitUserRequest)', async () => {
    // Missing both confirm flag and explicitUserRequest.
    await expect(
      invoke(catalog, 'channels.routing.assign', { channelId: 'slack', profileId: 'p' }),
    ).rejects.toThrow();
    // confirm body flag present but no explicitUserRequest metadata.
    await expectErrorCode(
      invoke(catalog, 'channels.routing.assign', { channelId: 'slack', profileId: 'p', confirm: true }),
      REQUIRE_CONFIRM,
    );
    // explicitUserRequest present but confirm body flag missing.
    await expectErrorCode(
      invoke(
        catalog,
        'channels.routing.assign',
        { channelId: 'slack', profileId: 'p' },
        { explicitUserRequest: true },
      ),
      REQUIRE_CONFIRM,
    );
  });

  test('delete requires confirmation', async () => {
    await expectErrorCode(
      invoke(catalog, 'channels.routing.delete', { assignmentId: 'x', confirm: true }),
      REQUIRE_CONFIRM,
    );
  });

  test('list is read-only and needs no confirmation', async () => {
    const result = await invoke<RoutingListOutput>(catalog, 'channels.routing.list', {});
    expect(result.routes).toEqual([]);
  });

  test('assign rejects missing required fields', async () => {
    await expect(
      invoke(
        catalog,
        'channels.routing.assign',
        { profileId: 'p', confirm: true },
        { explicitUserRequest: true },
      ),
    ).rejects.toThrow();
    await expect(
      invoke(
        catalog,
        'channels.routing.assign',
        { channelId: 'slack', confirm: true },
        { explicitUserRequest: true },
      ),
    ).rejects.toThrow();
  });

  test('registration exposes a resolver bound to the live store', async () => {
    await invoke<RoutingAssignOutput>(
      catalog,
      'channels.routing.assign',
      { channelId: 'any', profileId: 'fallback', confirm: true },
      { explicitUserRequest: true },
    );
    expect(registration.resolver.getProfileForChannel('telegram', 'whatever')).toBe('fallback');
    expect(registration.store.listAll()).toHaveLength(1);
  });
});
