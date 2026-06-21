import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildChannelId,
  parseChannelId,
  RouteStore,
} from '../../../daemon/handlers/routing/route-store.ts';
import { HandlerError } from '../../../daemon/handlers/errors.ts';
import { makeTmpWorkingDir } from './helpers.ts';

describe('parseChannelId', () => {
  test('surface-only id has no routeId', () => {
    expect(parseChannelId('slack')).toEqual({ surfaceKind: 'slack' });
  });

  test('splits on the FIRST colon, preserving colons in routeId', () => {
    expect(parseChannelId('slack:C123:thread')).toEqual({
      surfaceKind: 'slack',
      routeId: 'C123:thread',
    });
  });

  test('trims surrounding whitespace', () => {
    expect(parseChannelId('  discord : 99 ')).toEqual({
      surfaceKind: 'discord',
      routeId: '99',
    });
  });

  test('trailing colon collapses to surface-only', () => {
    expect(parseChannelId('slack:')).toEqual({ surfaceKind: 'slack' });
  });

  test('empty channelId throws a 400 HandlerError', () => {
    expect(() => parseChannelId('')).toThrow(HandlerError);
    try {
      parseChannelId('   ');
    } catch (error) {
      expect((error as HandlerError).status).toBe(400);
      expect((error as HandlerError).code).toBe('ROUTING_INVALID_CHANNEL_ID');
    }
  });

  test('missing surfaceKind before colon throws', () => {
    expect(() => parseChannelId(':route')).toThrow(HandlerError);
  });
});

describe('buildChannelId', () => {
  test('omits routeId when absent or empty', () => {
    expect(buildChannelId('slack')).toBe('slack');
    expect(buildChannelId('slack', '')).toBe('slack');
  });

  test('joins surfaceKind and routeId with a colon', () => {
    expect(buildChannelId('slack', 'C123')).toBe('slack:C123');
  });

  test('round-trips with parseChannelId for composite ids', () => {
    const parsed = parseChannelId('discord:guild:42');
    expect(buildChannelId(parsed.surfaceKind, parsed.routeId)).toBe('discord:guild:42');
  });
});

describe('RouteStore', () => {
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

  test('dbPath resolves under the operator directory', () => {
    expect(store.dbPath.endsWith('channel-routes.sqlite')).toBe(true);
    expect(store.dbPath).toContain('.goodvibes');
  });

  test('upsert creates then updates a stable assignmentId', async () => {
    const first = await store.upsert({ channelId: 'slack:C1', profileId: 'work' });
    expect(first.created).toBe(true);
    expect(first.route.assignmentId).toBeTruthy();
    expect(first.route.surfaceKind).toBe('slack');
    expect(first.route.routeId).toBe('C1');
    expect(first.route.profileId).toBe('work');

    const second = await store.upsert({ channelId: 'slack:C1', profileId: 'personal', label: 'home' });
    expect(second.created).toBe(false);
    expect(second.route.assignmentId).toBe(first.route.assignmentId);
    expect(second.route.profileId).toBe('personal');
    expect(second.route.label).toBe('home');
  });

  test('upsert rejects an empty profileId', async () => {
    await expect(store.upsert({ channelId: 'slack', profileId: '   ' })).rejects.toThrow(HandlerError);
  });

  test('list filters by profileId and surfaceKind', async () => {
    await store.upsert({ channelId: 'slack:C1', profileId: 'work' });
    await store.upsert({ channelId: 'discord:G1', profileId: 'work' });
    await store.upsert({ channelId: 'slack:C2', profileId: 'play' });

    expect(store.list().length).toBe(3);
    expect(store.list({ profileId: 'work' }).length).toBe(2);
    expect(store.list({ surfaceKind: 'slack' }).length).toBe(2);
    expect(store.list({ profileId: 'work', surfaceKind: 'discord' }).length).toBe(1);
    expect(store.list({ profileId: 'nobody' }).length).toBe(0);
  });

  test('findByChannelId and findById locate the same row', async () => {
    const { route } = await store.upsert({ channelId: 'slack:C9', profileId: 'work' });
    expect(store.findByChannelId('slack:C9')?.assignmentId).toBe(route.assignmentId);
    expect(store.findById(route.assignmentId)?.channelId).toBe('slack:C9');
    expect(store.findByChannelId('slack:absent')).toBeNull();
    expect(store.findById('absent')).toBeNull();
  });

  test('delete removes a row and reports whether one existed', async () => {
    const { route } = await store.upsert({ channelId: 'slack', profileId: 'work' });
    expect(await store.delete(route.assignmentId)).toBe(true);
    expect(store.findById(route.assignmentId)).toBeNull();
    expect(await store.delete(route.assignmentId)).toBe(false);
  });

  test('delete rejects an empty assignmentId', async () => {
    await expect(store.delete('  ')).rejects.toThrow(HandlerError);
  });

  test('assignments survive a close + reopen (persisted to disk)', async () => {
    const { route } = await store.upsert({ channelId: 'slack:C1', profileId: 'work', label: 'team' });
    store.close();

    const reopened = new RouteStore({ workingDirectory: tmp.dir });
    await reopened.init();
    try {
      const found = reopened.findByChannelId('slack:C1');
      expect(found?.assignmentId).toBe(route.assignmentId);
      expect(found?.profileId).toBe('work');
      expect(found?.label).toBe('team');
    } finally {
      reopened.close();
    }
  });

  test('operations before init throw an uninitialized error', () => {
    const fresh = new RouteStore({ workingDirectory: tmp.dir });
    expect(() => fresh.listAll()).toThrow(HandlerError);
  });
});
