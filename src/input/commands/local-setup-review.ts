import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { discoverSkills } from '../../panels/skills-panel.ts';
import { getRemoteRunnerRegistry } from '../../runtime/remote/index.ts';
import { buildSandboxReview, isRunningInWsl } from '../../runtime/sandbox/manager.ts';
import { renderQemuWrapperTemplate } from '../../runtime/sandbox/qemu-wrapper-template.ts';
import { pluginManager } from '../../plugins/manager.ts';
import { getPluginDirectories } from '../../plugins/loader.ts';
import { getSubscriptionManager } from '../../config/subscriptions.ts';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.ts';
import type { SetupReviewSnapshot } from './local-setup-transfer.ts';

let serviceRegistry: ServiceRegistry | undefined;

function getServiceRegistry(): ServiceRegistry {
  if (!serviceRegistry) serviceRegistry = new ServiceRegistry();
  return serviceRegistry;
}

export async function buildSetupReviewSnapshot(ctx: CommandContext): Promise<SetupReviewSnapshot> {
  const services = Object.keys(getServiceRegistry().getAll()).sort((a, b) => a.localeCompare(b));
  const serviceConfigs = getServiceRegistry().getAll();
  const serviceIssues: string[] = [];
  for (const name of services) {
    const inspection = await getServiceRegistry().inspect(name);
    if (!inspection?.hasPrimaryCredential) {
      serviceIssues.push(`${name}: missing primary credential`);
    }
  }

  const skills = discoverSkills();
  const plugins = pluginManager.list();
  const runtimeState = ctx.runtimeStore?.getState();
  const mcpServers = [...(runtimeState?.mcp.servers.values() ?? [])];
  const pluginDirectories = getPluginDirectories();
  const providerCount = ctx.providerRegistry.listModels().length;
  const remoteRunnerCount = getRemoteRunnerRegistry().listContracts().length;
  const oauthProviderCount = Object.values(serviceConfigs).filter((service) => service.authType === 'oauth' && service.oauth).length;
  const builtinSubscriptionProviderCount = listBuiltinSubscriptionProviders().length;
  const subscriptionManager = getSubscriptionManager();
  const activeSubscriptionCount = subscriptionManager.list().length;
  const pendingSubscriptionCount = subscriptionManager.listPending().length;
  const sandboxReplIsolation = String(ctx.configManager.get('sandbox.replIsolation'));
  const sandboxMcpIsolation = String(ctx.configManager.get('sandbox.mcpIsolation'));
  const sandboxReview = buildSandboxReview(ctx.configManager);
  const sandboxSecureModeReady = sandboxReview.host.secureSandboxReady;
  const quarantinedPluginCount = plugins.filter((plugin) => plugin.quarantined).length;
  const quarantinedMcpCount = mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
  const elevatedMcpCount = mcpServers.filter((server) => server.trustMode === 'allow-all').length;
  const hooksPath = join(process.cwd(), '.goodvibes', 'hooks.managed.json');
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
      severity: sandboxSecureModeReady || `${ctx.configManager.get('sandbox.vmBackend')}` === 'local' ? 'pass' : 'warn',
      area: 'sandbox',
      message: `${ctx.configManager.get('sandbox.vmBackend')}` === 'local'
        ? 'local mode (virtualization disabled by default)'
        : sandboxSecureModeReady
          ? `QEMU enabled: REPL=${sandboxReplIsolation}, MCP=${sandboxMcpIsolation}`
          : 'QEMU sandboxing requires running GoodVibes inside WSL on Windows',
    },
  ];

  return {
    sessionId: ctx.runtime.sessionId,
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
  const backend = `${ctx.configManager.get('sandbox.vmBackend')}`;
  const image = String(ctx.configManager.get('sandbox.qemuImagePath') ?? '').trim();
  const wrapper = String(ctx.configManager.get('sandbox.qemuExecWrapper') ?? '').trim();
  const host = String(ctx.configManager.get('sandbox.qemuGuestHost') ?? '').trim();
  const workspace = String(ctx.configManager.get('sandbox.qemuWorkspacePath') ?? '').trim();
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

export function exportSetupSupportBundle(targetDirArg: string, snapshot: SetupReviewSnapshot): string {
  const targetDir = resolve(process.cwd(), targetDirArg);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'startup-review.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  const servicesPath = join(process.cwd(), '.goodvibes', 'tui', 'services.json');
  if (existsSync(servicesPath)) {
    writeFileSync(join(targetDir, 'services.json'), readFileSync(servicesPath, 'utf-8'), 'utf-8');
  }
  const hooksPath = join(process.cwd(), '.goodvibes', 'hooks.managed.json');
  if (existsSync(hooksPath)) {
    writeFileSync(join(targetDir, 'hooks.managed.json'), readFileSync(hooksPath, 'utf-8'), 'utf-8');
  }
  writeFileSync(join(targetDir, 'qemu-wrapper.template.sh'), renderQemuWrapperTemplate(), { encoding: 'utf-8', mode: 0o755 });
  return targetDir;
}
