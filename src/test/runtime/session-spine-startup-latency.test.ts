/**
 * session-spine-startup-latency.test.ts
 *
 * S3c perf evidence: with daemon.enabled defaulting ON (One-Platform Wave 1),
 * the adopt-or-start probe now genuinely runs on every boot — this used to be
 * inert (danger.daemon defaulted off, the whole path was skipped). This test
 * measures the REAL wall-clock cost of the case S3c's conversion actually
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
 * would collide with it on a dev machine. That shape is unaffected by S3c
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
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

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
      if (key === 'danger.daemon') return undefined as unknown as boolean; // deprecated alias, unset -> defers to daemon.enabled
      if (key === 'danger.httpListener') return false;
      if (key === 'controlPlane.host') return '127.0.0.1';
      if (key === 'controlPlane.port') return overrides.controlPlanePort;
      if (key === 'httpListener.host') return '127.0.0.1';
      if (key === 'httpListener.port') return overrides.httpListenerPort;
      return undefined as unknown as boolean;
    },
  };
}

describe('S3c perf: real adopt-or-start probe cost (post daemon.enabled-by-default)', () => {
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
      console.log(`[S3c perf] adopt-or-start (adopt external daemon path): ${elapsedMs.toFixed(2)}ms`);

      expect(handle.daemonStatus.mode).toBe('external');
      // Generous budget: this runs off the deferred (post-first-paint) path,
      // not the interactive one, but should still complete quickly for a good UX.
      expect(elapsedMs).toBeLessThan(5_000);
      await handle.stop();
    } finally {
      await daemon.stop();
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
