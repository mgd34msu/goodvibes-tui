/**
 * session-spine-startup-latency.test.ts
 *
 * Perf evidence: with daemon.enabled defaulting ON,
 * the adopt-or-start probe now genuinely runs on every boot — this used to be
 * inert (danger.daemon defaulted off, the whole path was skipped). This test
 * measures the REAL wall-clock cost of the case this conversion actually
 * activates for: a compatible external daemon present, adopted rather than
 * started. That probe runs entirely inside `bootstrap.ts`'s
 * `deferredStartup.schedule({label:'external-services', ...})` task, which
 * fires AFTER the first render (see bootstrap.ts) — so this number is NOT on
 * the first-paint critical path; it documents the measured background cost
 * and guards it does not regress silently.
 *
 * (The sibling "no daemon present -> starts its own embedded daemon" shape is
 * not exercised here: it binds the real controlPlane.port from the shared
 * test RuntimeServices' ConfigManager rather than the probe-decision config
 * passed to startHostServices, so a real system daemon on the default port
 * would collide with it on a dev machine. That shape is unaffected
 * either way — the session spine only activates in the adopt path.)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { bootDaemon } from '@pellux/goodvibes-sdk/platform/daemon';
import { RuntimeEventBus, startExternalServices } from '@/runtime/index.ts';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

/**
 * What the adopt probe is allowed to take, and what the test itself is allowed
 * to take.
 *
 * The old pair was broken as a pair: the assertion budget was 5 000 ms and
 * bun's implicit per-test default is also 5 000 ms, so the measurement could
 * never actually fail its own assertion — the test died of bun's timeout first
 * ("this test timed out after 5000ms", observed on every run of a loaded host),
 * with no measured number reported at all. And 5 000 ms was an idle machine's
 * figure for work that includes booting a real daemon and doing real socket
 * I/O; on a busy host the adopt path takes longer while behaving perfectly.
 *
 * The regression this guards is a probe that HANGS or silently falls back to
 * starting its own daemon — an order-of-magnitude change, not a few hundred
 * milliseconds. A ceiling well clear of scheduling noise still catches that,
 * and the measured number is logged on every run either way, so a genuine creep
 * is visible rather than hidden behind a pass/fail line the host decides. The
 * test budget sits above the assertion budget so the ASSERTION is what fails.
 */
const ADOPT_BUDGET_MS = 30_000;
const TEST_BUDGET_MS = 120_000;

/** Finds a free ephemeral TCP port (bootstrap-services.ts requires a concrete
 * 1-65535 port, not 0, for controlPlane.port/httpListener.port config values —
 * unlike bootDaemon's own `port: 0` OS-assignment convenience). */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function createConfig(overrides: { controlPlanePort: number; httpListenerPort: number }) {
  return {
    get(key: string): boolean | string | number {
      if (key === 'daemon.enabled') return true;
      if (key === 'danger.httpListener') return false;
      if (key === 'controlPlane.host') return '127.0.0.1';
      if (key === 'controlPlane.port') return overrides.controlPlanePort;
      if (key === 'httpListener.host') return '127.0.0.1';
      if (key === 'httpListener.port') return overrides.httpListenerPort;
      return undefined as unknown as boolean;
    },
  };
}

describe('perf: real adopt-or-start probe cost (post daemon.enabled-by-default)', () => {
  test('a compatible external daemon present -> adopt path completes well within the deferred-task budget', async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'spine-delta-adopt-home-'));
    const workingDir = mkdtempSync(join(tmpdir(), 'spine-delta-adopt-wd-'));
    const token = 'spine-delta-token';
    const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token });
    try {
      const runtimeBus = new RuntimeEventBus();
      const hookDispatcher = new HookDispatcher();
      const runtimeServices = getTestRuntimeServices();
      const httpListenerPort = await findFreePort();

      const start = performance.now();
      const handle = await startExternalServices(
        createConfig({ controlPlanePort: daemon.port, httpListenerPort }) as never,
        runtimeBus,
        hookDispatcher,
        runtimeServices,
        { sharedDaemonToken: token } as never,
      );
      const elapsedMs = performance.now() - start;
      // eslint-disable-next-line no-console
      console.log(`[perf] adopt-or-start (adopt external daemon path): ${elapsedMs.toFixed(2)}ms`);

      expect(handle.daemonStatus.mode).toBe('external');
      expect(elapsedMs).toBeLessThan(ADOPT_BUDGET_MS);
      await handle.stop();
    } finally {
      await daemon.stop();
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    }
  }, TEST_BUDGET_MS);
});
