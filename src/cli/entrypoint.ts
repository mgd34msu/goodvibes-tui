import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '@pellux/goodvibes-sdk/platform/providers';
import { readOnboardingCheckMarkers } from '../runtime/onboarding/index.ts';
import { GlobalNetworkTransportInstaller } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { configureActivityLogger } from '@pellux/goodvibes-sdk/platform/utils';
import {
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureFlagOverrides,
  buildCliStatusSnapshot,
  handleDoctorSubcommand,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderCliStatus,
  renderCompletion,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
  renderOnboardingCliStatus,
  resolveDoctorExitCode,
} from './index.ts';
import { buildCliServicePosture, getGoodVibesPackageRoot, resolveGoodVibesDaemonExecutable } from './service-posture.ts';
import { runInstallSelfCheck } from '../runtime/install-self-check.ts';
import { readPersistedWorkspaceTrust } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { WorkspaceRegistrationManager } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { CliWorkspaceStatus, CliSandboxStatus, CliRelayStatus } from './status.ts';
import { detectSandboxAvailability, probeSandboxHost } from '@pellux/goodvibes-sdk/platform/tools/exec/sandbox';
import { createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { ensureGoodvibesGitignore } from './ensure-goodvibes-gitignore.ts';
import { runDaemonConfigMigration } from '../config/run-daemon-config-migration.ts';
import { describeDaemonConfigMigration } from '@pellux/goodvibes-sdk/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';

type ShellEntrypointOwnership = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

export type ShellEntrypointRoots = {
  readonly defaultWorkingDirectory: string;
  readonly homeDirectory: string;
};

export type PreparedShellCliRuntime = {
  readonly cli: ReturnType<typeof parseGoodVibesCli>;
  readonly configManager: ConfigManager;
  readonly bootstrapWorkingDir: string;
  readonly bootstrapHomeDirectory: string;
};

function resolveShellEntrypointOwnership(roots: ShellEntrypointRoots, workingDirOverride?: string): ShellEntrypointOwnership {
  return {
    workingDirectory: workingDirOverride ?? roots.defaultWorkingDirectory,
    homeDirectory: roots.homeDirectory,
  };
}

export async function prepareShellCliRuntime(
  argv: readonly string[],
  roots: ShellEntrypointRoots,
  binary = 'goodvibes',
): Promise<PreparedShellCliRuntime> {
  const cli = parseGoodVibesCli(argv, binary);

  if (cli.errors.length > 0) {
    console.error(cli.errors.join('\n'));
    console.error('');
    console.error(renderGoodVibesHelp(binary));
    process.exit(2);
  }

  if (cli.warnings.length > 0) {
    for (const warning of cli.warnings) {
      console.warn(`[goodvibes] warning: ${warning}`);
    }
  }

  if (cli.flags.help || cli.command === 'help') {
    const helpTopic = cli.command === 'help'
      ? cli.commandArgs[0]
      : cli.rawCommand ?? undefined;
    console.log(helpTopic ? renderGoodVibesCommandHelp(helpTopic, binary) : renderGoodVibesHelp(binary));
    process.exit(0);
  }

  if (cli.flags.version || cli.command === 'version') {
    console.log(renderGoodVibesVersion(binary));
    process.exit(0);
  }

  if (cli.command === 'completion') {
    console.log(renderCompletion(cli.commandArgs[0], binary));
    process.exit(0);
  }

  if (cli.command === 'serve') {
    // The daemon is its own product and its own binary. This app is a client:
    // it never hosts one, so `serve` names something it cannot do. Say which
    // command to run instead rather than starting a daemon that would be a
    // second, drifting copy of the real one.
    console.error('`goodvibes serve` is gone: the daemon is a separate program now. Run `goodvibes-daemon serve` (installed alongside this app), or `goodvibes service start` to start the installed service.');
    process.exit(2);
  }

  const {
    workingDirectory: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  } = resolveShellEntrypointOwnership(roots, cli.flags.workingDir ?? (cli.command === 'tui' ? cli.commandArgs[0] : undefined));
  configureActivityLogger(join(bootstrapWorkingDir, '.goodvibes', 'logs'));
  // Only prints the first time the rule is actually appended (not on every
  // launch) — see ensureGoodvibesGitignore's return-value doc.
  if (ensureGoodvibesGitignore(bootstrapWorkingDir)) {
    console.log("[goodvibes] added '.goodvibes/' to .gitignore — this directory holds transient TUI state (logs, session cache, exec output), not project source.");
  }
  const daemonConfigMigration = runDaemonConfigMigration(bootstrapHomeDirectory);
  if (daemonConfigMigration?.migrated && (daemonConfigMigration.marker.moved.length + daemonConfigMigration.marker.discarded.length) > 0) {
    console.log(`[goodvibes] ${describeDaemonConfigMigration(daemonConfigMigration.marker)}`);
  }
  const configManager = new ConfigManager({
    workingDir: bootstrapWorkingDir,
    homeDir: bootstrapHomeDirectory,
    surfaceRoot: 'tui',
  });
  new GlobalNetworkTransportInstaller().install(configManager);

  const overrideErrors = applyRuntimeConfigOverrides(configManager, cli.flags.configOverrides);
  if (overrideErrors.length > 0) {
    console.error(overrideErrors.join('\n'));
    process.exit(2);
  }
  const featureOverrideErrors = applyRuntimeFeatureFlagOverrides(configManager, {
    enableFeatures: cli.flags.enableFeatures,
    disableFeatures: cli.flags.disableFeatures,
  });
  if (featureOverrideErrors.length > 0) {
    console.error(featureOverrideErrors.join('\n'));
    process.exit(2);
  }

  if (cli.flags.provider !== undefined || cli.flags.model !== undefined) {
    const currentModel = configManager.get('provider.model');
    const provider = cli.flags.provider ?? getProviderIdFromModel(currentModel);
    const model = cli.flags.model ?? getModelIdFromProviderModel(currentModel);
    applyRuntimeConfigValue(configManager, 'provider.model', formatProviderModel(provider, model));
  }
  const endpointOverrideErrors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);
  if (endpointOverrideErrors.length > 0) {
    console.error(endpointOverrideErrors.join('\n'));
    process.exit(2);
  }

  if (cli.command === 'doctor' && ['explain', 'routing', 'hooks'].includes(cli.commandArgs[0] ?? '')) {
    const result = await handleDoctorSubcommand({
      subcommand: cli.commandArgs[0]!,
      args: cli.commandArgs.slice(1),
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
      outputFormat: cli.flags.outputFormat,
    });
    if (result) {
      console.log(result.output);
      process.exit(result.exitCode);
    }
  }

  if (cli.command === 'status' || cli.command === 'doctor' || (cli.command === 'onboarding' && cli.commandArgs[0] === 'status')) {
    const shellPaths = createShellPathService({
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
    });
    const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
    const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
    const operatorTokenPath = join(bootstrapHomeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
    const onboardingMarkers = readOnboardingCheckMarkers(shellPaths);
    const service = await buildCliServicePosture({
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
    });
    // Read-only workspace posture for the report: the trust reader never
    // persists (no grandfathering side effect), and registration resolve() is
    // read-only, so `status`/`doctor` observe state without mutating it.
    const trustView = readPersistedWorkspaceTrust(shellPaths, GOODVIBES_TUI_SURFACE_ROOT);
    const registrationEvaluation = await new WorkspaceRegistrationManager({ shellPaths }).evaluate();
    const workspaceStatus: CliWorkspaceStatus = {
      trustLevel: trustView.level,
      trustGrandfathered: trustView.grandfathered,
      registrationStatus: registrationEvaluation.status,
      registrationRoot: registrationEvaluation.root,
      registeredBy: registrationEvaluation.coveredBy,
      viaWorktreeLink: registrationEvaluation.viaWorktreeLink,
      registrationBroad: registrationEvaluation.broad,
    };
    // Honest per-command exec sandbox posture: the host probe (a bwrap spawn on
    // Linux, a no-op elsewhere) is what makes "available" trustworthy.
    const sandboxAvailability = detectSandboxAvailability(probeSandboxHost());
    const sandboxFeatureFlags = createFeatureFlagManager();
    sandboxFeatureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    const sandboxStatus: CliSandboxStatus = {
      configEnabled: Boolean(configManager.getCategory('sandbox').enabled),
      featureEnabled: sandboxFeatureFlags.isEnabled('exec-sandbox'),
      available: sandboxAvailability.available,
      backend: sandboxAvailability.backend,
      reason: sandboxAvailability.reason,
      networkIsolationGuaranteed: sandboxAvailability.networkIsolationGuaranteed,
    };
    // Reuses sandboxFeatureFlags (already derived from the same domain settings keys)
    // for the relay-connect gate rather than constructing a second FeatureFlagManager.
    const relayCategory = configManager.getCategory('relay');
    const relayStatus: CliRelayStatus = {
      configEnabled: relayCategory.enabled === true,
      featureEnabled: sandboxFeatureFlags.isEnabled('relay-connect'),
      url: String(relayCategory.url ?? ''),
      rendezvousId: String(relayCategory.rendezvousId ?? ''),
      requireStepUpForMutations: relayCategory.requireStepUpForMutations === true,
    };
    const statusOptions = {
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
      onboardingMarkers,
      auth: {
        userStorePath,
        userStorePresent: existsSync(userStorePath),
        bootstrapCredentialPath,
        bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
        operatorTokenPath,
        operatorTokenPresent: existsSync(operatorTokenPath),
      },
      service,
      install: runInstallSelfCheck({
        execPath: process.execPath,
        packageRoot: getGoodVibesPackageRoot(),
        daemon: resolveGoodVibesDaemonExecutable(),
        fileExists: existsSync,
      }),
      doctor: cli.command === 'doctor',
      outputFormat: cli.flags.outputFormat,
      workspace: workspaceStatus,
      sandbox: sandboxStatus,
      relay: relayStatus,
    };
    const snapshot = buildCliStatusSnapshot(statusOptions);
    console.log(cli.command === 'onboarding'
      ? renderOnboardingCliStatus(statusOptions)
      : renderCliStatus(statusOptions));
    // Advisory findings are notes on an otherwise-usable install and must
    // never make a healthy install report failure — only a must-fix finding
    // exits non-zero; --strict (for CI) flips advisories to failures too.
    process.exit(cli.command === 'doctor' ? resolveDoctorExitCode(snapshot.findings, cli.flags.strict) : 0);
  }

  const cliCommandResult = await handleGoodVibesCliCommand({
    cli,
    configManager,
    workingDirectory: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  });
  if (cliCommandResult.handled) {
    process.exit(cliCommandResult.exitCode);
  }

  return { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory };
}
