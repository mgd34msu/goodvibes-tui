// ---------------------------------------------------------------------------
// power-chip-source.test.ts — the topology-aware chip source:
//   • embedded: the in-process manager is the truth; a local
//     OPS_POWER_STATE_CHANGED triggers an immediate repaint.
//   • external: the DAEMON's power.status.get is polled and served, so a
//     webui-originated toggle on the daemon lights the TUI chip within one
//     poll; while the daemon is unreachable the local projection is served.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { PowerState } from '@pellux/goodvibes-sdk/platform/power';
import { createPowerChipSource } from '../../core/power-chip-source.ts';
import type { PowerStateChangedPayload } from '../../core/power-status.ts';

function powerState(keepAwake: boolean): PowerState {
  return {
    platform: 'linux',
    work: { held: false, reasons: [], grantedClasses: [] },
    keepAwake: { enabled: keepAwake, held: keepAwake, note: null },
  } as unknown as PowerState;
}

interface Harness {
  emit: (p: PowerStateChangedPayload) => void;
  fire: () => Promise<void>;
  renders: () => number;
  setDaemon: (s: PowerState | null) => void;
  setExternal: (v: boolean) => void;
  source: ReturnType<typeof createPowerChipSource>;
}

function makeHarness(opts: { local: boolean; external: boolean; daemon: PowerState | null }): Harness {
  let renderCount = 0;
  let listener: ((p: PowerStateChangedPayload) => void) | null = null;
  let daemon = opts.daemon;
  let external = opts.external;
  const ticks: Array<() => void> = [];
  const source = createPowerChipSource({
    powerManager: { getState: () => powerState(opts.local) },
    onPowerEvent: (cb) => { listener = cb; return () => { listener = null; }; },
    isExternalDaemon: () => external,
    fetchDaemonPowerState: async () => daemon,
    render: () => { renderCount += 1; },
    timers: {
      setInterval: ((fn: () => void) => { ticks.push(fn); return 0 as never; }) as never,
      clearInterval: (() => {}) as never,
    },
  });
  return {
    emit: (p) => listener?.(p),
    fire: async () => { for (const t of ticks) t(); await Promise.resolve(); await Promise.resolve(); },
    renders: () => renderCount,
    setDaemon: (s) => { daemon = s; },
    setExternal: (v) => { external = v; },
    source,
  };
}

describe('power chip source — embedded topology', () => {
  test('serves the in-process manager state', () => {
    const h = makeHarness({ local: true, external: false, daemon: null });
    expect(h.source.get().keepAwake).toBe(true);
  });

  test('a local OPS_POWER_STATE_CHANGED triggers an immediate repaint', () => {
    const h = makeHarness({ local: false, external: false, daemon: null });
    const before = h.renders();
    h.emit({ inhibited: true, keepAwake: true, workReasons: [] });
    expect(h.renders()).toBe(before + 1);
  });
});

describe('power chip source — external/adopted topology', () => {
  test('a webui-originated daemon toggle lights the chip within one poll', async () => {
    const h = makeHarness({ local: false, external: true, daemon: powerState(false) });
    await h.fire(); // initial sync: daemon says off
    expect(h.source.get().keepAwake).toBe(false);
    h.setDaemon(powerState(true)); // webui toggles on the daemon
    await h.fire();
    expect(h.source.get().keepAwake).toBe(true); // the TUI chip lights
  });

  test('the DAEMON state wins over the local manager in external mode', async () => {
    // Local manager says on, daemon says off — the daemon is the truth.
    const h = makeHarness({ local: true, external: true, daemon: powerState(false) });
    await h.fire();
    expect(h.source.get().keepAwake).toBe(false);
  });

  test('an unreachable daemon degrades to the local projection (never a fabricated state)', async () => {
    const h = makeHarness({ local: true, external: true, daemon: null });
    await h.fire();
    expect(h.source.get().keepAwake).toBe(true); // local truth served
  });

  test('leaving external mode drops the cached daemon state', async () => {
    const h = makeHarness({ local: true, external: true, daemon: powerState(false) });
    await h.fire();
    expect(h.source.get().keepAwake).toBe(false);
    h.setExternal(false); // topology flips back to embedded
    await h.fire();
    expect(h.source.get().keepAwake).toBe(true); // local manager again
  });

  test('stop() unsubscribes the local event feed', () => {
    const h = makeHarness({ local: false, external: false, daemon: null });
    h.source.stop();
    const before = h.renders();
    h.emit({ inhibited: false, keepAwake: false, workReasons: [] });
    expect(h.renders()).toBe(before); // no repaint after stop
  });
});
