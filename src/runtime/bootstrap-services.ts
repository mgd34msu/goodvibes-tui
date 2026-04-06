import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { RuntimeEventBus } from './events/index.ts';
import { DaemonServer } from '../daemon/server.ts';
import { HttpListener } from '../daemon/http-listener.ts';

interface DaemonService {
  enable(config: { daemon: boolean }, token?: string): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface HttpListenerService {
  enable(config: { httpListener: boolean }, token?: string): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ServiceFactories {
  createDaemonServer?: (runtimeBus: RuntimeEventBus) => DaemonService;
  createHttpListener?: (hookDispatcher: HookDispatcher) => HttpListenerService;
}

export interface ExternalServicesHandle {
  readonly daemonServer: DaemonService | null;
  readonly httpListener: HttpListenerService | null;
  stop(): Promise<void>;
}

export interface ExternalServicesConfig {
  get(key: 'danger.daemon' | 'danger.httpListener'): boolean;
}

export async function startExternalServices(
  config: ExternalServicesConfig,
  runtimeBus: RuntimeEventBus,
  hookDispatcher: HookDispatcher,
  factories: ServiceFactories = {},
): Promise<ExternalServicesHandle> {
  const createDaemonServer = factories.createDaemonServer ?? ((bus: RuntimeEventBus): DaemonService => new DaemonServer({ runtimeBus: bus }));
  const createHttpListener = factories.createHttpListener ?? ((dispatcher: HookDispatcher): HttpListenerService => new HttpListener({ hookDispatcher: dispatcher }));

  let daemonServer: DaemonService | null = null;
  let httpListener: HttpListenerService | null = null;

  if (config.get('danger.daemon') as boolean) {
    daemonServer = createDaemonServer(runtimeBus);
    daemonServer.enable({ daemon: true });
    await daemonServer.start();
  }

  if (config.get('danger.httpListener') as boolean) {
    httpListener = createHttpListener(hookDispatcher);
    httpListener.enable({ httpListener: true });
    await httpListener.start();
  }

  return {
    daemonServer,
    httpListener,
    async stop(): Promise<void> {
      await Promise.allSettled([
        daemonServer?.stop(),
        httpListener?.stop(),
      ]);
    },
  };
}
