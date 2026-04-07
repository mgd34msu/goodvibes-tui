import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { getProfileManager } from '../../profiles/manager.ts';
import { profileDataToConfigSnapshot } from '../../profiles/shape.ts';
import { CONFIG_SCHEMA, type ConfigKey } from '../../config/index.ts';
import type { ManagedSettingsBundle } from '../../runtime/sandbox/types.ts';

function buildConfigSnapshot(
  manager: { get: (key: ConfigKey) => unknown },
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    try {
      snapshot[entry.key] = structuredClone(manager.get(entry.key));
    } catch {
      // ignore unreadable settings
    }
  }
  return snapshot;
}

function inspectManagedSettingsBundle(bundle: ManagedSettingsBundle): string {
  return [
    'Managed Settings Review',
    `  profileName: ${bundle.profileName}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  settings: ${Object.keys(bundle.settings).length}`,
  ].join('\n');
}

export function registerManagedRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'managed',
    description: 'Export, inspect, and apply managed settings bundles',
    usage: '[review|export <profile> <path>|inspect <path>|apply <path>]',
    handler(args, ctx) {
      const sub = args[0] ?? 'review';
      const pm = getProfileManager();
      if (sub === 'review') {
        const profiles = pm.list();
        ctx.print([
          'Managed Settings Review',
          `  saved profiles: ${profiles.length}`,
          `  live config keys: ${Object.keys(buildConfigSnapshot(ctx.configManager)).length}`,
        ].join('\n'));
        return;
      }

      if (sub === 'export') {
        const profileName = args[1];
        const pathArg = args[2];
        if (!profileName || !pathArg) {
          ctx.print('Usage: /managed export <profile> <path>');
          return;
        }
        const loaded = pm.load(profileName);
        const bundle: ManagedSettingsBundle = {
          version: 1,
          exportedAt: Date.now(),
          profileName,
          settings: profileDataToConfigSnapshot(loaded.data),
        };
        const targetPath = resolve(process.cwd(), pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        ctx.print(`Managed settings bundle exported to ${targetPath}`);
        return;
      }

      const pathArg = args[1];
      if (!pathArg) {
        ctx.print(`Usage: /managed ${sub} <path>`);
        return;
      }
      const sourcePath = resolve(process.cwd(), pathArg);
      const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as ManagedSettingsBundle;

      if (sub === 'inspect') {
        ctx.print(inspectManagedSettingsBundle(bundle));
        return;
      }

      if (sub === 'apply') {
        for (const [key, value] of Object.entries(bundle.settings)) {
          const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
          if (!schema) continue;
          ctx.configManager.setDynamic(key as ConfigKey, value);
          if (key === 'provider.model') ctx.runtime.model = value as string;
          if (key === 'provider.provider') ctx.runtime.provider = value as string;
          if (key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = value as string;
        }
        ctx.print(`Managed settings bundle applied from ${sourcePath}`);
        return;
      }

      ctx.print('Usage: /managed [review|export <profile> <path>|inspect <path>|apply <path>]');
    },
  });
}
