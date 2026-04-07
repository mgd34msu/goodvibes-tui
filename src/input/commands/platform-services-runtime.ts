import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { getSecretsManager } from '../../config/secrets.ts';

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

export function registerPlatformServicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'storage',
    description: 'Review secure storage posture and export portable storage metadata bundles',
    usage: '[review|list|delete <key>|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const manager = getSecretsManager();
      const sub = args[0] ?? 'review';
      const storedKeys = await manager.list();
      const envBackedKeys = storedKeys.filter((key) => process.env[key] !== undefined);

      if (sub === 'review') {
        ctx.print([
          'Secure Storage Review',
          `  stored keys: ${storedKeys.length}`,
          `  env-backed keys: ${envBackedKeys.length}`,
          '  storage: encrypted local secrets + environment overrides',
        ].join('\n'));
        return;
      }
      if (sub === 'list') {
        ctx.print(storedKeys.length > 0
          ? ['Secure Storage Keys', ...storedKeys.map((key) => `  ${key}${process.env[key] !== undefined ? ' (env override)' : ''}`)].join('\n')
          : 'Secure Storage Keys\n  No encrypted secrets stored yet.');
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
        const targetPath = resolve(process.cwd(), pathArg!);
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
    name: 'deeplink',
    aliases: ['link'],
    description: 'Review and package deep-link entrypoints for setup and operator surfaces',
    usage: '[review|open <surface> [target]|bundle export <path>|bundle inspect <path>]',
    handler(args, ctx) {
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
        const targetPath = resolve(process.cwd(), pathArg!);
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
