import { ConfigManager } from '../config/manager.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import { RuntimeEventBus } from '../runtime/events/index.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { setIntegrationHelpersContext, clearIntegrationHelpersContext } from '../runtime/integration/helpers.ts';
import { DaemonServer } from './server.ts';
import { HttpListener } from './http-listener.ts';
import { getHookDispatcher } from '../hooks/index.ts';
import { logger } from '../utils/logger.ts';
import { installGlobalNetworkTransport } from '../runtime/network/index.ts';

async function main(): Promise<void> {
  const config = new ConfigManager();
  installGlobalNetworkTransport(config);
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  setIntegrationHelpersContext({
    runtimeBus,
    runtimeStore,
    configManager: config,
    getConversationTitle: () => 'goodvibes daemon',
  });

  const userAuth = new UserAuthManager();
  const daemon = new DaemonServer({ runtimeBus, userAuth });
  const listener = new HttpListener({ hookDispatcher: getHookDispatcher(), userAuth, configManager: config });
  const token = process.env.GOODVIBES_DAEMON_TOKEN;
  const httpToken = process.env.GOODVIBES_HTTP_TOKEN ?? token;

  daemon.enable({ daemon: true }, token);
  listener.enable({ httpListener: true }, httpToken);

  await Promise.all([
    daemon.start(),
    config.get('danger.httpListener') ? listener.start() : Promise.resolve(),
  ]);

  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([listener.stop(), daemon.stop()]);
    clearIntegrationHelpersContext();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('goodvibes daemon host started', {
    daemon: config.get('danger.daemon'),
    httpListener: config.get('danger.httpListener'),
  });
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  clearIntegrationHelpersContext();
  process.exit(1);
});
