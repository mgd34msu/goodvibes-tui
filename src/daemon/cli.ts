import { homedir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { createRuntimeServices } from '../runtime/services.ts';
import { DaemonServer } from '@pellux/goodvibes-sdk/platform/daemon/server';
import { HttpListener } from '@pellux/goodvibes-sdk/platform/daemon/http-listener';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { GlobalNetworkTransportInstaller } from '@pellux/goodvibes-sdk/platform/runtime/network/index';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import {
  getOrCreateCompanionToken,
  buildCompanionConnectionInfo,
  encodeConnectionPayload,
  formatConnectionBlock,
} from '@pellux/goodvibes-sdk/platform/pairing/index';
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing/qr-generator';

type DaemonCliOwnership = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

function resolveDaemonCliOwnership(): DaemonCliOwnership {
  return {
    workingDirectory: process.cwd(),
    homeDirectory: homedir(),
  };
}

function readDaemonCliTokens(env: NodeJS.ProcessEnv): DaemonCliTokens {
  const daemonToken = env.GOODVIBES_DAEMON_TOKEN;
  return {
    daemonToken,
    httpToken: env.GOODVIBES_HTTP_TOKEN ?? daemonToken,
  };
}

async function main(): Promise<void> {
  const { workingDirectory: workingDir, homeDirectory } = resolveDaemonCliOwnership();
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
  new GlobalNetworkTransportInstaller().install(config);
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const runtimeServices = createRuntimeServices({
    configManager: config,
    runtimeBus,
    runtimeStore,
    getConversationTitle: () => 'goodvibes daemon',
    workingDir,
    homeDirectory,
  });

  const userAuth = runtimeServices.localUserAuthManager;
  const daemon = new DaemonServer({ runtimeBus, userAuth, runtimeServices });
  const listener = new HttpListener({
    hookDispatcher: runtimeServices.hookDispatcher,
    userAuth,
    configManager: config,
  });
  const { daemonToken, httpToken } = readDaemonCliTokens(process.env);

  daemon.enable({ daemon: true }, daemonToken);
  listener.enable({ httpListener: true }, httpToken);

  await Promise.all([
    daemon.start(),
    config.get('danger.httpListener') ? listener.start() : Promise.resolve(),
  ]);

  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([listener.stop(), daemon.stop()]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('goodvibes daemon host started', {
    daemon: config.get('danger.daemon'),
    httpListener: config.get('danger.httpListener'),
  });

  // Print companion connection info + QR code to stdout.
  const daemonPort = Number(process.env.GOODVIBES_DAEMON_PORT ?? process.env.PORT ?? 3000);
  const daemonHost = String(process.env.GOODVIBES_DAEMON_HOST ?? 'localhost');
  const daemonUrl = `http://${daemonHost}:${daemonPort}`;
  const companionTokenRecord = getOrCreateCompanionToken('tui');
  const connectionInfo = buildCompanionConnectionInfo({
    daemonUrl,
    token: companionTokenRecord.token,
    surface: 'tui',
  });
  const payload = encodeConnectionPayload(connectionInfo);
  const qrMatrix = generateQrMatrix(payload);
  const qrString = renderQrToString(qrMatrix);
  // eslint-disable-next-line no-console
  console.log(formatConnectionBlock(connectionInfo, qrString));
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: summarizeError(error),
  });
  process.exit(1);
});
