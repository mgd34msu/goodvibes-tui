import { homedir } from 'node:os';
import {
  ConfigManager,
  deriveControlPlaneBaseUrl,
  readControlPlaneBinding,
  resolveDaemonEnabled,
} from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '../config/provider-model.ts';
import { resolveGoodVibesHomeOwnership, hasOverriddenGoodVibesHome } from '../config/goodvibes-home.ts';
import { RuntimeEventBus, GlobalNetworkTransportInstaller } from '@/runtime/index.ts';
import { bindFeatureSettingsBridge, createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { createRuntimeServices } from '../runtime/services.ts';
import { DaemonServer, HttpListener } from '@pellux/goodvibes-sdk/platform/daemon';
import { createHostPowerSeam } from '@pellux/goodvibes-sdk/platform/power';
import { flushActivityLogSync, logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  getOrCreateCompanionToken,
  pruneStaleOperatorTokens,
  buildPairingHandoffLink,
  describeOriginPosture,
  generateQrMatrix,
  renderQrToString,
} from '@pellux/goodvibes-sdk/platform/pairing';
import { ensurePublicBaseUrl } from '../core/pairing-origin.ts';
import { availablePairingOffers } from '../core/pairing-handoff.ts';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice } from '../core/pairing-offers.ts';
import { workspaceOperatorTokenCandidates } from '../runtime/operator-token-cleanup.ts';
import {
  scan,
  loadPersistedProviders,
  persistProviders,
} from '@pellux/goodvibes-sdk/platform/discovery';
import { createSafeHostServeFactory } from './safe-serve.ts';
import { runSendCommand } from './send/command.ts';
import { createSendStack } from './send/composition.ts';
import { readAllStdin } from './send/stdin.ts';
import { isDaemonServiceSubcommand, resolveInstalledDaemonBinary, runDaemonServiceCli } from './service-commands.ts';
import { runClusterCommand } from '../cluster/commands.ts';
import { resolveConfiguredServiceName } from '../runtime/legacy-daemon-migration.ts';
import { runDaemonConfigMigration } from '../config/run-daemon-config-migration.ts';
import { reconcileRedundantLegacyUnit } from '../runtime/legacy-daemon-reconcile.ts';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { resolveDaemonUpdateArtifact } from './lifecycle.ts';
import { VERSION } from '../version.ts';

import {
  parseGoodVibesCli,
  renderGoodVibesDaemonHelp,
  renderGoodVibesVersion,
  renderDaemonStartupBanner,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
} from '../cli/index.ts';
type DaemonCliOwnership = {
  readonly workingDirectory: string;
  /** The GoodVibes tree root — settings, workspace, and discovery all hang off this. */
  readonly homeDirectory: string;
  /** The daemon's OWN identity home (auth users, operator tokens, daemon settings). */
  readonly daemonHomeDirectory: string;
};

// CLI flag parsing delegated to shared module — see src/cli-flags.ts

type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

/**
 * Two different directories that used to be one.
 *
 * `GOODVIBES_DAEMON_HOME` names the DAEMON's home — the identity directory
 * holding auth-users.json, operator-tokens.json, and daemon-settings.json. That
 * is what the name says and what the SDK's `resolveDaemonHomeDir()` has always
 * meant by it. This function used to read it as the GoodVibes tree ROOT, so
 * setting it relocated settings, workspace, and every discovery root as well —
 * far more than the daemon's own state.
 *
 * `GOODVIBES_HOME` is the variable for relocating the tree root. It is what a
 * test harness or a service unit should set when it wants an isolated tree; the
 * daemon home then falls under it unless separately overridden.
 */
function resolveDaemonCliOwnership(): DaemonCliOwnership {
  // Both roots come from src/config/goodvibes-home.ts, which the CLIENT entry
  // point also uses. They were resolved independently, and the client's copy
  // simply did not read GOODVIBES_HOME — so a redirected client wrote into the
  // real tree while the daemon honoured the redirect.
  const { homeDirectory, daemonHomeDirectory } = resolveGoodVibesHomeOwnership();
  return {
    workingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
    homeDirectory,
    daemonHomeDirectory,
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
  // `cluster …` is intercepted before the daemon's own flag parser runs, and
  // before any runtime is composed.
  //
  // Before the parser, because the subcommand has its own flag vocabulary
  // (--group, --key, --host, --port, --token) that the daemon parser would
  // reject as unknown. Before the runtime, because this command talks to a
  // daemon that is ALREADY RUNNING — composing a second runtime here would
  // build a competing set of state on a machine that already has one.
  //
  // See remote-daemon-target.ts for the --host/--port/--token convention that
  // every later remote-capable subcommand should follow.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'cluster') {
    const ownership = resolveDaemonCliOwnership();
    const clusterConfig = new ConfigManager({
      workingDir: ownership.workingDirectory,
      homeDir: ownership.homeDirectory,
      surfaceRoot: 'tui',
    });
    const result = await runClusterCommand({
      argv: rawArgs.slice(1),
      configManager: clusterConfig,
      daemonHomeDir: ownership.daemonHomeDirectory,
    });
    if (result.rawOutput) process.stdout.write(`\u001b${result.rawOutput}`);
    for (const line of result.lines) {
      // eslint-disable-next-line no-console
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    process.exit(result.exitCode);
  }

  // `send …` is intercepted here for both of the reasons `cluster` is, plus one
  // of its own.
  //
  // Before the parser, because the message is arbitrary operator text: a
  // message beginning with a dash, or one carrying `--port` inside it, must
  // reach the channel rather than be eaten as a daemon flag.
  //
  // Before the runtime, because this composes only the services a delivery
  // needs (see send/composition.ts) and must not start a second copy of the
  // pollers, cluster election and LAN scan a running daemon already owns.
  //
  // And it must work when NO daemon is running, which is much of the point: the
  // reason to message the owner is usually that something stopped.
  if (rawArgs[0] === 'send') {
    const ownership = resolveDaemonCliOwnership();
    runDaemonConfigMigration(ownership.homeDirectory);
    const stack = createSendStack({
      workingDirectory: ownership.workingDirectory,
      homeDirectory: ownership.homeDirectory,
      daemonHomeDirectory: ownership.daemonHomeDirectory,
    });
    const result = await runSendCommand(rawArgs.slice(1), {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: readAllStdin,
      stdinIsTty: process.stdin.isTTY === true,
    });
    for (const line of result.lines) {
      // eslint-disable-next-line no-console
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    // The activity log holds the OUTBOUND_HTTP record for the send that just
    // happened (or did not); a process exiting this promptly would drop it.
    flushActivityLogSync();
    process.exit(result.exitCode);
  }

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

  const { workingDirectory: workingDir, homeDirectory, daemonHomeDirectory } = resolveDaemonCliOwnership();
  runDaemonConfigMigration(homeDirectory);
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
    // The host/port baked into the unit's ExecStart (and displayed) come from
    // the SAME hostMode-aware resolution the SDK bind path uses — never from
    // the GOODVIBES_DAEMON_HOST env var, which nothing in the bind path reads
    // (the --hostname flag already lands in config via
    // applyRuntimeEndpointFlagOverrides above, so it is covered here).
    const binding = resolveRuntimeEndpointBinding(config, 'controlPlane');
    if (!binding.recognized) {
      // The SDK bind path has no default case for an unrecognized hostMode —
      // a daemon launched with this config throws before binding. Say so
      // instead of presenting the fallback values as a real binding.
      console.warn(
        `[goodvibes-daemon] warning: controlPlane.hostMode '${binding.hostMode}' is not a recognized mode ` +
          "(local|network|custom) — the daemon will fail to start until it is corrected.",
      );
    }
    const binaryPath = resolveInstalledDaemonBinary({ moduleUrl: import.meta.url });
    const result = await runDaemonServiceCli({
      subcommand: serviceSubcommand,
      binaryPath,
      homeDir: homeDirectory,
      host: binding.host,
      port: binding.port,
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

  // Honest startup identity, printed for EVERY launch shape — including a bare
  // (no-arg) systemd launch, and BEFORE any runtime construction so it still
  // reaches the journal when a broken config makes the daemon throw during
  // composition. It states the resolved version (never a placeholder) and the
  // home/host/port the daemon will actually bind: the binding comes from the
  // SAME hostMode-aware resolution the SDK bind path uses (resolveHostBinding:
  // 'local' forces 127.0.0.1, 'network' forces 0.0.0.0, port 0/non-numeric
  // falls back to the default) — never from controlPlane.host alone, and never
  // from the GOODVIBES_DAEMON_HOST env var, which the bind path does not read.
  const bannerBinding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  // eslint-disable-next-line no-console
  console.log(renderDaemonStartupBanner(VERSION, { homeDir: homeDirectory, host: bannerBinding.host, port: bannerBinding.port }));
  if (!bannerBinding.recognized) {
    // An unrecognized hostMode has NO binding the SDK can produce (its
    // resolver has no default case and the daemon will throw below, before
    // serving). Warn here so the journaled crash is explained.
    console.warn(
      `[goodvibes-daemon] warning: controlPlane.hostMode '${bannerBinding.hostMode}' is not a recognized mode ` +
        "(local|network|custom) — the daemon cannot bind until it is corrected; the host/port above are fallback values, not a real binding.",
    );
  }

  // Boot-time reconciliation. The banner above states the real bind; this
  // compares it to the URL clients are actually handed. Those are produced by
  // two different resolvers, and when they disagree the daemon is advertising an
  // address it does not answer on — the state that produced two different click
  // hosts from one daemon. Only reported when it is genuinely wrong: a wildcard
  // bind against a loopback dial target is a deliberate substitution, and a
  // declared controlPlane.publicBaseUrl is supposed to differ from the bind.
  // The derivation itself is the SDK's (deriveControlPlaneBaseUrl); only the
  // comparison is local. The SDK also carries describeDerivedBindMismatch,
  // which does exactly this — swap to it once a release ships it, since the
  // published 1.14.0 this build consumes predates it.
  if (bannerBinding.recognized) {
    const derived = new URL(
      deriveControlPlaneBaseUrl(readControlPlaneBinding((key) => config.get(key as ConfigKey)), 'loopback'),
    );
    // A wildcard bind is REPORTED as 0.0.0.0 while the dial target is loopback;
    // that substitution is deliberate, not drift.
    const wildcardBind = bannerBinding.host === '0.0.0.0' || bannerBinding.host === '::';
    const hostAgrees = derived.hostname === bannerBinding.host
      || (wildcardBind && derived.hostname === '127.0.0.1');
    if (!hostAgrees || Number(derived.port) !== bannerBinding.port) {
      console.warn(
        `[goodvibes-daemon] warning: control-plane clients are handed ${derived.origin}, but the daemon `
        + `actually bound ${bannerBinding.host}:${bannerBinding.port}. One of these is wrong, and anything `
        + 'given the first will dial a place this daemon does not answer.',
      );
      logger.warn('daemon: control-plane base URL disagrees with the real bind', {
        handedToClients: derived.origin,
        boundHost: bannerBinding.host,
        boundPort: bannerBinding.port,
      });
    }
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
    // Honour --daemon-home / GOODVIBES_DAEMON_HOME on the CREDENTIAL store, not
    // just the identity directory. Without this a daemon told to run out of a
    // temp tree still read the real home's daemon secrets, so "isolating" a
    // test daemon left it holding the owner's live credentials.
    daemonHomeDirectory,
    // The standalone daemon observes externally-launched coding-agent sessions
    // on the host read-only (fleet visibility + steer; never counted, never
    // stopped). Daemon-side only — the interactive process reads this snapshot
    // rather than double-detecting. Mirrors the SDK daemon cli.
    observeExternalAgents: true,
    // Opt into the REAL host power seam (Linux logind: systemd-inhibit children
    // + the dbus-monitor sleep-edge watcher) so the standalone daemon holds live
    // keep-awake/idle-inhibit. SDK 1.9.0's runtime-services factory defaults to
    // the non-spawning unavailable seam; only daemon compositions opt in. Mirrors
    // the SDK daemon cli's createHostPowerSeam() (sdk commit 3a5ea26d).
    powerSeam: createHostPowerSeam(),
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
    // A daemon running out of an overridden home must never adopt the machine's
    // service unit. One did: started from a scratchpad with --daemon-home, it
    // found the unit not running, wrote its own scratchpad ExecStart into
    // ~/.config/systemd/user/goodvibes.service and exited, and systemd then
    // supervised the throwaway as the machine's daemon for five hours.
    hasOverriddenHome: hasOverriddenGoodVibesHome(),
    // The SAME coordinator this repository's inbox poller registered with (see
    // runtime/cluster-composition.ts). The facade must reuse it rather than
    // compose its own: two coordinators in one process are two nodes in the
    // election, and whichever lost would silence consumers the other owns.
    clusterCoordinator: runtimeServices.clusterCoordinator,
    // The `cluster` verbs, served on /api/cluster/*. The CLI subcommands, the
    // TUI's /cluster command and any web UI all call these, so a command run
    // against a REMOTE daemon behaves exactly like one run on that machine.
    clusterGroupVerbs: runtimeServices.clusterGroup.verbs,
  });
  const listener = new HttpListener({
    hookDispatcher: runtimeServices.hookDispatcher,
    userAuth,
    configManager: config,
    serveFactory: createSafeHostServeFactory('Standalone HTTP listener'),
  });
  const { daemonToken, httpToken } = readDaemonCliTokens(process.env);

  // If no explicit daemon token is set, use the companion token so mobile apps can connect.
  const daemonHomeDir = daemonHomeDirectory;
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

  // Before the daemon: the group layer owns the socket the leader election
  // coordinates over, and it announces this machine's return to the group so a
  // box that has been off for months re-keys itself with no operator action.
  await runtimeServices.startCluster();

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
    // daemon.stop() drives the ordered inbound teardown: it stops every gated
    // consumer and only then broadcasts the resignation, so another node on
    // this network takes over in about a second instead of waiting out the
    // crash timeout.
    //
    // This process built the runtime graph and handed it to DaemonServer, so by
    // the SDK's ownership rule the facade leaves it alone — nothing else stops
    // these pollers. Without dispose() the config watch, fleet tick, memory
    // governor, watcher registry and six more kept ticking until process exit.
    // The handler surfaces (inbox store + its poll timers, catalog handlers) are
    // the FIRST thing dispose() unwinds — they are on the disposal owner list
    // now rather than sequenced by hand here, which is what makes every other
    // shutdown path stop them too instead of only this one.
    const stop = Promise.allSettled([listener.stop(), daemon.stop()])
      .then(() => { runtimeServices.dispose(); })
      .then(() => 'done' as const);
    const result = await Promise.race([stop, timeout]);
    if (result === 'timeout') {
      logger.warn('shutdown deadline exceeded — forcing exit');
      // A forced exit is exactly the case where the log matters most and is
      // least likely to have drained on its own.
      flushActivityLogSync();
      process.exit(1);
    }
    flushActivityLogSync();
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

  // Cheap unattended reconcile: if this (canonical) daemon unit is confirmed
  // serving AND a redundant installer-managed goodvibes-daemon.service (the
  // retired unit name) sits enabled-but-NOT-running beside it — the exact
  // production-incident state — auto-disable and remove it, printing a
  // receipt. A RUNNING legacy daemon, a hand-written unit, or an unanswered
  // configured endpoint all refuse with a notice instead. Best-effort: never
  // let this block or crash daemon boot (per-call systemctl timeouts plus one
  // cumulative pass deadline). The unit search root is the LOGIN user's home
  // (where systemd user units live), never the daemon data home
  // (GOODVIBES_DAEMON_HOME); the tracked name honors service.serviceName. The
  // endpoint requirement uses the CLIENT view of the config — a fresh read of
  // settings.json with none of this process's runtime flag overrides — because
  // that is what clients resolve when they look for the daemon.
  try {
    runDaemonConfigMigration(homeDirectory);
    const clientViewConfig = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
    const clientEndpoint = resolveRuntimeEndpointBinding(clientViewConfig, 'controlPlane');
    const reconcile = await reconcileRedundantLegacyUnit({
      homeDir: homedir(),
      trackedServiceName: resolveConfiguredServiceName(clientViewConfig),
      configuredEndpoint: { host: clientEndpoint.host, port: clientEndpoint.port },
    });
    if (reconcile.action !== 'noop') {
      for (const line of reconcile.lines) {
        // eslint-disable-next-line no-console
        console.log(line);
      }
    }
    if (reconcile.reason !== 'no-legacy-unit') {
      // Breadcrumb for EVERY outcome where a legacy unit file exists —
      // including guard refusals — so a persisting two-unit state is never
      // silent about why nothing was reconciled.
      logger.info('daemon: legacy-unit reconcile', { action: reconcile.action, reason: reconcile.reason });
    }
  } catch (error) {
    logger.warn('daemon: legacy-unit reconcile failed (non-fatal)', { error: summarizeError(error) });
  }

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
  // The banner renders the SAME SDK posture the pairing verb carries: the labeled
  // capability list, and the one honest LAN line only when the posture holds it.
  const posture = describeOriginPosture(webOrigin.origin);
  const capabilities = formatPostureCapabilities(posture);
  const notice = pairingPostureNotice(posture);
  const bannerLines = [
    `GoodVibes daemon ${VERSION} — scan to pair a device (opens the web app signed in):`,
    '',
    `  ${webOrigin.origin}`,
    '',
    ...(offers.length > 0 ? ['Offers (each declinable in the web app):', ...formatPairingOffers(offers), ''] : []),
    ...(capabilities.length > 0 ? ['This device will get:', ...capabilities, ''] : []),
    ...(notice ? [notice, ''] : []),
    qrString,
  ];
  // eslint-disable-next-line no-console
  console.log(bannerLines.join('\n'));
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: summarizeError(error),
  });
  // The daemon never came up. Without this the reason is buffered in a process
  // that is about to stop existing, and the failure reads as a daemon that
  // never logged anything at all.
  flushActivityLogSync();
  process.exit(1);
});
