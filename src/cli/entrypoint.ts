import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../config/index.ts';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '../config/provider-model.ts';
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
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderCliStatus,
  renderCompletion,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
  renderOnboardingCliStatus,
} from './index.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { ensureGoodvibesGitignore } from './ensure-goodvibes-gitignore.ts';

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
    await import('../daemon/cli.ts');
    return new Promise<PreparedShellCliRuntime>(() => {});
  }

  const {
    workingDirectory: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  } = resolveShellEntrypointOwnership(roots, cli.flags.workingDir ?? (cli.command === 'tui' ? cli.commandArgs[0] : undefined));
  configureActivityLogger(join(bootstrapWorkingDir, '.goodvibes', 'logs'));
  ensureGoodvibesGitignore(bootstrapWorkingDir);
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
  applyRuntimeFeatureFlagOverrides(configManager, {
    enableFeatures: cli.flags.enableFeatures,
    disableFeatures: cli.flags.disableFeatures,
  });

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
      doctor: cli.command === 'doctor',
      outputFormat: cli.flags.outputFormat,
    };
    const snapshot = buildCliStatusSnapshot(statusOptions);
    console.log(cli.command === 'onboarding'
      ? renderOnboardingCliStatus(statusOptions)
      : renderCliStatus(statusOptions));
    process.exit(cli.command === 'doctor' && snapshot.findings.length > 0 ? 1 : 0);
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
