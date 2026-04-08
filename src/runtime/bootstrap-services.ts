import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { RuntimeEventBus } from './events/index.ts';
import { DaemonServer } from '../daemon/server.ts';
import { HttpListener } from '../daemon/http-listener.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import { logger } from '../utils/logger.ts';
import { getLocalUserAuthManager, setLocalUserAuthManager } from './local-auth.ts';

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
  createDaemonServer?: (runtimeBus: RuntimeEventBus, userAuth: UserAuthManager) => DaemonService;
  createHttpListener?: (hookDispatcher: HookDispatcher, userAuth: UserAuthManager) => HttpListenerService;
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
  const sharedUserAuth = getLocalUserAuthManager();
  setLocalUserAuthManager(sharedUserAuth);
  const createDaemonServer = factories.createDaemonServer ?? ((bus: RuntimeEventBus, userAuth: UserAuthManager): DaemonService =>
    new DaemonServer({ runtimeBus: bus, userAuth }));
  const createHttpListener = factories.createHttpListener ?? ((dispatcher: HookDispatcher, userAuth: UserAuthManager): HttpListenerService =>
    new HttpListener({ hookDispatcher: dispatcher, userAuth }));

  let daemonServer: DaemonService | null = null;
  let httpListener: HttpListenerService | null = null;

  if (config.get('danger.daemon') as boolean) {
    daemonServer = createDaemonServer(runtimeBus, sharedUserAuth);
    daemonServer.enable({ daemon: true });
    try {
      await daemonServer.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EADDRINUSE') || message.includes('Address already in use')) {
        logger.warn('Daemon server port already in use; continuing without local daemon in this TUI instance', { error: message });
        daemonServer = null;
      } else {
        throw error;
      }
    }
  }

  if (config.get('danger.httpListener') as boolean) {
    httpListener = createHttpListener(hookDispatcher, sharedUserAuth);
    httpListener.enable({ httpListener: true });
    try {
      await httpListener.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EADDRINUSE') || message.includes('Address already in use')) {
        logger.warn('HTTP listener port already in use; continuing without local listener in this TUI instance', { error: message });
        httpListener = null;
      } else {
        throw error;
      }
    }
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
