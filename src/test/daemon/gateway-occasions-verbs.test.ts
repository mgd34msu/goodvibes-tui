/**
 * Gate: all sixteen `occasions.*` gateway verbs must be present AND invokable
 * on the runtime this package vendors, not merely described.
 *
 * Fork-drift context (same class as gateway-ws-only-invokable.test.ts and
 * gateway-initiative-verbs.test.ts): the SDK installs occasions.* by calling
 * installOccasions from inside composeOwnerProfile
 * (routes/owner-profile-composition.ts), which the TUI reaches through
 * registerGatewayVerbGroups via the terminal-shell's
 * attachWsOnlyGatewayVerbHandlers wrapper. A fork that never mirrors a new
 * wiring step added to the SDK's composition root ships descriptors with no
 * attached handler, and the ws-only conformance gate does not catch it: it
 * scopes assertEveryDescriptorHasHandler to the ws-only ids, so an occasions
 * descriptor left handler-less would be silently skipped.
 *
 * Unlike the proactive check-in family (which needs channelDeliveryRouter,
 * providerRegistry, automationManager AND sessionLister all threaded before it
 * registers), occasions rides entirely on deps every embed already supplies to
 * registerGatewayVerbGroups: owner-profile-composition.ts passes the WHOLE
 * GatewayVerbGroupDeps object through as OccasionsInstallDeps, and that
 * interface needs only configManager and shellPaths (both required already)
 * plus optional channelDeliveryRouter/disposal. So installOccasions runs
 * unconditionally whenever composeOwnerProfile runs, which happens whenever
 * configManager.attachProfileFallback is defined — always true for the real
 * ConfigManager this package vendors. No new required dep needed threading
 * here (contrast: fleet-needs-input-push.ts, which DOES need runtimeBus
 * threaded explicitly).
 *
 * The sweep ticker (occasions/ticker.ts, armed inside composeOccasions) is
 * armed unconditionally too — there is no separate gate on it — so proving
 * occasions.list/.state are descriptor-present and handler-attached on this
 * runtime is proof the same composeOccasions() call that arms the ticker
 * actually ran.
 */
import { describe, expect, test } from 'bun:test';
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

// All sixteen occasions.* verbs the control-plane surface documents
// (docs/occasions.md §7). Presence + handler attachment is asserted for all
// of them; the read-only, no-required-param subset is also invoked
// end-to-end.
const OCCASIONS_METHOD_IDS = [
  'occasions.list',
  'occasions.propose',
  'occasions.confirm',
  'occasions.remove',
  'occasions.answer',
  'occasions.interview.get',
  'occasions.interview.answer',
  'occasions.interview.record',
  'occasions.gifts',
  'occasions.pending',
  'occasions.sweep',
  'occasions.conflict.resolve',
  'occasions.plans.list',
  'occasions.plans.propose',
  'occasions.plans.confirm',
  'occasions.state',
] as const;

describe('occasions gateway verb family is live on the vendored runtime', () => {
  const services = getTestRuntimeServices();

  // Descriptor presence per id: the conformance helper below sweeps handlers
  // over descriptors already registered, so an id absent from the catalog
  // entirely would be silently skipped. Pin each id explicitly.
  for (const methodId of OCCASIONS_METHOD_IDS) {
    test(`${methodId} descriptor is registered in the composed daemon catalog`, () => {
      expect(
        services.gatewayMethods.get(methodId),
        `${methodId} descriptor missing from the catalog — the verb family did not register`,
      ).toBeTruthy();
    });
  }

  // Handler-attachment drift gate: fails loudly (naming every offending id) if
  // any of these descriptors is present but handler-absent — the 501 class
  // documented above. Scoped to the occasions ids so builtin descriptors
  // whose handlers attach elsewhere do not trip it.
  test('every occasions descriptor has an attached handler', () => {
    expect(() =>
      assertEveryDescriptorHasHandler(services.gatewayMethods, { onlyIds: OCCASIONS_METHOD_IDS }),
    ).not.toThrow();
  });

  test('occasions.list invokes end-to-end (no declared occasions on a fresh profile)', async () => {
    const result = (await services.gatewayMethods.invoke('occasions.list', {
      methodId: 'occasions.list',
      body: {},
    } as never)) as { occasions: unknown[]; unparsed: unknown[]; conflicts: unknown[]; timezone: string };
    expect(Array.isArray(result.occasions)).toBe(true);
    expect(result.occasions).toHaveLength(0);
    expect(typeof result.timezone).toBe('string');
  });

  test('occasions.plans.list invokes end-to-end (no declared plans on a fresh profile)', async () => {
    const result = (await services.gatewayMethods.invoke('occasions.plans.list', {
      methodId: 'occasions.plans.list',
      body: {},
    } as never)) as { plans: unknown[]; awayNow: unknown };
    expect(Array.isArray(result.plans)).toBe(true);
    expect(result.plans).toHaveLength(0);
    expect(result.awayNow).toBeNull();
  });

  test('occasions.pending invokes end-to-end (nothing outstanding on a fresh runtime)', async () => {
    const result = (await services.gatewayMethods.invoke('occasions.pending', {
      methodId: 'occasions.pending',
      body: {},
    } as never)) as { nudge: unknown; conflicts: unknown[]; interviews: unknown[] };
    expect(result.nudge).toBeNull();
    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  test('occasions.state invokes end-to-end (empty machine-owned store on a fresh runtime)', async () => {
    const result = (await services.gatewayMethods.invoke('occasions.state', {
      methodId: 'occasions.state',
      body: {},
    } as never)) as Record<string, unknown>;
    expect(result).toBeTruthy();
  });

  // Proof the sweep composition ran, not merely that the verb answers: this is
  // the same `service.sweep()` the armed ticker calls on its own schedule
  // (occasions/ticker.ts), invoked here on demand rather than waited for.
  test('occasions.sweep runs one pass end-to-end on a fresh runtime', async () => {
    const result = (await services.gatewayMethods.invoke('occasions.sweep', {
      methodId: 'occasions.sweep',
      body: {},
    } as never)) as { ranAt: number; hold: string; nudge: unknown; delivered: boolean };
    expect(typeof result.ranAt).toBe('number');
    expect(result.nudge).toBeNull();
    expect(result.delivered).toBe(false);
  });
});
