import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '../config/provider-model.ts';
import { RuntimeEventBus, GlobalNetworkTransportInstaller } from '@/runtime/index.ts';
import { bindFeatureSettingsBridge, createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { createRuntimeServices } from '../runtime/services.ts';
import { DaemonServer, HttpListener } from '@pellux/goodvibes-sdk/platform/daemon';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  getOrCreateCompanionToken,
  pruneStaleOperatorTokens,
  buildPairingHandoffLink,
  generateQrMatrix,
  renderQrToString,
} from '@pellux/goodvibes-sdk/platform/pairing';
import { ensurePublicBaseUrl } from '../core/pairing-origin.ts';
import { availablePairingOffers } from '../core/pairing-handoff.ts';
import { formatPairingOffers, PAIRING_HTTP_LAN_POSTURE } from '../core/pairing-offers.ts';
import { workspaceOperatorTokenCandidates } from '../runtime/operator-token-cleanup.ts';
import {
  scan,
  loadPersistedProviders,
  persistProviders,
} from '@pellux/goodvibes-sdk/platform/discovery';
import { createSafeHostServeFactory } from './safe-serve.ts';
import { isDaemonServiceSubcommand, resolveInstalledDaemonBinary, runDaemonServiceCli } from './service-commands.ts';
import { resolveDaemonUpdateArtifact } from './lifecycle.ts';
import { VERSION } from '../version.ts';

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
  if (cli.warnings.length > 0) {
    for (const warning of cli.warnings) {
      console.warn(`[goodvibes-daemon] warning: ${warning}`);
    }
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
  if (cliFlags.provider !== undefined || cliFlags.model !== undefined) {
    const currentModel = config.get('provider.model');
    const provider = cliFlags.provider ?? getProviderIdFromModel(currentModel);
    const model = cliFlags.model ?? getModelIdFromProviderModel(currentModel);
    const registryKey = formatProviderModel(provider, model);
    applyRuntimeConfigValue(config, 'provider.model', registryKey);
    logger.info('daemon: provider/model flags applied', { provider, model: registryKey });
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

  // Service lifecycle: `install-service` / `uninstall-service` / `service-status` manage
  // the systemd USER unit for the shared daemon. They run BEFORE the daemon boots —
  // no runtime/services are constructed — and exit with the honest result code.
  const serviceSubcommand = cli.positionals[0];
  if (isDaemonServiceSubcommand(serviceSubcommand)) {
    const host = String(process.env.GOODVIBES_DAEMON_HOST ?? config.get('controlPlane.host') ?? '127.0.0.1');
    const port = Number(config.get('controlPlane.port'));
    const binaryPath = resolveInstalledDaemonBinary({ moduleUrl: import.meta.url });
    const result = await runDaemonServiceCli({
      subcommand: serviceSubcommand,
      binaryPath,
      homeDir: homeDirectory,
      host,
      port,
      // migrate-service only: never auto-migrate — requires the same explicit
      // consent as any other non-interactive destructive confirmation.
      confirmMigration: cliFlags.yes,
    });
    for (const line of result.lines) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
    process.exit(result.exitCode);
  }

  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  // Gate states derive from the domain settings keys; the bridge keeps live
  // config changes flowing into the manager for the daemon's lifetime.
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(config) });
  bindFeatureSettingsBridge(config, featureFlags);
  const runtimeServices = createRuntimeServices({
    configManager: config,
    featureFlags,
    runtimeBus,
    runtimeStore,
    getConversationTitle: () => 'goodvibes daemon',
    workingDir,
    homeDirectory,
  });

  // Load persisted providers from disk so the provider registry is pre-populated
  // on standalone daemon startup (same machinery the TUI uses after /scan).
  const discoveryRoots = { homeDirectory, surfaceRoot: 'tui' };
  const persistedProviders = loadPersistedProviders(discoveryRoots);
  if (persistedProviders.length > 0) {
    runtimeServices.providerRegistry.registerDiscoveredProviders(persistedProviders);
    logger.info('daemon: loaded persisted providers', { count: persistedProviders.length });
  }

  // Run a background LAN scan (non-blocking). Discovered servers are registered
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
  const daemon = new DaemonServer({
    runtimeBus,
    userAuth,
    runtimeServices,
    serveFactory: createSafeHostServeFactory('Standalone daemon'),
    // Hand the facade this binary's real version + exec path so its self-update
    // lifecycle compares the HOST's version (not the sdk package's). Resolves to
    // undefined for a non-binary install, so a dev run stays host-managed and
    // never swaps the interpreter. See lifecycle.ts.
    updateArtifact: resolveDaemonUpdateArtifact({ version: VERSION }),
  });
  const listener = new HttpListener({
    hookDispatcher: runtimeServices.hookDispatcher,
    userAuth,
    configManager: config,
    serveFactory: createSafeHostServeFactory('Standalone HTTP listener'),
  });
  const { daemonToken, httpToken } = readDaemonCliTokens(process.env);

  // If no explicit daemon token is set, use the companion token so mobile apps can connect.
  const daemonHomeDir = join(homeDirectory, '.goodvibes', 'daemon');
  const companionTokenRecord = getOrCreateCompanionToken('tui', { daemonHomeDir });
  // Fix (TUI 0.19.20): remove stale pre-0.21.28 workspace-scoped operator
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

  // The DaemonServer facade owns the hourly self-update loop now (fed this
  // binary's version + exec path via updateArtifact above); it checks hourly,
  // swaps only at an idle moment, keeps the outgoing binary at `<path>.previous`,
  // and stops with the daemon. No separate host loop.

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
    daemon: resolveDaemonEnabled(config),
    httpListener: config.get('danger.httpListener'),
  });

  // Print a device-pairing QR to stdout. The QR encodes the canonical
  // `#pair=<token>` deep link the web app consumes — a camera scan opens it
  // already signed in. No raw JSON connection blob is printed. This is also the
  // one place web.publicBaseUrl is frozen from the stable-name resolution (never
  // clobbering a user-set value), so the printed origin survives a DHCP change.
  // The daemon's shared companion token rides as the pairing token; a device can
  // later migrate to its own per-device token from /settings → security → devices.
  const webOrigin = ensurePublicBaseUrl(config);
  const offers = availablePairingOffers({
    relayEnabled: config.get('relay.enabled') === true,
    stepUpAvailable: true,
  });
  const deepLink = buildPairingHandoffLink({ webOrigin: webOrigin.origin, token: companionTokenRecord.token, offers });
  const qrString = renderQrToString(generateQrMatrix(deepLink));
  const bannerLines = [
    `GoodVibes daemon ${VERSION} — scan to pair a device (opens the web app signed in):`,
    '',
    `  ${webOrigin.origin}`,
    '',
    ...(offers.length > 0 ? ['Offers (each declinable in the web app):', ...formatPairingOffers(offers), ''] : []),
    ...(webOrigin.httpOnLan ? [PAIRING_HTTP_LAN_POSTURE, ''] : []),
    qrString,
  ];
  // eslint-disable-next-line no-console
  console.log(bannerLines.join('\n'));
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: summarizeError(error),
  });
  process.exit(1);
});
