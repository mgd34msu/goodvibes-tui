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
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';
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
  // Durable remembered-approval rules (SDK round adopting the pricing
  // resolver / approval-rule store): read/delete only by design — rules are
  // written by remembered approval decisions, never by a verb.
  'permissions.rules.list',
  'permissions.rules.delete',
] as const;

describe('ws-only gateway verbs are invokable on the vendored runtime', () => {
  const services = getTestRuntimeServices();

  // Descriptor presence is the part the conformance helper cannot cover: it
  // sweeps handlers over the descriptors already registered, so a WS-ONLY id
  // absent from the catalog entirely would be silently skipped. Keep an
  // explicit presence check per id.
  for (const methodId of WS_ONLY_METHOD_IDS) {
    test(`${methodId} descriptor is registered in the catalog`, () => {
      expect(services.gatewayMethods.get(methodId), `${methodId} descriptor missing from the catalog`).toBeTruthy();
    });
  }

  // Handler-attachment is the package-owned drift gate: assertEveryDescriptorHasHandler
  // fails loudly (naming every offending id) if any ws-only descriptor is
  // descriptor-present but handler-absent — the 501 regression class. Scoped to
  // the ws-only ids so builtin descriptors whose handlers a host daemon attaches
  // elsewhere do not trip it.
  test('every ws-only descriptor has an attached handler (package conformance gate)', () => {
    expect(() =>
      assertEveryDescriptorHasHandler(services.gatewayMethods, { onlyIds: WS_ONLY_METHOD_IDS }),
    ).not.toThrow();
  });

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

  test('permissions.rules.list invokes end-to-end (empty rule set on a fresh runtime)', async () => {
    const result = await services.gatewayMethods.invoke('permissions.rules.list', {
      methodId: 'permissions.rules.list',
      body: {},
    } as never) as { rules: unknown[] };
    expect(Array.isArray(result.rules)).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  test('permissions.rules.delete invokes end-to-end and answers honestly for an unknown rule', async () => {
    const result = await services.gatewayMethods.invoke('permissions.rules.delete', {
      methodId: 'permissions.rules.delete',
      body: { ruleId: 'no-such-rule' },
    } as never) as { deleted: boolean };
    expect(result.deleted).toBe(false);
  });
});
