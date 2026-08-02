import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import { startExternalServices } from '@/runtime/index.ts';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

function createConfig(overrides: {
  daemon?: boolean;
  httpListener?: boolean;
  controlPlaneHost?: string;
  controlPlanePort?: number;
  httpListenerHost?: string;
  httpListenerPort?: number;
} = {}) {
  return {
    get(
      key:
        | 'daemon.enabled'
        | 'danger.httpListener'
        | 'controlPlane.host'
        | 'controlPlane.port'
        | 'httpListener.host'
        | 'httpListener.port',
    ): boolean | string | number {
      if (key === 'daemon.enabled') return overrides.daemon ?? false;
      if (key === 'danger.httpListener') return overrides.httpListener ?? false;
      if (key === 'controlPlane.host') return overrides.controlPlaneHost ?? '127.0.0.1';
      if (key === 'controlPlane.port') return overrides.controlPlanePort ?? 3421;
      if (key === 'httpListener.host') return overrides.httpListenerHost ?? '127.0.0.1';
      return overrides.httpListenerPort ?? 3422;
    },
  };
}

/**
 * Seams that make the detached-daemon spawn+adopt path resolve immediately and
 * deterministically: no real subprocess, no real sleep. `daemonRuntimeDir` is a
 * swept per-test directory (see `makeProjectTempDir`'s doc comment) rather than a
 * raw `tmpdir()` call, per this repo's test-tmp architecture check.
 */
function fastDaemonAdoptSeams(overrides: { probeDaemonPortInUse?: () => Promise<boolean> } = {}) {
  return {
    probeDaemonPortInUse: overrides.probeDaemonPortInUse ?? (async () => false),
    spawnDetachedDaemon: mock(() => ({ pid: 1, unref() {} })),
    daemonRuntimeDir: makeProjectTempDir('bootstrap-daemon-rt'),
    sleep: async () => {},
    isDaemonVersionCompatible: () => true,
    probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '9.9.9' }),
  };
}

describe('startExternalServices', () => {
  let runtimeBus: RuntimeEventBus;
  let hookDispatcher: HookDispatcher;
  let runtimeServices: ReturnType<typeof getTestRuntimeServices>;

  beforeEach(() => {
    runtimeBus = new RuntimeEventBus();
    hookDispatcher = new HookDispatcher();
    runtimeServices = getTestRuntimeServices();
  });

  test('starts both daemon and HTTP listener when enabled', async () => {
    const listenerStart = mock(async () => {});
    const listenerStop = mock(async () => {});
    const listenerEnable = mock(() => true);
    const listenerFactory = mock((_dispatcher: HookDispatcher, _userAuth: object) => ({
      enable: listenerEnable,
      start: listenerStart,
      stop: listenerStop,
    }));
    const daemonSeams = fastDaemonAdoptSeams();

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        ...daemonSeams,
        createHttpListener: listenerFactory,
        probeHttpListenerPortInUse: async () => false,
      },
    );

    // Daemon side: detached spawn + successful identity-probe adoption. There is
    // no in-process daemon object any more — `daemonServer` is always null.
    expect(daemonSeams.spawnDetachedDaemon).toHaveBeenCalledTimes(1);
    expect(services.daemonServer).toBeNull();
    expect(services.daemonStatus.mode).toBe('external');

    // Listener side is unchanged: still an injected in-process factory.
    expect(listenerFactory).toHaveBeenCalledTimes(1);
    expect(listenerEnable).toHaveBeenCalledWith({ httpListener: true }, undefined);
    expect(listenerStart).toHaveBeenCalled();

    await services.stop();
    expect(listenerStop).toHaveBeenCalled();
  });

  test('does not start disabled services', async () => {
    const spawnDetachedDaemon = mock(() => ({ pid: 1, unref() {} }));
    const listenerFactory = mock(() => ({
      enable: mock(() => true),
      start: mock(async () => {}),
      stop: mock(async () => {}),
    }));

    const services = await startExternalServices(
      createConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        spawnDetachedDaemon,
        createHttpListener: listenerFactory,
      },
    );

    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    expect(listenerFactory).not.toHaveBeenCalled();
    expect(services.daemonServer).toBeNull();
    expect(services.httpListener).toBeNull();
  });

  test('continues boot when daemon port is already in use', async () => {
    const listenerStart = mock(async () => {});
    const spawnDetachedDaemon = mock(() => ({ pid: 1, unref() {} }));

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => true,
        probeHttpListenerPortInUse: async () => false,
        // The occupant on the configured port cannot be verified as a
        // compatible GoodVibes daemon, so it is never spawned into and never
        // adopted — but the HTTP listener still starts.
        probeDaemonIdentity: async () => ({
          kind: 'unknown' as const,
          reason: 'listen EADDRINUSE: Address already in use 127.0.0.1:3421',
        }),
        spawnDetachedDaemon,
        createHttpListener: () => ({
          enable: mock(() => true),
          start: listenerStart,
          stop: mock(async () => {}),
        }),
      },
    );

    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    expect(services.daemonServer).toBeNull();
    expect(services.httpListener).not.toBeNull();
    expect(listenerStart).toHaveBeenCalled();
  });

  test('continues boot when listener port is already in use', async () => {
    const daemonSeams = fastDaemonAdoptSeams();

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        ...daemonSeams,
        probeHttpListenerPortInUse: async () => false,
        createHttpListener: () => ({
          enable: mock(() => true),
          start: mock(async () => {
            throw new Error('listen EADDRINUSE: Address already in use 127.0.0.1:3422');
          }),
          stop: mock(async () => {}),
        }),
      },
    );

    // Daemon side adopted successfully; the listener's own failure did not
    // reject the whole boot call.
    expect(daemonSeams.spawnDetachedDaemon).toHaveBeenCalledTimes(1);
    expect(services.daemonServer).toBeNull();
    expect(services.daemonStatus.mode).toBe('external');
    expect(services.httpListener).toBeNull();
  });

  test('skips daemon startup when another process already owns the default port', async () => {
    const spawnDetachedDaemon = mock(() => ({ pid: 1, unref() {} }));

    const services = await startExternalServices(
      createConfig({ daemon: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async () => ({
          kind: 'unknown' as const,
          reason: 'port occupied by an unverified process',
        }),
        spawnDetachedDaemon,
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
  });

  test('continues boot when daemon startup hangs', async () => {
    const listenerStart = mock(async () => {});
    const spawnDetachedDaemon = mock(() => ({ pid: 1, unref() {} }));

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        probeHttpListenerPortInUse: async () => false,
        spawnDetachedDaemon,
        daemonRuntimeDir: makeProjectTempDir('bootstrap-daemon-rt'),
        sleep: async () => {},
        // The detached daemon never becomes reachable within the (zeroed)
        // probe budget — the analogue of the old "start() never resolves"
        // hang, expressed through the probe-poll seam instead.
        detachedSpawnProbeTimeoutMs: 0,
        detachedSpawnProbeIntervalMs: 1,
        probeDaemonIdentity: async () => ({ kind: 'unknown' as const, reason: 'daemon never came up' }),
        createHttpListener: () => ({
          enable: mock(() => true),
          start: listenerStart,
          stop: mock(async () => {}),
        }),
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(services.daemonStatus.mode).toBe('unavailable');
    expect(services.httpListener).not.toBeNull();
    expect(listenerStart).toHaveBeenCalled();
  });

  test('uses configured hosts and ports when probing service bindings', async () => {
    const probeDaemonPortInUse = mock(async () => false);
    const probeHttpListenerPortInUse = mock(async () => false);
    const daemonSeams = fastDaemonAdoptSeams({ probeDaemonPortInUse: async () => false });

    await startExternalServices(
      createConfig({
        daemon: true,
        httpListener: true,
        controlPlaneHost: '0.0.0.0',
        controlPlanePort: 4444,
        httpListenerHost: '0.0.0.0',
        httpListenerPort: 5555,
      }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        ...daemonSeams,
        probeDaemonPortInUse,
        probeHttpListenerPortInUse,
        createHttpListener: () => ({
          enable: mock(() => true),
          start: mock(async () => {}),
          stop: mock(async () => {}),
        }),
      },
    );

    expect(probeDaemonPortInUse).toHaveBeenCalledTimes(1);
    expect(probeHttpListenerPortInUse).toHaveBeenCalledTimes(1);
    expect(probeDaemonPortInUse).toHaveBeenCalledWith('0.0.0.0', 4444);
    expect(probeHttpListenerPortInUse).toHaveBeenCalledWith('0.0.0.0', 5555);
  });
});
