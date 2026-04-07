import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { getProfileManager } from '../../profiles/manager.ts';
import type { ProfileBundleEntry, ProfileSyncBundle } from '../../runtime/sandbox/types.ts';

function inspectProfileSyncBundle(bundle: ProfileSyncBundle): string {
  return [
    'Profile Sync Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  profiles: ${bundle.profiles.length}`,
    `  activeProfile: ${bundle.activeProfile ?? '(none)'}`,
  ].join('\n');
}

export function registerProfileSyncRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'profilesync',
    description: 'Export, import, and inspect profile sync bundles',
    usage: '[list|export <path>|inspect <path>|import <path> [prefix]]',
    handler(args, ctx) {
      const sub = args[0] ?? 'list';
      const pm = getProfileManager();
      if (sub === 'list') {
        const profiles = pm.list();
        ctx.print(
          profiles.length > 0
            ? ['Profile Sync', ...profiles.map((profile) => `  ${profile.name}  ${new Date(profile.timestamp).toISOString()}`)].join('\n')
            : 'Profile Sync\n  No profiles saved yet.',
        );
        return;
      }

      const pathArg = args[1];
      if (!pathArg) {
        ctx.print(`Usage: /profilesync ${sub} <path>${sub === 'import' ? ' [prefix]' : ''}`);
        return;
      }
      const targetPath = resolve(process.cwd(), pathArg);

      if (sub === 'export') {
        const profiles = pm.list().map((profile) => {
          const loaded = pm.load(profile.name);
          return {
            name: profile.name,
            timestamp: loaded.timestamp,
            data: loaded.data,
          } satisfies ProfileBundleEntry;
        });
        const bundle: ProfileSyncBundle = {
          version: 1,
          exportedAt: Date.now(),
          profiles,
        };
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        ctx.print(`Profile sync bundle exported to ${targetPath}`);
        return;
      }

      if (sub === 'inspect') {
        const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as ProfileSyncBundle;
        ctx.print(inspectProfileSyncBundle(bundle));
        return;
      }

      if (sub === 'import') {
        const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as ProfileSyncBundle;
        const prefix = args[2]?.trim() ?? '';
        for (const entry of bundle.profiles) {
          const name = prefix ? `${prefix}-${entry.name}` : entry.name;
          pm.save(name, entry.data);
        }
        ctx.print(`Profile sync bundle imported from ${targetPath}`);
        return;
      }

      ctx.print('Usage: /profilesync [list|export <path>|inspect <path>|import <path> [prefix]]');
    },
  });
}
