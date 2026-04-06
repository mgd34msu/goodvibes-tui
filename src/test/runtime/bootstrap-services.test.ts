import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { HookDispatcher } from '../../hooks/dispatcher.ts';
import { startExternalServices } from '../../runtime/bootstrap-services.ts';

function createConfig(overrides: { daemon?: boolean; httpListener?: boolean } = {}) {
  return {
    get(key: 'danger.daemon' | 'danger.httpListener'): boolean {
      if (key === 'danger.daemon') return overrides.daemon ?? false;
      return overrides.httpListener ?? false;
    },
  };
}

describe('startExternalServices', () => {
  let runtimeBus: RuntimeEventBus;
  let hookDispatcher: HookDispatcher;

  beforeEach(() => {
    runtimeBus = new RuntimeEventBus();
    hookDispatcher = new HookDispatcher();
  });

  test('starts both daemon and HTTP listener when enabled', async () => {
    const daemonStart = mock(async () => {});
    const daemonStop = mock(async () => {});
    const daemonEnable = mock(() => true);
    const listenerStart = mock(async () => {});
    const listenerStop = mock(async () => {});
    const listenerEnable = mock(() => true);

    const services = await startExternalServices(
      createConfig({ daemon: true, httpListener: true }),
      runtimeBus,
      hookDispatcher,
      {
        createDaemonServer: () => ({
          enable: daemonEnable,
          start: daemonStart,
          stop: daemonStop,
        }),
        createHttpListener: () => ({
          enable: listenerEnable,
          start: listenerStart,
          stop: listenerStop,
        }),
      },
    );

    expect(daemonEnable).toHaveBeenCalledWith({ daemon: true });
    expect(daemonStart).toHaveBeenCalled();
    expect(listenerEnable).toHaveBeenCalledWith({ httpListener: true });
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
});
