/**
 * Gate: the four "initiative" gateway verb families the /ci, /checkin,
 * /principals, and /channel profiles commands drive must be present AND
 * invokable on the runtime this package vendors.
 *
 * Fork-drift context: the SDK's registerGatewayVerbGroups (reached through the
 * terminal-shell's attachWsOnlyGatewayVerbHandlers wrapper) registers
 * principals.*, channels.profiles.*, and ci.* unconditionally, but the
 * check-in family (checkin.config.get/set, checkin.run, checkin.receipts.list)
 * ONLY when channelDeliveryRouter, providerRegistry, automationManager, and
 * sessionLister are ALL supplied — a graceful-degrade gate so the proactive
 * check-in loop is never a facade that pretends to deliver. The TUI's
 * composition root originally called the wrapper WITHOUT those four deps, so
 * checkin.* answered 501 "Gateway method is not invokable" on the TUI's own
 * daemon while the /checkin command shipped, i.e. dead commands.
 *
 * The ws-only conformance gate (gateway-ws-only-invokable.test.ts) could not
 * catch this: it scopes assertEveryDescriptorHasHandler to the ws-only ids, so
 * a check-in descriptor left handler-less is silently skipped. This test pins
 * the four families explicitly — descriptor present, handler attached, and a
 * read-only invoke round-trip returning the honest empty/disabled default — so
 * a future SDK verb-group addition (or a dep that silently drops out of this
 * composition) turns a test red instead of shipping a dead command.
 */
import { describe, expect, test } from 'bun:test';
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';
import { renderConfig } from '@/input/commands/checkin-runtime.ts';

// Every method id the four initiative families advertise. Presence + handler
// attachment is asserted for all of them; the read-only subset below is also
// invoked end-to-end.
const INITIATIVE_METHOD_IDS = [
  // proactive check-in (conditional group — the one that regressed)
  'checkin.config.get',
  'checkin.config.set',
  'checkin.receipts.list',
  'checkin.run',
  // CI-watch
  'ci.status',
  'ci.watches.create',
  'ci.watches.delete',
  'ci.watches.list',
  'ci.watches.run',
  // cross-channel principal identity
  'principals.create',
  'principals.delete',
  'principals.get',
  'principals.list',
  'principals.resolve',
  'principals.update',
  // per-channel profile bindings
  'channels.profiles.delete',
  'channels.profiles.get',
  'channels.profiles.list',
  'channels.profiles.set',
] as const;

describe('initiative gateway verb families are live on the vendored runtime', () => {
  const services = getTestRuntimeServices();

  // Descriptor presence per id: the conformance helper below sweeps handlers
  // over descriptors already registered, so an id absent from the catalog
  // entirely would be silently skipped. Pin each id explicitly.
  for (const methodId of INITIATIVE_METHOD_IDS) {
    test(`${methodId} descriptor is registered in the composed daemon catalog`, () => {
      expect(
        services.gatewayMethods.get(methodId),
        `${methodId} descriptor missing from the catalog — the verb family did not register`,
      ).toBeTruthy();
    });
  }

  // Handler-attachment drift gate: fails loudly (naming every offending id) if
  // any of these descriptors is present but handler-absent — the 501 class that
  // shipped checkin.* dead. Scoped to the initiative ids so builtin descriptors
  // whose handlers attach elsewhere do not trip it.
  test('every initiative descriptor has an attached handler (checkin.* is the one that regressed)', () => {
    expect(() =>
      assertEveryDescriptorHasHandler(services.gatewayMethods, { onlyIds: INITIATIVE_METHOD_IDS }),
    ).not.toThrow();
  });

  test('checkin.config.get invokes end-to-end and returns the honest disabled default', async () => {
    const result = (await services.gatewayMethods.invoke('checkin.config.get', {
      methodId: 'checkin.config.get',
      body: {},
    } as never)) as { config: { enabled: boolean } };
    expect(result.config).toBeTruthy();
    // Off by default — never a facade claiming the loop is running.
    expect(result.config.enabled).toBe(false);
  });

  test('checkin.receipts.list invokes end-to-end (empty trail on a fresh runtime)', async () => {
    const result = (await services.gatewayMethods.invoke('checkin.receipts.list', {
      methodId: 'checkin.receipts.list',
      body: {},
    } as never)) as { receipts: unknown[] };
    expect(Array.isArray(result.receipts)).toBe(true);
    expect(result.receipts).toHaveLength(0);
  });

  test('principals.list invokes end-to-end (empty registry on a fresh runtime)', async () => {
    const result = (await services.gatewayMethods.invoke('principals.list', {
      methodId: 'principals.list',
      body: {},
    } as never)) as { principals: unknown[] };
    expect(Array.isArray(result.principals)).toBe(true);
    expect(result.principals).toHaveLength(0);
  });

  test('ci.watches.list invokes end-to-end (no standing watches on a fresh runtime)', async () => {
    const result = (await services.gatewayMethods.invoke('ci.watches.list', {
      methodId: 'ci.watches.list',
      body: {},
    } as never)) as { watches: unknown[] };
    expect(Array.isArray(result.watches)).toBe(true);
    expect(result.watches).toHaveLength(0);
  });

  test('channels.profiles.list invokes end-to-end (no bindings on a fresh runtime)', async () => {
    const result = (await services.gatewayMethods.invoke('channels.profiles.list', {
      methodId: 'channels.profiles.list',
      body: {},
    } as never)) as { bindings: unknown[] };
    expect(Array.isArray(result.bindings)).toBe(true);
    expect(result.bindings).toHaveLength(0);
  });

  // The exact path the /checkin command drives: it invokes checkin.config.get
  // over the operator wire (the composed daemon's catalog is that wire's
  // in-process invocation surface) and feeds the result through renderConfig.
  // Before the deps were threaded this invoke answered 501 and the command
  // printed an error; now it renders real, honestly-disabled config.
  test('/checkin against the composed daemon renders real config, not a 501', async () => {
    const { config } = (await services.gatewayMethods.invoke('checkin.config.get', {
      methodId: 'checkin.config.get',
      body: {},
    } as never)) as { config: Parameters<typeof renderConfig>[0] };
    const rendered = renderConfig(config);
    expect(rendered).toContain('Check-in config:');
    expect(rendered).toContain('enabled:         no');
  });

  // The ci-watch recurring poll attaches to the composed daemon's watcher
  // registry when watchers are enabled (the default): red runs surface
  // fix-this offers without anyone running the manual verb. If this watcher
  // stops attaching, CI watches silently degrade to manual-only — this test
  // names that regression.
  test('the ci-watch recurring poller is registered on the composed watcher registry', () => {
    const watchers = services.watcherRegistry.list();
    expect(watchers.some((watcher) => watcher.id === 'ci-watch-poller')).toBe(true);
  });
});
