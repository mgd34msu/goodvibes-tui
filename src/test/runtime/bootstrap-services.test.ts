import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import { startExternalServices } from '@/runtime/index.ts';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

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
        | 'danger.daemon'
        | 'danger.httpListener'
        | 'controlPlane.host'
        | 'controlPlane.port'
        | 'httpListener.host'
        | 'httpListener.port',
    ): boolean | string | number {
      if (key === 'danger.daemon') return overrides.daemon ?? false;
      if (key === 'danger.httpListener') return overrides.httpListener ?? false;
      if (key === 'controlPlane.host') return overrides.controlPlaneHost ?? '127.0.0.1';
      if (key === 'controlPlane.port') return overrides.controlPlanePort ?? 3421;
      if (key === 'httpListener.host') return overrides.httpListenerHost ?? '127.0.0.1';
      return overrides.httpListenerPort ?? 3422;
    },
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
    const daemonStart = mock(async () => {});
    const daemonStop = mock(async () => {});
    const daemonEnable = mock(() => true);
    const listenerStart = mock(async () => {});
    const listenerStop = mock(async () => {});
    const listenerEnable = mock(() => true);
    const daemonFactory = mock((_bus: RuntimeEventBus, _userAuth: object) => ({
      enable: daemonEnable,
      start: daemonStart,
      stop: daemonStop,
      listRecentControlPlaneEvents: mock(() => []),
    }));
    const listenerFactory = mock((_dispatcher: HookDispatcher, _userAuth: object) => ({
      enable: listenerEnable,
      start: listenerStart,
      stop: listenerStop,
    }));

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        createDaemonServer: daemonFactory,
        createHttpListener: listenerFactory,
        probeDaemonPortInUse: async () => false,
        probeHttpListenerPortInUse: async () => false,
      },
    );

    expect(daemonFactory).toHaveBeenCalledTimes(1);
    expect(listenerFactory).toHaveBeenCalledTimes(1);
    expect(daemonFactory.mock.calls[0]?.[1]).toBe(listenerFactory.mock.calls[0]?.[1]);
    // sharedDaemonToken / sharedHttpListenerToken default to undefined when
    // not provided in factories; enable(config, token?) is now called with
    // the token argument explicitly.
    expect(daemonEnable).toHaveBeenCalledWith({ daemon: true }, undefined);
    expect(daemonStart).toHaveBeenCalled();
    expect(listenerEnable).toHaveBeenCalledWith({ httpListener: true }, undefined);
    expect(listenerStart).toHaveBeenCalled();

    await services.stop();
    expect(daemonStop).toHaveBeenCalled();
    expect(listenerStop).toHaveBeenCalled();
  });

  test('does not start disabled services', async () => {
    const daemonFactory = mock(() => ({
      enable: mock(() => true),
      start: mock(async () => {}),
      stop: mock(async () => {}),
      listRecentControlPlaneEvents: mock(() => []),
    }));
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
        createDaemonServer: daemonFactory,
        createHttpListener: listenerFactory,
      },
    );

    expect(daemonFactory).not.toHaveBeenCalled();
    expect(listenerFactory).not.toHaveBeenCalled();
    expect(services.daemonServer).toBeNull();
    expect(services.httpListener).toBeNull();
  });

  test('continues boot when daemon port is already in use', async () => {
    const listenerStart = mock(async () => {});
    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        probeHttpListenerPortInUse: async () => false,
        createDaemonServer: () => ({
          enable: mock(() => true),
          start: mock(async () => {
            throw new Error('listen EADDRINUSE: Address already in use 127.0.0.1:3421');
          }),
          stop: mock(async () => {}),
          listRecentControlPlaneEvents: mock(() => []),
        }),
        createHttpListener: () => ({
          enable: mock(() => true),
          start: listenerStart,
          stop: mock(async () => {}),
        }),
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(services.httpListener).not.toBeNull();
    expect(listenerStart).toHaveBeenCalled();
  });

  test('continues boot when listener port is already in use', async () => {
    const daemonStart = mock(async () => {});
    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        probeHttpListenerPortInUse: async () => false,
        createDaemonServer: () => ({
          enable: mock(() => true),
          start: daemonStart,
          stop: mock(async () => {}),
          listRecentControlPlaneEvents: mock(() => []),
        }),
        createHttpListener: () => ({
          enable: mock(() => true),
          start: mock(async () => {
            throw new Error('listen EADDRINUSE: Address already in use 127.0.0.1:3422');
          }),
          stop: mock(async () => {}),
        }),
      },
    );

    expect(services.daemonServer).not.toBeNull();
    expect(services.httpListener).toBeNull();
    expect(daemonStart).toHaveBeenCalled();
  });

  test('skips daemon startup when another process already owns the default port', async () => {
    const daemonStart = mock(async () => {});
    const services = await startExternalServices(
      createConfig({ daemon: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => true,
        createDaemonServer: () => ({
          enable: mock(() => true),
          start: daemonStart,
          stop: mock(async () => {}),
          listRecentControlPlaneEvents: mock(() => []),
        }),
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(daemonStart).not.toHaveBeenCalled();
  });

  test('continues boot when daemon startup hangs', async () => {
    const daemonStart = mock(async () => {
      await new Promise(() => {});
    });
    const listenerStart = mock(async () => {});

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        startupTimeoutMs: 20,
        probeDaemonPortInUse: async () => false,
        probeHttpListenerPortInUse: async () => false,
        createDaemonServer: () => ({
          enable: mock(() => true),
          start: daemonStart,
          stop: mock(async () => {}),
          listRecentControlPlaneEvents: mock(() => []),
        }),
        createHttpListener: () => ({
          enable: mock(() => true),
          start: listenerStart,
          stop: mock(async () => {}),
        }),
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(services.httpListener).not.toBeNull();
    expect(listenerStart).toHaveBeenCalled();
  });

  test('uses configured hosts and ports when probing service bindings', async () => {
    const probeDaemonPortInUse = mock(async () => false);
    const probeHttpListenerPortInUse = mock(async () => false);

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
        probeDaemonPortInUse,
        probeHttpListenerPortInUse,
        createDaemonServer: () => ({
          enable: mock(() => true),
          start: mock(async () => {}),
          stop: mock(async () => {}),
          listRecentControlPlaneEvents: mock(() => []),
        }),
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
