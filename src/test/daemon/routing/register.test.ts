import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { registerRoutingMethods } from '../../../daemon/handlers/routing/index.ts';
import { HandlerError, REQUIRE_CONFIRM } from '../../../daemon/handlers/errors.ts';
import type { GatewayMethodCatalog } from '../../../daemon/handlers/contracts.ts';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import { makeHandlerContext, makeInvocation, makeTmpWorkingDir, type RecordingLogger } from './helpers.ts';

const LIST = 'channels.routing.list';
const ASSIGN = 'channels.routing.assign';
const DELETE = 'channels.routing.delete';

/** assign/delete are confirmation-gated; this wraps a confirmed invocation body. */
function confirmed(body: Record<string, unknown>) {
  return makeInvocation({ ...body, confirm: true });
}

describe('registerRoutingMethods — catalog attachment', () => {
  let tmp: ReturnType<typeof makeTmpWorkingDir>;
  let ctx: HandlerContext;
  let catalog: GatewayMethodCatalog;
  let logger: RecordingLogger;
  let registration: ReturnType<typeof registerRoutingMethods>;

  beforeEach(() => {
    tmp = makeTmpWorkingDir();
    const built = makeHandlerContext(tmp.dir);
    ctx = built.ctx;
    catalog = built.catalog;
    logger = built.logger;
    registration = registerRoutingMethods(ctx);
  });

  afterEach(() => {
    // best-effort: teardown may already have run inside a test.
    try {
      registration.unregister();
    } catch {
      // ignore double teardown
    }
    tmp.cleanup();
  });

  test('attaches handlers to the SDK-registered descriptors without re-declaring them', () => {
    for (const id of [LIST, ASSIGN, DELETE]) {
      // The descriptor pre-exists (SDK auto-registered it); we only add a handler.
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('preserves the canonical SDK descriptor metadata (id/access/dangerous/scopes)', () => {
    const assign = catalog.get(ASSIGN)!;
    expect(assign.id).toBe(ASSIGN);
    expect(assign.access).toBe('admin');
    expect(assign.scopes).toContain('write:channels');

    const del = catalog.get(DELETE)!;
    expect(del.dangerous).toBe(true);
    expect(del.access).toBe('admin');

    const list = catalog.get(LIST)!;
    expect(list.scopes).toContain('read:channels');
  });

  test('teardown detaches the handlers', () => {
    registration.unregister();
    expect(catalog.hasHandler(LIST)).toBe(false);
    expect(catalog.hasHandler(ASSIGN)).toBe(false);
    expect(catalog.hasHandler(DELETE)).toBe(false);
  });

  test('list returns the SDK output shape { routes, total }', async () => {
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }));
    const result = (await catalog.invoke(LIST, makeInvocation({}))) as {
      routes: Array<Record<string, unknown>>;
      total: number;
    };
    expect(Array.isArray(result.routes)).toBe(true);
    expect(result.total).toBe(1);
    expect(result.routes.length).toBe(1);
    const item = result.routes[0]!;
    expect(item.surfaceKind).toBe('slack');
    expect(item.profileId).toBe('work');
    expect(item.routeId).toBe('C1');
    // SDK CHANNEL_ROUTING_RULE_SCHEMA: route items expose `id` (the assignment
    // id) and forbid the daemon-internal `channelId`/`assignmentId` keys
    // (additionalProperties:false). Verify the projected shape exactly.
    expect(typeof item.id).toBe('string');
    expect((item.id as string).length).toBeGreaterThan(0);
    expect(typeof item.createdAt).toBe('string');
    expect(typeof item.updatedAt).toBe('string');
    expect('channelId' in item).toBe(false);
    expect('assignmentId' in item).toBe(false);
  });

  test('list honors profileId/surfaceKind filters and the limit', async () => {
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }));
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'discord', profileId: 'work' }));
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId: 'C2', profileId: 'play' }));

    const byProfile = (await catalog.invoke(LIST, makeInvocation({ profileId: 'work' }))) as { total: number };
    expect(byProfile.total).toBe(2);

    const bySurface = (await catalog.invoke(LIST, makeInvocation({ surfaceKind: 'slack' }))) as { total: number };
    expect(bySurface.total).toBe(2);

    const limited = (await catalog.invoke(LIST, makeInvocation({ limit: 1 }))) as {
      routes: unknown[];
      total: number;
    };
    expect(limited.routes.length).toBe(1);
    expect(limited.total).toBe(1);
  });

  test('assign returns the SDK output shape and supports channelId or surfaceKind+routeId', async () => {
    const viaParts = (await catalog.invoke(
      ASSIGN,
      confirmed({ surfaceKind: 'slack', routeId: 'C1', profileId: 'work', label: 'team' }),
    )) as Record<string, unknown>;
    expect(typeof viaParts.assignmentId).toBe('string');
    expect(viaParts.surfaceKind).toBe('slack');
    expect(viaParts.routeId).toBe('C1');
    expect(viaParts.profileId).toBe('work');
    expect(viaParts.label).toBe('team');
    expect(typeof viaParts.createdAt).toBe('string');
    expect(typeof viaParts.updatedAt).toBe('string');
    expect(viaParts.channelId).toBe('slack:C1');

    // Re-assign the same channel via composite channelId -> same assignmentId.
    const viaChannelId = (await catalog.invoke(
      ASSIGN,
      confirmed({ channelId: 'slack:C1', profileId: 'personal' }),
    )) as Record<string, unknown>;
    expect(viaChannelId.assignmentId).toBe(viaParts.assignmentId);
    expect(viaChannelId.profileId).toBe('personal');
  });

  test('assign rejects a missing profileId / missing surfaceKind+channelId', async () => {
    await expect(
      catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack' })),
    ).rejects.toThrow();
    await expect(
      catalog.invoke(ASSIGN, confirmed({ profileId: 'work' })),
    ).rejects.toThrow();
  });

  test('delete returns the SDK output shape { deleted, assignmentId }', async () => {
    const assigned = (await catalog.invoke(
      ASSIGN,
      confirmed({ surfaceKind: 'slack', profileId: 'work' }),
    )) as { assignmentId: string };

    const removed = (await catalog.invoke(
      DELETE,
      confirmed({ assignmentId: assigned.assignmentId }),
    )) as { deleted: boolean; assignmentId: string };
    expect(removed.deleted).toBe(true);
    expect(removed.assignmentId).toBe(assigned.assignmentId);

    const again = (await catalog.invoke(
      DELETE,
      confirmed({ assignmentId: assigned.assignmentId }),
    )) as { deleted: boolean };
    expect(again.deleted).toBe(false);
  });

  test('the resolver/store handles reflect catalog mutations', async () => {
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }));
    expect(registration.resolveProfileId('slack', 'C1')).toBe('work');
    expect(registration.resolver.getProfileForChannel('slack', 'C1')).toBe('work');
    expect(registration.store.findByChannelId('slack:C1')?.profileId).toBe('work');
    expect(registration.resolveProfileId('telegram')).toBeNull();
  });

  test('assign logs carry the principal and assignment metadata', async () => {
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', profileId: 'work' }));
    const entry = logger.entries.find((e) => e.message === 'channels.routing.assign');
    expect(entry).toBeDefined();
    expect((entry!.meta as { principalId?: string }).principalId).toBe('user-1');
    expect((entry!.meta as { surfaceKind?: string }).surfaceKind).toBe('slack');
  });
});

describe('registerRoutingMethods — confirmation posture', () => {
  let tmp: ReturnType<typeof makeTmpWorkingDir>;
  let catalog: GatewayMethodCatalog;
  let registration: ReturnType<typeof registerRoutingMethods>;

  beforeEach(() => {
    tmp = makeTmpWorkingDir();
    const built = makeHandlerContext(tmp.dir);
    catalog = built.catalog;
    registration = registerRoutingMethods(built.ctx);
  });

  afterEach(() => {
    registration.unregister();
    tmp.cleanup();
  });

  test('assign requires confirm:true AND explicitUserRequest', async () => {
    // Missing confirm flag.
    await expectConfirm(() =>
      catalog.invoke(ASSIGN, makeInvocation({ surfaceKind: 'slack', profileId: 'work' })),
    );
    // confirm set but not an explicit user request.
    await expectConfirm(() =>
      catalog.invoke(
        ASSIGN,
        makeInvocation({ surfaceKind: 'slack', profileId: 'work', confirm: true }, {
          metadata: { explicitUserRequest: false },
        }),
      ),
    );
    // Both present -> succeeds.
    const ok = (await catalog.invoke(
      ASSIGN,
      makeInvocation({ surfaceKind: 'slack', profileId: 'work', confirm: true }),
    )) as { assignmentId: string };
    expect(ok.assignmentId).toBeTruthy();
  });

  test('delete requires confirm:true AND explicitUserRequest', async () => {
    const assigned = (await catalog.invoke(
      ASSIGN,
      makeInvocation({ surfaceKind: 'slack', profileId: 'work', confirm: true }),
    )) as { assignmentId: string };

    await expectConfirm(() =>
      catalog.invoke(DELETE, makeInvocation({ assignmentId: assigned.assignmentId })),
    );
    const removed = (await catalog.invoke(
      DELETE,
      makeInvocation({ assignmentId: assigned.assignmentId, confirm: true }),
    )) as { deleted: boolean };
    expect(removed.deleted).toBe(true);
  });

  test('list is NOT confirmation-gated', async () => {
    const result = (await catalog.invoke(
      LIST,
      makeInvocation({}, { metadata: { explicitUserRequest: false } }),
    )) as { total: number };
    expect(result.total).toBe(0);
  });
});

async function expectConfirm(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error('expected a confirmation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(HandlerError);
    expect((error as HandlerError).code).toBe(REQUIRE_CONFIRM);
    expect((error as HandlerError).status).toBe(403);
  }
}
