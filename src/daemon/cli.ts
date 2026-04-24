import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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
  pruneStaleOperatorTokens,
  buildCompanionConnectionInfo,
  encodeConnectionPayload,
  formatConnectionBlock,
} from '@pellux/goodvibes-sdk/platform/pairing/index';
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing/qr-generator';
import { workspaceOperatorTokenCandidates } from '../runtime/operator-token-cleanup.ts';
import {
  scan,
  loadPersistedProviders,
  persistProviders,
} from '@pellux/goodvibes-sdk/platform/discovery/index';

import {
  parseGoodVibesCli,
  renderGoodVibesDaemonHelp,
  renderGoodVibesVersion,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
} from '../cli/index.ts';
type DaemonCliOwnership = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

// CLI flag parsing delegated to shared module — see src/cli-flags.ts

type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

function getLocalNetworkIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {
    return 'localhost';
  }
  return 'localhost';
}

function readBootstrapPassword(credentialPath: string): string | undefined {
  try {
    const content = readFileSync(credentialPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('password=')) {
        return line.slice('password='.length).trim();
      }
    }
  } catch {
    // credential file may not exist yet
  }
  return undefined;
}

function resolveDaemonCliOwnership(): DaemonCliOwnership {
  return {
    workingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
    homeDirectory: process.env['GOODVIBES_DAEMON_HOME'] ?? homedir(),
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
  // Parse CLI flags first so --daemon-home and --working-dir env vars are set
  // before resolveDaemonCliOwnership() reads them.
  const cli = parseGoodVibesCli(process.argv.slice(2), 'goodvibes-daemon');
  if (cli.errors.length > 0) {
    console.error(cli.errors.join('\n'));
    console.error('');
    console.error(renderGoodVibesDaemonHelp('goodvibes-daemon'));
    process.exit(2);
  }
  if (cli.flags.help || cli.command === 'help') {
    console.log(renderGoodVibesDaemonHelp('goodvibes-daemon'));
    process.exit(0);
  }
  if (cli.flags.version || cli.command === 'version') {
    console.log(renderGoodVibesVersion('goodvibes-daemon'));
    process.exit(0);
  }
  const cliFlags = cli.flags;
  if (cliFlags.daemonHome !== undefined) {
    process.env['GOODVIBES_DAEMON_HOME'] = cliFlags.daemonHome;
    logger.info('daemon: --daemon-home flag applied', { daemonHome: cliFlags.daemonHome });
  }
  if (cliFlags.workingDir !== undefined) {
    process.env['GOODVIBES_WORKING_DIR'] = cliFlags.workingDir;
    logger.info('daemon: --working-dir flag applied', { workingDir: cliFlags.workingDir });
  }

  const { workingDirectory: workingDir, homeDirectory } = resolveDaemonCliOwnership();
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
  new GlobalNetworkTransportInstaller().install(config);

  const overrideErrors = applyRuntimeConfigOverrides(config, cliFlags.configOverrides);
  if (overrideErrors.length > 0) {
    console.error(overrideErrors.join('\n'));
    process.exit(2);
  }
  applyRuntimeFeatureFlagOverrides(config, {
    enableFeatures: cliFlags.enableFeatures,
    disableFeatures: cliFlags.disableFeatures,
  });

  // Apply remaining CLI flags before the provider registry is constructed.
  // These are runtime-only overrides; they must not rewrite settings.json.
  if (cliFlags.provider !== undefined) {
    applyRuntimeConfigValue(config, 'provider.provider', cliFlags.provider);
    logger.info('daemon: --provider flag applied', { provider: cliFlags.provider });
  }
  if (cliFlags.model !== undefined) {
    applyRuntimeConfigValue(config, 'provider.model', cliFlags.model);
    logger.info('daemon: --model flag applied', { model: cliFlags.model });
  }
  const endpointOverrideErrors = applyRuntimeEndpointFlagOverrides(config, 'controlPlane', cliFlags);
  if (endpointOverrideErrors.length > 0) {
    console.error(endpointOverrideErrors.join('\n'));
    process.exit(2);
  }
  if (cliFlags.port !== undefined) logger.info('daemon: --port flag applied', { port: cliFlags.port });
  if (cliFlags.hostname !== undefined) {
    process.env['GOODVIBES_DAEMON_HOST'] = cliFlags.hostname;
    logger.info('daemon: --hostname flag applied', { hostname: cliFlags.hostname });
  }
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

  // F2: Load persisted providers from disk so the provider registry is pre-populated
  // on standalone daemon startup (same machinery the TUI uses after /scan).
  const discoveryRoots = { homeDirectory, surfaceRoot: 'tui' };
  const persistedProviders = loadPersistedProviders(discoveryRoots);
  if (persistedProviders.length > 0) {
    runtimeServices.providerRegistry.registerDiscoveredProviders(persistedProviders);
    logger.info('daemon: loaded persisted providers', { count: persistedProviders.length });
  }

  // F2: Run a background LAN scan (non-blocking). Discovered servers are registered
  // and persisted so subsequent daemon restarts benefit from the warm cache.
  void scan().then((result) => {
    if (result.servers.length > 0) {
      runtimeServices.providerRegistry.registerDiscoveredProviders(result.servers);
      persistProviders(discoveryRoots, result.servers);
      logger.info('daemon: LAN scan complete', { found: result.servers.length });
    } else {
      logger.info('daemon: LAN scan found no servers');
    }
  }).catch((err: unknown) => {
    logger.warn('daemon: LAN scan failed', { error: summarizeError(err) });
  });

  const userAuth = runtimeServices.localUserAuthManager;
  const daemon = new DaemonServer({ runtimeBus, userAuth, runtimeServices });
  const listener = new HttpListener({
    hookDispatcher: runtimeServices.hookDispatcher,
    userAuth,
    configManager: config,
  });
  const { daemonToken, httpToken } = readDaemonCliTokens(process.env);

  // If no explicit daemon token is set, use the companion token so mobile apps can connect.
  const daemonHomeDir = join(homeDirectory, '.goodvibes', 'daemon');
  const companionTokenRecord = getOrCreateCompanionToken('tui', { daemonHomeDir });
  // F3 resolution (TUI 0.19.20): remove stale pre-0.21.28 workspace-scoped operator
  // token files so only the canonical <daemonHomeDir>/operator-tokens.json survives.
  const prune = pruneStaleOperatorTokens({
    daemonHomeDir,
    candidatePaths: workspaceOperatorTokenCandidates(workingDir),
  });
  if (prune.prunedPaths.length > 0) {
    logger.info('daemon: pruned stale operator-token files', { count: prune.prunedPaths.length, paths: prune.prunedPaths });
  }
  if (prune.failedPaths.length > 0) {
    logger.warn('daemon: failed to prune stale operator-token files (permission/race)', { count: prune.failedPaths.length, paths: prune.failedPaths });
  }
  const effectiveDaemonToken = daemonToken ?? companionTokenRecord.token;
  const effectiveHttpToken = httpToken ?? effectiveDaemonToken;

  daemon.enable({ daemon: true }, effectiveDaemonToken);
  listener.enable({ httpListener: true }, effectiveHttpToken);

  await Promise.all([
    daemon.start(),
    config.get('danger.httpListener') ? listener.start() : Promise.resolve(),
  ]);

  const abortController = new AbortController();

  const shutdown = async (): Promise<void> => {
    abortController.abort();
    const SHUTDOWN_DEADLINE_MS = 15_000;
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), SHUTDOWN_DEADLINE_MS)
    );
    const stop = Promise.allSettled([listener.stop(), daemon.stop()]).then(() => 'done' as const);
    const result = await Promise.race([stop, timeout]);
    if (result === 'timeout') {
      logger.warn('shutdown deadline exceeded — forcing exit');
      process.exit(1);
    }
    process.exit(0);
  };

  let shutdownInFlight = false;
  const handleSignal = (): void => {
    if (shutdownInFlight) return;
    shutdownInFlight = true;
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  logger.info('goodvibes daemon host started', {
    daemon: config.get('danger.daemon'),
    httpListener: config.get('danger.httpListener'),
  });

  // Print companion connection info + QR code to stdout.
  // Use the config-driven control plane port, not a hardcoded default.
  const daemonPort = config.get('controlPlane.port');
  const configuredDaemonHost = String(process.env.GOODVIBES_DAEMON_HOST ?? getLocalNetworkIp());
  const daemonHost = configuredDaemonHost === '0.0.0.0' || configuredDaemonHost === '::'
    ? getLocalNetworkIp()
    : configuredDaemonHost;
  const daemonUrl = `http://${daemonHost}:${daemonPort}`;
  const bootstrapPassword = readBootstrapPassword(userAuth.getBootstrapCredentialPath());
  const connectionInfo = buildCompanionConnectionInfo({
    daemonUrl,
    token: companionTokenRecord.token,
    password: bootstrapPassword,
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
