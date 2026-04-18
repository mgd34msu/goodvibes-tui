import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../panels/skills-panel.ts';
import { buildSandboxReview, isRunningInWsl } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/manager';
import { renderQemuWrapperTemplate } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/qemu-wrapper-template';
import { getPluginDirectories } from '../../plugins/loader';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config/subscription-providers';
import type { SetupReviewSnapshot } from './local-setup-transfer.ts';
import { requireProviderApi, requireReadModels, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';

export async function buildSetupReviewSnapshot(ctx: CommandContext): Promise<SetupReviewSnapshot> {
  const shellPaths = requireShellPaths(ctx);
  const serviceRegistry = requireServiceRegistry(ctx);
  const services = Object.keys(serviceRegistry.getAll()).sort((a, b) => a.localeCompare(b));
  const serviceConfigs = serviceRegistry.getAll();
  const serviceIssues: string[] = [];
  for (const name of services) {
    const inspection = await serviceRegistry.inspect(name);
    if (!inspection?.hasPrimaryCredential) {
      serviceIssues.push(`${name}: missing primary credential`);
    }
  }

  const skills = await discoverSkills(shellPaths);
  const security = requireReadModels(ctx).security.getSnapshot();
  const plugins = security.plugins;
  const mcpServers = security.mcpServers;
  const pluginDirectories = getPluginDirectories({
    cwd: shellPaths.workingDirectory,
    homeDir: shellPaths.homeDirectory,
  });
  const providerCount = (await requireProviderApi(ctx).listModels()).length;
  const remoteRunnerCount = ctx.ops.remoteRuntime?.listContracts().length ?? 0;
  const oauthProviderCount = Object.values(serviceConfigs).filter((service) => service.authType === 'oauth' && service.oauth).length;
  const builtinSubscriptionProviderCount = listBuiltinSubscriptionProviders().length;
  const subscriptionManager = requireSubscriptionManager(ctx);
  const activeSubscriptionCount = subscriptionManager.list().length;
  const pendingSubscriptionCount = subscriptionManager.listPending().length;
  const sandboxReplIsolation = String(ctx.platform.configManager.get('sandbox.replIsolation'));
  const sandboxMcpIsolation = String(ctx.platform.configManager.get('sandbox.mcpIsolation'));
  const sandboxReview = buildSandboxReview(ctx.platform.configManager);
  const sandboxSecureModeReady = sandboxReview.host.secureSandboxReady;
  const quarantinedPluginCount = plugins.filter((plugin) => plugin.quarantined).length;
  const quarantinedMcpCount = mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
  const elevatedMcpCount = mcpServers.filter((server) => server.trustMode === 'allow-all').length;
  const hooksPath = shellPaths.resolveProjectPath('hooks.managed.json');
  let managedHookCount = 0;
  let managedHookChainCount = 0;
  if (existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as { hooks?: unknown[]; chains?: unknown[] };
      managedHookCount = parsed.hooks?.length ?? 0;
      managedHookChainCount = parsed.chains?.length ?? 0;
    } catch {
      // Ignore malformed hook config during snapshot collection.
    }
  }

  const issues: SetupReviewSnapshot['issues'] = [
    {
      severity: providerCount > 0 ? 'pass' : 'fail',
      area: 'providers',
      message: providerCount > 0 ? `${providerCount} model(s) available` : 'no models available',
    },
    {
      severity: (services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0) ? 'warn' : serviceIssues.length === 0 ? 'pass' : 'warn',
      area: 'services',
      message: (services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0)
        ? 'no services configured'
        : serviceIssues.length === 0
          ? `${services.length} service(s), ${oauthProviderCount + builtinSubscriptionProviderCount} oauth provider(s), ${activeSubscriptionCount} active subscription override(s)`
          : `${serviceIssues.length} service configuration issue(s)`,
    },
    {
      severity: quarantinedPluginCount === 0 ? 'pass' : 'warn',
      area: 'plugins',
      message: quarantinedPluginCount === 0
        ? `${plugins.length} plugin(s) discovered`
        : `${quarantinedPluginCount} plugin(s) quarantined`,
    },
    {
      severity: quarantinedMcpCount === 0 && elevatedMcpCount === 0 ? 'pass' : 'warn',
      area: 'mcp',
      message: quarantinedMcpCount > 0 || elevatedMcpCount > 0
        ? `${quarantinedMcpCount} quarantined, ${elevatedMcpCount} elevated`
        : `${mcpServers.length} server(s) known`,
    },
    {
      severity: managedHookCount > 0 || managedHookChainCount > 0 ? 'pass' : 'warn',
      area: 'hooks',
      message: `${managedHookCount} managed hook(s), ${managedHookChainCount} chain(s)`,
    },
    {
      severity: remoteRunnerCount > 0 ? 'pass' : 'warn',
      area: 'remote',
      message: remoteRunnerCount > 0 ? `${remoteRunnerCount} remote runner contract(s)` : 'no remote runner contracts registered',
    },
    {
      severity: sandboxSecureModeReady || `${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'local' ? 'pass' : 'warn',
      area: 'sandbox',
      message: `${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'local'
        ? 'local mode (virtualization disabled by default)'
        : sandboxSecureModeReady
          ? `QEMU enabled: REPL=${sandboxReplIsolation}, MCP=${sandboxMcpIsolation}`
          : 'QEMU sandboxing requires running GoodVibes inside WSL on Windows',
    },
  ];

  return {
    sessionId: ctx.session.runtime.sessionId,
    providerCount,
    serviceCount: services.length,
    oauthProviderCount,
    builtinSubscriptionProviderCount,
    activeSubscriptionCount,
    pendingSubscriptionCount,
    serviceIssues,
    skillCount: skills.length,
    pluginCount: plugins.length,
    quarantinedPluginCount,
    pluginDirectories,
    managedHookCount,
    managedHookChainCount,
    mcpServerCount: mcpServers.length,
    quarantinedMcpCount,
    elevatedMcpCount,
    remoteRunnerCount,
    sandboxReplIsolation,
    sandboxMcpIsolation,
    sandboxSecureModeReady,
    issues,
    services,
  };
}

export function renderSetupSandboxReview(ctx: CommandContext, snapshot: SetupReviewSnapshot): string {
  const backend = `${ctx.platform.configManager.get('sandbox.vmBackend')}`;
  const image = String(ctx.platform.configManager.get('sandbox.qemuImagePath') ?? '').trim();
  const wrapper = String(ctx.platform.configManager.get('sandbox.qemuExecWrapper') ?? '').trim();
  const host = String(ctx.platform.configManager.get('sandbox.qemuGuestHost') ?? '').trim();
  const workspace = String(ctx.platform.configManager.get('sandbox.qemuWorkspacePath') ?? '').trim();
  const lines = [
    'Setup Sandbox Review',
    `  backend: ${backend}`,
    `  repl isolation: ${snapshot.sandboxReplIsolation}`,
    `  mcp isolation: ${snapshot.sandboxMcpIsolation}`,
    `  secure mode ready: ${snapshot.sandboxSecureModeReady ? 'yes' : 'no'}`,
    `  qemu image: ${image || '(not configured)'}`,
    `  qemu wrapper: ${wrapper || '(not configured)'}`,
    `  guest host: ${host || '(not configured)'}`,
    `  guest workspace: ${workspace || '(not configured)'}`,
    '',
    '  next:',
  ];
  if (backend === 'local') {
    lines.push('    /sandbox qemu bootstrap .goodvibes/tui/sandbox 20');
    lines.push('    /sandbox doctor');
  } else if (!image || !wrapper) {
    lines.push('    /sandbox qemu setup .goodvibes/tui/sandbox');
    lines.push('    /sandbox qemu create-image .goodvibes/tui/sandbox/images/goodvibes-sandbox.qcow2 20');
    lines.push('    /sandbox doctor');
  } else {
    lines.push('    /sandbox guest-test eval-js');
    lines.push('    /sandbox session start eval-py');
  }
  if (process.platform === 'win32' && !isRunningInWsl()) {
    lines.push('    Run GoodVibes inside WSL before enabling QEMU sandboxing.');
  }
  return lines.join('\n');
}

export function exportSetupSupportBundle(
  targetDirArg: string,
  snapshot: SetupReviewSnapshot,
  ctx: CommandContext,
): string {
  const shellPaths = requireShellPaths(ctx);
  const targetDir = shellPaths.resolveWorkspacePath(targetDirArg);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'startup-review.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  const servicesPath = shellPaths.resolveProjectPath('tui', 'services.json');
  if (existsSync(servicesPath)) {
    writeFileSync(join(targetDir, 'services.json'), readFileSync(servicesPath, 'utf-8'), 'utf-8');
  }
  const hooksPath = shellPaths.resolveProjectPath('hooks.managed.json');
  if (existsSync(hooksPath)) {
    writeFileSync(join(targetDir, 'hooks.managed.json'), readFileSync(hooksPath, 'utf-8'), 'utf-8');
  }
  writeFileSync(join(targetDir, 'qemu-wrapper.template.sh'), renderQemuWrapperTemplate(), { encoding: 'utf-8', mode: 0o755 });
  return targetDir;
}
