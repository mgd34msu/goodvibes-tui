import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  applySettingsSyncBundle,
  clearManagedSettingLock,
  exportSettingsSyncBundle,
  formatResolvedSettingReview,
  resolveSettingsSyncConflict,
  formatStagedManagedBundleReview,
  formatSettingsControlPlaneReview,
  getSettingsControlPlaneSnapshot,
  inspectSettingsSyncBundle,
  recordSettingsSyncEvent,
  recordSettingsSyncFailure,
  setManagedSettingLock,
  type SettingsSyncBundle,
} from '../../runtime/settings/control-plane.ts';
import { type ConfigKey } from '../../config/index.ts';
import { CONFIG_KEYS } from '../../config/schema.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { openCommandPanel } from './runtime-services.ts';

export function registerSettingsSyncRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'settingssync',
    aliases: ['settings-sync'],
    description: 'Review sync posture, export/import settings-sync bundles, and open the settings sync workspace',
    usage: '[review|panel|show <key>|staged|conflicts|resolve <key> <local|synced>|failures|rollback-history|export <path>|inspect <path>|pull <path>|push <path>|lock <key> <source> <reason...>|unlock <key>]',
    handler(args, ctx) {
      const controlPlaneConfigDir = ctx.configManager.getControlPlaneConfigDir();
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'panel' || sub === 'open') {
        openCommandPanel(ctx, 'settings-sync');
        return;
      }
      if (sub === 'show') {
        const key = args[1] as ConfigKey | undefined;
        if (!key || !CONFIG_KEYS.has(key)) {
          ctx.print('Usage: /settingssync show <config-key>');
          return;
        }
        ctx.print(formatResolvedSettingReview(ctx.configManager, key));
        return;
      }
      if (sub === 'staged') {
        ctx.print(formatStagedManagedBundleReview(ctx.configManager));
        return;
      }
      if (sub === 'conflicts') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.configManager);
        ctx.print(snapshot.conflicts.length > 0
          ? [
              'Settings Sync Conflicts',
              ...snapshot.conflicts.map((conflict) => `  ${conflict.key}  source=${conflict.source}  path=${conflict.path}`),
            ].join('\n')
          : 'Settings Sync Conflicts\n  No settings conflicts recorded.');
        return;
      }
      if (sub === 'resolve') {
        const key = args[1] as ConfigKey | undefined;
        const resolution = (args[2] ?? '').toLowerCase();
        if (!key || !CONFIG_KEYS.has(key) || (resolution !== 'local' && resolution !== 'synced')) {
          ctx.print('Usage: /settingssync resolve <config-key> <local|synced>');
          return;
        }
        const changed = resolveSettingsSyncConflict(ctx.configManager, key, resolution);
        if (!changed) {
          ctx.print(`No synced conflict found for ${key}.`);
          return;
        }
        ctx.runtime.model = String(ctx.configManager.get('provider.model'));
        ctx.runtime.provider = String(ctx.configManager.get('provider.provider'));
        ctx.runtime.reasoningEffort = ctx.configManager.get('provider.reasoningEffort') as string;
        ctx.print(`Resolved synced conflict for ${key} using the ${resolution} value.`);
        return;
      }
      if (sub === 'failures') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.configManager);
        ctx.print(snapshot.recentFailures.length > 0
          ? [
              'Settings Sync Failures',
              ...snapshot.recentFailures.map((failure) => `  ${failure.surface}  ${failure.message}`),
            ].join('\n')
          : 'Settings Sync Failures\n  No recent sync or managed-setting failures recorded.');
        return;
      }
      if (sub === 'rollback-history') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.configManager);
        ctx.print(snapshot.rollbackHistory.length > 0
          ? [
              'Managed Rollback History',
              ...snapshot.rollbackHistory.map((entry) => (
                `  ${entry.token}  ${entry.profileName}  restored=${entry.restoredKeys.length}  ${new Date(entry.appliedAt).toLocaleString()}`
              )),
            ].join('\n')
          : 'Managed Rollback History\n  No managed apply rollback records yet.');
        return;
      }
      if (sub === 'export' || sub === 'push') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print(`Usage: /settingssync ${sub} <path>`);
          return;
        }
        const targetPath = resolve(process.cwd(), pathArg);
        const bundle = exportSettingsSyncBundle(ctx.configManager);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        recordSettingsSyncEvent({
          surface: 'settings-sync',
          direction: sub === 'push' ? 'push' : 'export',
          path: targetPath,
          timestamp: Date.now(),
          detail: `${Object.keys(bundle.settings).length} settings exported`,
        }, controlPlaneConfigDir);
        ctx.print(`Settings sync bundle exported to ${targetPath}`);
        return;
      }
      if (sub === 'inspect') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /settingssync inspect <path>');
          return;
        }
        const sourcePath = resolve(process.cwd(), pathArg);
        const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as SettingsSyncBundle;
        ctx.print(inspectSettingsSyncBundle(bundle));
        return;
      }
      if (sub === 'pull') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /settingssync pull <path>');
          return;
        }
        const sourcePath = resolve(process.cwd(), pathArg);
        try {
          const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as SettingsSyncBundle;
          const result = applySettingsSyncBundle(ctx.configManager, bundle, sourcePath);
          ctx.print(`Settings sync bundle pulled from ${sourcePath} (${result.appliedCount} applied, ${result.conflictCount} conflicts).`);
        } catch (error) {
          recordSettingsSyncFailure('settings-sync', (error as Error).message, controlPlaneConfigDir);
          ctx.print((error as Error).message);
        }
        return;
      }
      if (sub === 'lock') {
        const key = args[1] as ConfigKey | undefined;
        const source = args[2];
        const reason = args.slice(3).join(' ').trim();
        if (!key || !source || !reason || !CONFIG_KEYS.has(key)) {
          ctx.print('Usage: /settingssync lock <config-key> <source> <reason...>');
          return;
        }
        setManagedSettingLock(key, source, reason, controlPlaneConfigDir);
        ctx.print(`Managed lock recorded for ${key}.`);
        return;
      }
      if (sub === 'unlock') {
        const key = args[1] as ConfigKey | undefined;
        if (!key || !CONFIG_KEYS.has(key)) {
          ctx.print('Usage: /settingssync unlock <config-key>');
          return;
        }
        ctx.print(clearManagedSettingLock(key, controlPlaneConfigDir) ? `Managed lock cleared for ${key}.` : `No managed lock found for ${key}.`);
        return;
      }
      ctx.print(formatSettingsControlPlaneReview(ctx.configManager).join('\n'));
    },
  });
}
