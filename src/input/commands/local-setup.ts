import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { ConfigKey } from '../../config/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import { listHookPointContracts } from '@pellux/goodvibes-sdk/platform/hooks/index';
import { isRunningInWsl } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/manager';
import { renderQemuWrapperTemplate } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/qemu-wrapper-template';
import type { SetupTransferBundle } from './local-setup-transfer.ts';
import {
  buildSetupTransferBundle,
  createSetupLink,
  exportSetupTransferBundle,
  inspectSetupTransferBundle,
  parseSetupLink,
} from './local-setup-transfer.ts';
import { buildSetupReviewSnapshot, exportSetupSupportBundle, renderSetupSandboxReview } from './local-setup-review.ts';
import { requirePanelManager, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export function registerLocalSetupCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'setup',
    aliases: ['startup'],
    description: 'Review startup readiness, ecosystem posture, sandbox bring-up, and service configuration',
    usage: '[review|doctor|services|hooks|remote|sandbox|onboarding|support-bundle <dir>|export <path>|transfer <export|inspect|import> <path>|link <surface> [target]|open-link <uri>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      const snapshot = await buildSetupReviewSnapshot(ctx);
      if (sub === 'review') {
        ctx.print([
          'Startup Readiness Review',
          `  session: ${snapshot.sessionId}`,
          `  providers/models: ${snapshot.providerCount}`,
          `  services configured: ${snapshot.serviceCount}`,
          `  oauth providers: ${snapshot.oauthProviderCount + snapshot.builtinSubscriptionProviderCount}`,
          `  active subscriptions: ${snapshot.activeSubscriptionCount}`,
          `  pending subscriptions: ${snapshot.pendingSubscriptionCount}`,
          `  skills discovered: ${snapshot.skillCount}`,
          `  plugins discovered: ${snapshot.pluginCount}`,
          `  quarantined plugins: ${snapshot.quarantinedPluginCount}`,
          `  plugin search dirs: ${snapshot.pluginDirectories.length}`,
          `  managed hooks: ${snapshot.managedHookCount}`,
          `  managed hook chains: ${snapshot.managedHookChainCount}`,
          `  mcp servers known: ${snapshot.mcpServerCount}`,
          `  mcp quarantined: ${snapshot.quarantinedMcpCount}`,
          `  mcp elevated: ${snapshot.elevatedMcpCount}`,
          `  remote runners: ${snapshot.remoteRunnerCount}`,
          `  sandbox backend: ${ctx.platform.configManager.get('sandbox.vmBackend')}`,
          `  qemu image: ${String(ctx.platform.configManager.get('sandbox.qemuImagePath')) || '(not configured)'}`,
          `  qemu wrapper: ${String(ctx.platform.configManager.get('sandbox.qemuExecWrapper')) || '(not configured)'}`,
          '',
          `  service ids: ${snapshot.services.join(', ') || '(none)'}`,
          `  plugin dirs: ${snapshot.pluginDirectories.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }

      if (sub === 'doctor') {
        ctx.print([
          'Startup Doctor',
          ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area}: ${issue.message}`),
          ...(`${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'qemu' && !String(ctx.platform.configManager.get('sandbox.qemuImagePath')).trim()
            ? ['  [WARN] sandbox: qemu backend selected without qemuImagePath'] : []),
          ...(`${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'qemu' && !String(ctx.platform.configManager.get('sandbox.qemuExecWrapper')).trim()
            ? ['  [WARN] sandbox: qemu backend selected without qemuExecWrapper', '    next: /sandbox scaffold-qemu-wrapper .goodvibes/tui/qemu-wrapper.sh'] : []),
          ...(`${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'qemu' && String(ctx.platform.configManager.get('sandbox.qemuExecWrapper')).trim()
            ? ['  [INFO] sandbox: wrapper bridge can be validated with GV_SANDBOX_WRAPPER_MODE=host-exec before wiring a real guest transport'] : []),
          ...(snapshot.serviceIssues.length > 0
            ? ['', '  Service issues:', ...snapshot.serviceIssues.map((issue) => `    - ${issue}`)]
            : []),
        ].join('\n'));
        return;
      }

      if (sub === 'services') {
        ctx.print([
          'Startup Services',
          `  configured: ${snapshot.serviceCount}`,
          `  oauth providers: ${snapshot.oauthProviderCount + snapshot.builtinSubscriptionProviderCount}`,
          `  active subscriptions: ${snapshot.activeSubscriptionCount}`,
          `  pending subscriptions: ${snapshot.pendingSubscriptionCount}`,
          `  issues: ${snapshot.serviceIssues.length}`,
          ...snapshot.services.map((name) => `  ${name}`),
          ...(snapshot.serviceIssues.length > 0
            ? ['', ...snapshot.serviceIssues.map((issue) => `  issue: ${issue}`)]
            : []),
        ].join('\n'));
        return;
      }

      if (sub === 'hooks') {
        const contracts = listHookPointContracts();
        ctx.print([
          'Startup Hooks',
          `  managed hooks: ${snapshot.managedHookCount}`,
          `  managed chains: ${snapshot.managedHookChainCount}`,
          `  hook contracts: ${contracts.length}`,
        ].join('\n'));
        return;
      }

      if (sub === 'remote') {
        const runners = ctx.ops.remoteRuntime?.listContracts() ?? [];
        ctx.print([
          'Startup Remote',
          `  runner contracts: ${snapshot.remoteRunnerCount}`,
          ...runners.map((runner) => `  ${runner.id}  [${runner.trustClass}]  ${runner.label}`),
        ].join('\n'));
        return;
      }

      if (sub === 'sandbox') {
        ctx.print(renderSetupSandboxReview(ctx, snapshot));
        return;
      }

      if (sub === 'onboarding') {
        ctx.print([
          'Onboarding Checklist',
          `  providers: ${snapshot.providerCount > 0 ? '[ready]' : '[needs setup]'}`,
          `  services: ${(snapshot.serviceCount > 0 || snapshot.oauthProviderCount > 0 || snapshot.builtinSubscriptionProviderCount > 0) ? '[ready]' : '[optional]'}`,
          `  subscriptions: ${snapshot.activeSubscriptionCount > 0 ? '[ready]' : (snapshot.oauthProviderCount + snapshot.builtinSubscriptionProviderCount) > 0 ? '[available]' : '[optional]'}`,
          `  hooks: ${(snapshot.managedHookCount + snapshot.managedHookChainCount) > 0 ? '[ready]' : '[optional]'}`,
          `  remote: ${snapshot.remoteRunnerCount > 0 ? '[ready]' : '[optional]'}`,
          `  sandbox: ${`${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'local' ? '[local default]' : (snapshot.sandboxSecureModeReady ? '[qemu ready]' : '[host blocked]')}`,
          `  plugins: ${snapshot.pluginCount > 0 ? '[ready]' : '[optional]'}`,
          `  skills: ${snapshot.skillCount > 0 ? '[ready]' : '[optional]'}`,
          '',
          'Recommended next commands:',
          '  /health review',
          '  /provider',
          '  /services doctor',
          '  /subscription review',
          '  /hooks scaffold <name> <match> <type>',
          '  /setup sandbox',
          '  /sandbox recommend',
          '  /sandbox qemu bootstrap .goodvibes/tui/sandbox 20',
          ...(process.platform === 'win32' && !isRunningInWsl() ? ['  Run GoodVibes inside WSL before enabling QEMU sandboxing'] : []),
          '  /remote setup',
          '  /plugin browse',
          '  /skills browse',
        ].join('\n'));
        return;
      }

      if (sub === 'support-bundle') {
        const dirArg = args[1];
        if (!dirArg) {
          ctx.print('Usage: /setup support-bundle <dir>');
          return;
        }
        const targetDir = exportSetupSupportBundle(dirArg, snapshot, ctx);
        writeFileSync(join(targetDir, 'remote-summary.json'), JSON.stringify({
          runners: ctx.ops.remoteRuntime?.listContracts() ?? [],
          artifacts: (ctx.ops.remoteRuntime?.listArtifacts() ?? []).map((artifact) => ({
            id: artifact.id,
            runnerId: artifact.runnerId,
            status: artifact.task.status,
            createdAt: artifact.createdAt,
          })),
        }, null, 2) + '\n', 'utf-8');
        writeFileSync(join(targetDir, 'qemu-wrapper.template.sh'), renderQemuWrapperTemplate(), { encoding: 'utf-8', mode: 0o755 });
        ctx.print(`Exported support bundle to ${targetDir}`);
        return;
      }

      if (sub === 'export') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /setup export <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported startup review to ${targetPath}`);
        return;
      }

      if (sub === 'transfer') {
        const mode = args[1]?.toLowerCase();
        const pathArg = args[2];
        if (!mode || !pathArg) {
          ctx.print('Usage: /setup transfer <export|inspect|import> <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        if (mode === 'export') {
          const bundle = buildSetupTransferBundle(ctx, snapshot);
          ctx.print(`Exported setup transfer bundle to ${exportSetupTransferBundle(ctx, pathArg, bundle)}`);
          return;
        }
        if (mode === 'inspect') {
          try {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SetupTransferBundle;
            ctx.print(`${inspectSetupTransferBundle(bundle)}\n  path: ${targetPath}`);
          } catch (error) {
            ctx.print(`Failed to inspect setup transfer bundle: ${summarizeError(error)}`);
          }
          return;
        }
        if (mode === 'import') {
          try {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SetupTransferBundle;
            for (const entry of CONFIG_SCHEMA) {
              if (Object.prototype.hasOwnProperty.call(bundle.config, entry.key)) {
                ctx.platform.configManager.setDynamic(entry.key as ConfigKey, (bundle.config as Record<string, unknown>)[entry.key]);
              }
            }
            if (bundle.services) {
              const servicesPath = shellPaths.resolveProjectPath('tui', 'services.json');
              mkdirSync(dirname(servicesPath), { recursive: true });
              writeFileSync(servicesPath, JSON.stringify(bundle.services, null, 2) + '\n', 'utf-8');
            }
            if (bundle.ecosystem?.plugins) {
              const pluginsPath = shellPaths.resolveProjectPath('tui', 'ecosystem', 'plugins.json');
              mkdirSync(dirname(pluginsPath), { recursive: true });
              writeFileSync(pluginsPath, JSON.stringify(bundle.ecosystem.plugins, null, 2) + '\n', 'utf-8');
            }
            if (bundle.ecosystem?.skills) {
              const skillsPath = shellPaths.resolveProjectPath('tui', 'ecosystem', 'skills.json');
              mkdirSync(dirname(skillsPath), { recursive: true });
              writeFileSync(skillsPath, JSON.stringify(bundle.ecosystem.skills, null, 2) + '\n', 'utf-8');
            }
            ctx.print(`Imported setup transfer bundle from ${targetPath}`);
          } catch (error) {
            ctx.print(`Failed to import setup transfer bundle: ${summarizeError(error)}`);
          }
          return;
        }
        ctx.print('Usage: /setup transfer <export|inspect|import> <path>');
        return;
      }

      if (sub === 'link') {
        const surface = args[1];
        const target = args[2];
        if (!surface) {
          ctx.print('Usage: /setup link <cockpit|security|remote|knowledge|incident|hooks|orchestration|tasks> [target]');
          return;
        }
        ctx.print(createSetupLink(surface, target));
        return;
      }

      if (sub === 'open-link') {
        const link = args[1];
        if (!link) {
          ctx.print('Usage: /setup open-link <goodvibes://...>');
          return;
        }
        const parsed = parseSetupLink(link);
        if (!parsed) {
          ctx.print(`Invalid setup link: ${link}`);
          return;
        }
        const panelOpeners: Record<string, (() => void) | undefined> = {
          cockpit: ctx.openCockpitPanel,
          security: ctx.openSecurityPanel,
          remote: ctx.openRemotePanel,
          knowledge: ctx.openKnowledgePanel,
          incident: ctx.openIncidentPanel,
          hooks: ctx.openHooksPanel,
          orchestration: ctx.openOrchestrationPanel,
        };
        if (parsed.surface === 'tasks') {
          if (ctx.showPanel) ctx.showPanel('tasks');
          else {
            const panelManager = requirePanelManager(ctx);
            panelManager.open('tasks');
            panelManager.show();
            ctx.renderRequest();
          }
          ctx.print(`Opened setup link for tasks${parsed.target ? ` (${parsed.target})` : ''}.`);
          return;
        }
        const openPanel = panelOpeners[parsed.surface];
        if (!openPanel) {
          ctx.print(`Unsupported setup link surface: ${parsed.surface}`);
          return;
        }
        openPanel();
        ctx.print(`Opened setup link for ${parsed.surface}${parsed.target ? ` (${parsed.target})` : ''}.`);
        return;
      }

      ctx.print('Usage: /setup [review|doctor|services|hooks|remote|sandbox|onboarding|support-bundle <dir>|export <path>|transfer <export|inspect|import> <path>|link <surface> [target]|open-link <uri>]');
    },
  });
}
