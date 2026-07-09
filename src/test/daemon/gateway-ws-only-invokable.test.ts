/**
 * Gate: every ws-only gateway verb the daemon advertises must actually be
 * invokable on the runtime this package vendors.
 *
 * Regression context (found by the companion app against the 1.13.0 daemon):
 * the TUI's createRuntimeServices built a GatewayMethodCatalog whose builtin
 * DESCRIPTORS were present but never called registerGatewayVerbGroups, so
 * fleet.* (including plain fleet.snapshot), checkpoints.*, and
 * sessions.search all answered 501 "Gateway method is not invokable" over
 * both websocket and HTTP invoke — on every daemon build ever shipped. The
 * contract gates never caught it because they validate descriptors, not
 * handler attachment.
 */
import { describe, expect, test } from 'bun:test';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

const WS_ONLY_METHOD_IDS = [
  'fleet.snapshot',
  'fleet.list',
  'fleet.archive',
  'fleet.unarchive',
  'fleet.archiveFinished',
  'fleet.archived.list',
  'checkpoints.list',
  'checkpoints.create',
  'checkpoints.diff',
  'checkpoints.restore',
  'sessions.search',
  'push.vapid.get',
  'push.subscriptions.list',
] as const;

describe('ws-only gateway verbs are invokable on the vendored runtime', () => {
  const services = getTestRuntimeServices();

  for (const methodId of WS_ONLY_METHOD_IDS) {
    test(`${methodId} has an attached handler (descriptor alone is a 501)`, () => {
      expect(services.gatewayMethods.get(methodId), `${methodId} descriptor missing from the catalog`).toBeTruthy();
      expect(services.gatewayMethods.hasHandler(methodId), `${methodId} is registered but NOT invokable`).toBe(true);
    });
  }

  test('fleet.snapshot invokes end-to-end and answers with real nodes shape', async () => {
    const result = await services.gatewayMethods.invoke('fleet.snapshot', {
      methodId: 'fleet.snapshot',
      body: {},
    } as never) as { capturedAt: number; nodes: unknown[]; truncated: boolean; totalCount: number };
    expect(typeof result.capturedAt).toBe('number');
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(typeof result.truncated).toBe('boolean');
  });

  test('fleet.archived.list invokes end-to-end (empty archive on a fresh runtime)', async () => {
    const result = await services.gatewayMethods.invoke('fleet.archived.list', {
      methodId: 'fleet.archived.list',
      body: {},
    } as never) as { capturedAt: number; nodes: unknown[] };
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(result.nodes).toHaveLength(0);
  });
});
