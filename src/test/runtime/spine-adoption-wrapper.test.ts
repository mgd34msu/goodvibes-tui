/**
 * spine-adoption-wrapper.test.ts, this terminal's half of daemon adoption.
 *
 * ── What this covers, and what deliberately lives elsewhere ───────────────
 *
 * The adoption POLICY, idempotent per base URL, tear down before re-wiring,
 * fold the legacy store once, and the two activation timings, is the SDK's now
 * and is pinned there (test/client-seam-spine-adoption.test.ts in the SDK
 * repository). Re-asserting it here would pin the same behaviour twice and let
 * the two copies disagree about which is authoritative.
 *
 * What is only true HERE, and so is only checkable here, is the wrapper: that
 * this terminal gates on its boot discovery probe's verdict rather than wiring
 * the moment it is handed a base URL, that a `HostServiceStatus` is adapted
 * into the narrower signal the SDK takes, and that the wire it injects actually
 * carries all four members the SDK expects to find in the bundle. A bundle
 * missing one of those is a mirror that comes up and silently does not deliver
 *, the failure this module exists to prevent.
 *
 * Nothing here reaches the network: building the transports is construction
 * only, and the legacy-store path points nowhere so the fold is a no-op.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSpineAdoptionSync } from '../../runtime/client/spine-adoption.ts';
import type { HostServiceStatus } from '@/runtime/index.ts';

/** A store path nothing wrote, so the one-time fold is a no-op and touches no disk. */
const NOWHERE = join(tmpdir(), 'gv-spine-adoption-wrapper-test', 'sessions.json');

function harness() {
  const events: string[] = [];
  let bundle: Record<string, unknown> | null = null;

  const sync = createSpineAdoptionSync({
    sessionSpine: {
      activate: () => { events.push('session:activate'); },
      deactivate: () => { events.push('session:deactivate'); },
      foldLegacyRecords: () => ({ folded: 0 }) as never,
    } as never,
    memorySpine: {
      activate: () => { events.push('memory:activate'); },
      deactivate: () => { events.push('memory:deactivate'); },
    },
    sessionInboundInputs: {
      activate: (client: unknown) => { events.push('inbound:activate'); bundle = { ...(bundle ?? {}), inboundInputs: client }; },
      deactivate: () => { events.push('inbound:deactivate'); },
    },
    sessionUnionCache: {
      activate: (source: unknown) => { events.push('union:activate'); bundle = { ...(bundle ?? {}), sessionList: source }; },
      deactivate: () => { events.push('union:deactivate'); },
    },
    legacyStorePath: NOWHERE,
    workingDirectory: '/nonexistent/spine-adoption-wrapper-test',
    log: { info: () => { /* quiet */ }, debug: () => { /* quiet */ } },
  } as never);

  const status = (mode: string, baseUrl: string): HostServiceStatus =>
    ({ mode, baseUrl }) as unknown as HostServiceStatus;

  return { sync, events, status, readBundle: () => bundle };
}

describe('this terminal gates adoption on its discovery probe', () => {
  test('an adopted daemon wires the session mirror, the inbound path and the union', () => {
    const h = harness();
    h.sync(h.status('external', 'http://127.0.0.1:39471'), 'token-1');
    expect(h.events).toContain('session:activate');
    expect(h.events).toContain('inbound:activate');
    expect(h.events).toContain('union:activate');
  });

  test('the memory spine rides the SAME adoption signal', () => {
    const h = harness();
    h.sync(h.status('external', 'http://127.0.0.1:39471'), 'token-1');
    // Retired from this module: there is no separate syncMemorySpineToHostStatus
    // call any more. Supplying the transport in the bundle is what activates it,
    // so a memory spine that stayed local through an adoption would show up as
    // this assertion failing rather than as silently stale recall.
    expect(h.events).toContain('memory:activate');
  });

  test.each(['unavailable', 'disabled', 'blocked', 'incompatible'])(
    'a probe verdict of %s mirrors nowhere, even with a base URL in hand',
    (mode) => {
      const h = harness();
      // The distinction that makes 'adopt-on-status' the right timing for this
      // product: a base URL is known, but the probe has not said a daemon
      // answers on it, and this terminal can render "no daemon" honestly.
      h.sync(h.status(mode, 'http://127.0.0.1:39471'), 'token-1');
      expect(h.events).not.toContain('session:activate');
      expect(h.events).not.toContain('memory:activate');
    },
  );

  test('re-probing the same adopted daemon does not tear the mirror down and back up', () => {
    const h = harness();
    h.sync(h.status('external', 'http://127.0.0.1:39471'), 'token-1');
    const after = h.events.length;
    h.sync(h.status('external', 'http://127.0.0.1:39471'), 'token-1');
    // A re-probe after an autostart is the common case; re-wiring on it is what
    // makes sessions flicker out of the cross-surface list and steers arrive twice.
    expect(h.events).toHaveLength(after);
  });
});

describe('the wire this terminal injects carries every member the mirror needs', () => {
  test('the inbound client exposes list and deliver, and the union exposes list', () => {
    const h = harness();
    h.sync(h.status('external', 'http://127.0.0.1:39471'), 'token-1');
    const wired = h.readBundle() as { inboundInputs?: Record<string, unknown>; sessionList?: Record<string, unknown> } | null;
    expect(wired).toBeTruthy();
    // `deliver` is the only de-duplication on the inbound path: without it an
    // input is re-picked every tick and answered repeatedly.
    expect(typeof wired?.inboundInputs?.['listInputs']).toBe('function');
    expect(typeof wired?.inboundInputs?.['deliverInput']).toBe('function');
    expect(typeof wired?.sessionList?.['list']).toBe('function');
  });
});
