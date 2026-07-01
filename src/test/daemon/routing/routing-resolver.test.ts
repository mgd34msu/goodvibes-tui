import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createRoutingResolver,
  resolveProfile,
  WILDCARD_SURFACE,
} from '../../../daemon/handlers/routing/routing-resolver.ts';
import type { RoutingChannelRoute } from '../../../daemon/handlers/routing/route-store.ts';
import { RouteStore } from '../../../daemon/handlers/routing/route-store.ts';
import { createInboxRouteResolver } from '../../../daemon/handlers/routing/inbox-bridge.ts';
import { makeTmpWorkingDir } from './helpers.ts';

function route(partial: Partial<RoutingChannelRoute>): RoutingChannelRoute {
  return {
    assignmentId: partial.assignmentId ?? 'a',
    channelId: partial.channelId ?? 'slack',
    surfaceKind: partial.surfaceKind ?? 'slack',
    routeId: partial.routeId,
    profileId: partial.profileId ?? 'p',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    label: partial.label,
  };
}

describe('resolveProfile resolution order', () => {
  const exact = route({ surfaceKind: 'slack', routeId: 'C1', profileId: 'exact' });
  const surface = route({ surfaceKind: 'slack', profileId: 'surface' });
  const wildcard = route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' });
  const all = [exact, surface, wildcard];

  test('1. exact (surfaceKind + routeId) wins when routeId supplied', () => {
    expect(resolveProfile(all, 'slack', 'C1')).toBe('exact');
  });

  test('2. surface-only match when routeId has no exact binding', () => {
    expect(resolveProfile(all, 'slack', 'C-unknown')).toBe('surface');
  });

  test('2. surface-only match when no routeId supplied', () => {
    expect(resolveProfile(all, 'slack')).toBe('surface');
  });

  test('3. wildcard match when surface has no binding', () => {
    expect(resolveProfile(all, 'telegram')).toBe('wild');
  });

  test('returns null when nothing matches and no wildcard exists', () => {
    expect(resolveProfile([exact, surface], 'telegram')).toBeNull();
  });

  test('blank surfaceKind resolves to null', () => {
    expect(resolveProfile(all, '   ')).toBeNull();
  });

  test('exact is preferred over a competing surface-only binding', () => {
    const reversed = [surface, exact];
    expect(resolveProfile(reversed, 'slack', 'C1')).toBe('exact');
  });
});

describe('createRoutingResolver (live store)', () => {
  let tmp: ReturnType<typeof makeTmpWorkingDir>;
  let store: RouteStore;

  beforeEach(async () => {
    tmp = makeTmpWorkingDir();
    store = new RouteStore({ workingDirectory: tmp.dir });
    await store.init();
  });

  afterEach(() => {
    store.close();
    tmp.cleanup();
  });

  test('reflects mutations immediately (reads current route set per call)', async () => {
    const resolver = createRoutingResolver(store);
    expect(resolver.getProfileForChannel('slack', 'C1')).toBeNull();

    await store.upsert({ channelId: 'slack:C1', profileId: 'work' });
    expect(resolver.getProfileForChannel('slack', 'C1')).toBe('work');
    expect(resolver.resolveProfile('slack', 'C1')).toBe('work');

    const found = store.findByChannelId('slack:C1');
    await store.delete(found!.assignmentId);
    expect(resolver.getProfileForChannel('slack', 'C1')).toBeNull();
  });
});

describe('createInboxRouteResolver bridge', () => {
  test('maps provider to surfaceKind and forwards routeId', async () => {
    const tmp = makeTmpWorkingDir();
    const store = new RouteStore({ workingDirectory: tmp.dir });
    await store.init();
    try {
      await store.upsert({ channelId: 'slack:C1', profileId: 'work' });
      await store.upsert({ channelId: 'discord', profileId: 'surface-only' });
      const bridge = createInboxRouteResolver(createRoutingResolver(store));

      expect(bridge({ provider: 'slack', routeId: 'C1' })).toBe('work');
      expect(bridge({ provider: 'discord' })).toBe('surface-only');
      expect(bridge({ provider: 'telegram' })).toBeUndefined();
      expect(bridge({ provider: '' })).toBeUndefined();
      expect(bridge({})).toBeUndefined();
    } finally {
      store.close();
      tmp.cleanup();
    }
  });

  test('never throws on malformed input', () => {
    const bridge = createInboxRouteResolver({
      getProfileForChannel: () => null,
      resolveProfile: () => null,
    });
    expect(bridge({ provider: 123 as unknown as string })).toBeUndefined();
    expect(bridge({ provider: 'slack', routeId: 42 })).toBeUndefined();
  });
});
