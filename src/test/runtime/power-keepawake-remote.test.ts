// ---------------------------------------------------------------------------
// power-keepawake-remote.test.ts — the keep-awake toggle is forwarded to an
// adopted EXTERNAL daemon over power.keepAwake.set, and is a strict no-op in
// the embedded topology (the in-process manager IS the daemon).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createUnavailablePowerSeam } from '@pellux/goodvibes-sdk/platform/power';
import { fetchDaemonPowerState, forwardKeepAwakeToDaemon, installKeepAwakeRemoteForward } from '../../runtime/power-keepawake-remote.ts';
import { wireIdlePowerAndLiveTurn } from '../../runtime/idle-power-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function spyConfig() {
  const getKeys: string[] = [];
  const subs: Array<[string, (v: unknown) => void]> = [];
  const configManager = {
    // Return daemon.enabled=false so resolveOperatorRpc honestly refuses (no real
    // network in a unit test); reaching .get proves we passed the topology gate.
    get: (key: string) => { getKeys.push(key); return key === 'daemon.enabled' ? false : undefined; },
    subscribe: (key: string, cb: (v: unknown) => void) => { subs.push([key, cb]); return () => {}; },
  } as never;
  return { configManager, getKeys, subs };
}

describe('keep-awake remote forward (3a)', () => {
  test('embedded topology: forward is a strict no-op — never reaches the operator client', async () => {
    const { configManager, getKeys } = spyConfig();
    await forwardKeepAwakeToDaemon(true, { configManager, homeDirectory: '/tmp/home', isExternalDaemon: () => false });
    // No config read at all: it returned before resolveOperatorRpc.
    expect(getKeys).toEqual([]);
  });

  test('external topology: forward reaches the operator resolver (gate passed), quiet when unreachable', async () => {
    const { configManager, getKeys } = spyConfig();
    // No throw even though the daemon is unreachable (best-effort).
    await forwardKeepAwakeToDaemon(true, { configManager, homeDirectory: '/tmp/home', isExternalDaemon: () => true });
    // It reached resolveOperatorRpc, which read daemon.enabled and honestly refused.
    expect(getKeys).toContain('daemon.enabled');
  });

  test('installKeepAwakeRemoteForward subscribes exactly the power.keepAwake key (one seam carries all three toggle origins)', () => {
    const { configManager, subs } = spyConfig();
    installKeepAwakeRemoteForward({ configManager, homeDirectory: '/tmp/home', isExternalDaemon: () => false });
    expect(subs).toHaveLength(1);
    expect(subs[0]![0]).toBe('power.keepAwake');
  });

  test('a config change fires the forward (embedded no-op, no throw)', async () => {
    const { configManager, subs, getKeys } = spyConfig();
    installKeepAwakeRemoteForward({ configManager, homeDirectory: '/tmp/home', isExternalDaemon: () => false });
    subs[0]![1](true); // simulate a power.keepAwake toggle landing on the config key
    await Promise.resolve();
    expect(getKeys).toEqual([]); // embedded ⇒ no forward attempted
  });
});

// ── The ruling's core property: keep-awake survives the TUI closing ─────────

describe('keep-awake survives the TUI closing — external topology', () => {
  test('the toggle rides power.keepAwake.set to the DAEMON (the daemon holds the inhibitor beyond this process)', async () => {
    const calls: Array<{ id: string; input: unknown }> = [];
    const resolveRpc = (() => ({
      available: true,
      sdk: { operator: { invoke: async (id: string, input: unknown) => { calls.push({ id, input }); return {}; } } },
    })) as never;
    const { configManager } = spyConfig();
    await forwardKeepAwakeToDaemon(true, { configManager, homeDirectory: '/tmp/home', isExternalDaemon: () => true, resolveRpc });
    expect(calls).toEqual([{ id: 'power.keepAwake.set', input: { enabled: true } }]);
  });

  test('the chip syncs from the DAEMON via power.status.get (a webui toggle is visible here)', async () => {
    const daemonState = { platform: 'linux', work: { held: false, reasons: [], grantedClasses: [] }, keepAwake: { enabled: true, held: true, note: null } };
    const resolveRpc = (() => ({
      available: true,
      sdk: { operator: { invoke: async () => daemonState } },
    })) as never;
    const { configManager } = spyConfig();
    const state = await fetchDaemonPowerState({ configManager, homeDirectory: '/tmp/home', isExternalDaemon: () => true, resolveRpc });
    expect(state?.keepAwake.enabled).toBe(true);
  });
});

describe('keep-awake survives the TUI closing — embedded topology', () => {
  test('the toggle persists to power.keepAwake and a fresh composition re-applies it at start', async () => {
    const dir = makeProjectTempDir('gv-power-embed-test');
    try {
      const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: dir });
      const stubDeps = {
        configManager,
        memoryRegistry: { getStore: () => null } as never,
        runtimeBus: undefined as never, // power wiring tolerates no bus (chip events just don't emit)
        isIdle: () => true,
        snapshotTick: () => {},
        heartbeat: async () => {},
        powerSeam: createUnavailablePowerSeam('test'),
      };
      const first = wireIdlePowerAndLiveTurn(stubDeps);
      await first.powerManager.setKeepAwake(true);
      first.memoryConsolidationScheduler.stop();
      // Persisted: the config key now carries the toggle...
      expect(configManager.get('power.keepAwake')).toBe(true);
      // ...and the NEXT composition (the next TUI/embedded-daemon start on this
      // config) re-applies it at start — the toggle outlives the process.
      const second = wireIdlePowerAndLiveTurn(stubDeps);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(second.powerManager.getState().keepAwake.enabled).toBe(true);
      second.memoryConsolidationScheduler.stop();
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
