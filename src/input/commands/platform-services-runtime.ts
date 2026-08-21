import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { requireSecretsManager, requireShellPaths } from './runtime-services.ts';

interface SecureStorageBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly storedKeys: readonly string[];
  readonly envBackedKeys: readonly string[];
}

interface DeepLinkBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly links: readonly string[];
}

interface IntegrationHelperBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly apiFamilies: readonly string[];
  readonly routes: readonly string[];
}

function buildSetupLink(surface: string, target?: string): string {
  const params = target ? `?target=${encodeURIComponent(target)}` : '';
  return `goodvibes://open/${surface}${params}`;
}

function inspectStorageBundle(bundle: SecureStorageBundle): string {
  return [
    'Secure Storage Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  storedKeys: ${bundle.storedKeys.length}`,
    `  envBackedKeys: ${bundle.envBackedKeys.length}`,
  ].join('\n');
}

function inspectDeepLinkBundle(bundle: DeepLinkBundle): string {
  return [
    'Deep Link Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  links: ${bundle.links.length}`,
  ].join('\n');
}

function inspectIntegrationHelperBundle(bundle: IntegrationHelperBundle): string {
  return [
    'Integration Helper Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  apiFamilies: ${bundle.apiFamilies.length}`,
    `  routes: ${bundle.routes.length}`,
  ].join('\n');
}

export function registerPlatformServicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'storage',
    description: 'Review secure storage posture and export portable storage metadata bundles',
    usage: '[review|list|delete <key>|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const manager = requireSecretsManager(ctx);
      const sub = args[0] ?? 'review';
      const review = await manager.inspect();
      const storedKeys = await manager.list();
      const detailedKeys = await manager.listDetailed();
      const envBackedKeys = [...new Set(detailedKeys.filter((record) => record.source === 'env').map((record) => record.key))];

      if (sub === 'review') {
        ctx.print([
          'Secure Storage Review',
          `  policy: ${review.policy}`,
          `  stored keys: ${storedKeys.length}`,
          `  env-backed keys: ${envBackedKeys.length}`,
          `  secure keys: ${review.secureKeys}`,
          `  plaintext keys: ${review.plaintextKeys}`,
          ...review.locations.map((location) => `  ${location.source}: ${location.exists ? 'present' : 'absent'} (${location.path})`),
          ...(review.warnings.length > 0 ? review.warnings.map((warning) => `  warning: ${warning}`) : []),
        ].join('\n'));
        return;
      }
      if (sub === 'list') {
        ctx.print(detailedKeys.filter((record) => record.source !== 'env').length > 0
          ? ['Secure Storage Keys', ...detailedKeys.filter((record) => record.source !== 'env').map((record) => `  ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`)].join('\n')
          : 'Secure Storage Keys\n  No stored secrets yet.');
        return;
      }
      if (sub === 'delete') {
        const key = args[1];
        if (!key) {
          ctx.print('Usage: /storage delete <key>');
          return;
        }
        await manager.delete(key);
        ctx.print(`Deleted secure storage key ${key}.`);
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /storage bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const bundle: SecureStorageBundle = {
            version: 1,
            exportedAt: Date.now(),
            storedKeys,
            envBackedKeys,
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Secure storage bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SecureStorageBundle;
          ctx.print(inspectStorageBundle(bundle));
          return;
        }
      }
      ctx.print('Usage: /storage [review|list|delete <key>|bundle export <path>|bundle inspect <path>]');
    },
  });

  registry.register({
    name: 'helpers',
    aliases: ['integration-api'],
    description: 'Review local integration helper APIs for remote clients and future web frontends',
    usage: '[review|bundle export <path>|bundle inspect <path>]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      const review = ctx.extensions.integrationHelpers?.buildReview();
      if (!review) {
        ctx.print('Integration helper service unavailable in this runtime.');
        return;
      }
      if (sub === 'review') {
        ctx.print([
          'Integration Helper Review',
          `  sessions: ${review.sessions}`,
          `  tasks: ${review.tasks}`,
          `  pending approvals: ${review.pendingApprovals}`,
          `  remote contracts: ${review.remoteContracts}`,
          `  registered panels: ${review.panels}`,
          '  api families:',
          ...review.apiFamilies.map((family) => `    - ${family}`),
          '  routes:',
          ...review.routes.map((route) => `    - ${route}`),
        ].join('\n'));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /helpers bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const bundle: IntegrationHelperBundle = {
            version: 1,
            exportedAt: Date.now(),
            apiFamilies: review.apiFamilies,
            routes: review.routes,
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Integration helper bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as IntegrationHelperBundle;
          ctx.print(inspectIntegrationHelperBundle(bundle));
          return;
        }
      }
      ctx.print('Usage: /helpers [review|bundle export <path>|bundle inspect <path>]');
    },
  });

  registry.register({
    name: 'deeplink',
    aliases: ['link'],
    description: 'Review and package deep-link entrypoints for setup and operator screens',
    usage: '[review|open <surface> [target]|bundle export <path>|bundle inspect <path>]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      const links = [
        buildSetupLink('cockpit'),
        buildSetupLink('security'),
        buildSetupLink('remote'),
        buildSetupLink('knowledge'),
        buildSetupLink('marketplace'),
        buildSetupLink('sandbox'),
      ];
      if (sub === 'review') {
        ctx.print(['Deep Link Review', ...links.map((link) => `  ${link}`)].join('\n'));
        return;
      }
      if (sub === 'open') {
        const surface = args[1];
        const target = args[2];
        if (!surface) {
          ctx.print('Usage: /deeplink open <surface> [target]');
          return;
        }
        ctx.print(buildSetupLink(surface, target));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /deeplink bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const bundle: DeepLinkBundle = {
            version: 1,
            exportedAt: Date.now(),
            links,
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Deep link bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as DeepLinkBundle;
          ctx.print(inspectDeepLinkBundle(bundle));
          return;
        }
      }
      ctx.print('Usage: /deeplink [review|open <surface> [target]|bundle export <path>|bundle inspect <path>]');
    },
  });
}
