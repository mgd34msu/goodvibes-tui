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
} from '@/runtime/index.ts';
import { getProviderIdFromModel } from '@pellux/goodvibes-sdk/platform/providers';
import { type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { CONFIG_KEYS } from '@pellux/goodvibes-sdk/platform/config';
import type { CommandRegistry } from '../command-registry.ts';
import { openCommandPanel, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export function registerSettingsSyncRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'settings-sync',
    aliases: ['settingssync'],
    description: 'Open the settings sync modal (bare); review posture, export/import bundles, or resolve conflicts by subcommand',
    usage: '[panel|report|review|show <key>|staged|conflicts|resolve <key> <local|synced>|failures|rollback-history|export <path>|inspect <path>|pull <path>|push <path>|lock <key> <source> <reason...>|unlock <key>]: bare opens the modal',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const controlPlaneConfigDir = ctx.platform.configManager.getControlPlaneConfigDir();
      const sub = (args[0] ?? '').toLowerCase();
      // item 3 (report-vs-modal front doors): settings-sync has a full
      // modal surface (settings-sync-modal), so the bare command now opens it
      //, the old bare/`review` transcript report moved to an explicit
      // `report` subcommand (scriptability preserved: /settings-sync report).
      if (sub === '') {
        ctx.openModal?.('settings-sync-modal');
        return;
      }
      if (sub === 'panel' || sub === 'open') {
        ctx.openModal?.('settings-sync-modal'); // settings-sync panel -> config modal
        return;
      }
      if (sub === 'report' || sub === 'review') {
        ctx.print(formatSettingsControlPlaneReview(ctx.platform.configManager).join('\n'));
        return;
      }
      if (sub === 'show') {
        const key = args[1] as ConfigKey | undefined;
        if (!key || !CONFIG_KEYS.has(key)) {
          ctx.print('Usage: /settings-sync show <config-key>');
          return;
        }
        ctx.print(formatResolvedSettingReview(ctx.platform.configManager, key));
        return;
      }
      if (sub === 'staged') {
        ctx.print(formatStagedManagedBundleReview(ctx.platform.configManager));
        return;
      }
      if (sub === 'conflicts') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
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
          ctx.print('Usage: /settings-sync resolve <config-key> <local|synced>');
          return;
        }
        const changed = resolveSettingsSyncConflict(ctx.platform.configManager, key, resolution);
        if (!changed) {
          ctx.print(`No synced conflict found for ${key}.`);
          return;
        }
        ctx.session.runtime.model = String(ctx.platform.configManager.get('provider.model'));
        ctx.session.runtime.provider = getProviderIdFromModel(ctx.platform.configManager.get('provider.model'));
        ctx.session.runtime.reasoningEffort = ctx.platform.configManager.get('provider.reasoningEffort') as string;
        ctx.print(`Resolved synced conflict for ${key} using the ${resolution} value.`);
        return;
      }
      if (sub === 'failures') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
        ctx.print(snapshot.recentFailures.length > 0
          ? [
              'Settings Sync Failures',
              ...snapshot.recentFailures.map((failure) => `  ${failure.surface}  ${failure.message}`),
            ].join('\n')
          : 'Settings Sync Failures\n  No recent sync or managed-setting failures recorded.');
        return;
      }
      if (sub === 'rollback-history') {
        const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
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
          ctx.print(`Usage: /settings-sync ${sub} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        const bundle = exportSettingsSyncBundle(ctx.platform.configManager);
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
          ctx.print('Usage: /settings-sync inspect <path>');
          return;
        }
        const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
        const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as SettingsSyncBundle;
        ctx.print(inspectSettingsSyncBundle(bundle));
        return;
      }
      if (sub === 'pull') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /settings-sync pull <path>');
          return;
        }
        const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
        try {
          const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as SettingsSyncBundle;
          const result = applySettingsSyncBundle(ctx.platform.configManager, bundle, sourcePath);
          ctx.print(`Settings sync bundle pulled from ${sourcePath} (${result.appliedCount} applied, ${result.conflictCount} conflicts).`);
        } catch (error) {
          recordSettingsSyncFailure('settings-sync', summarizeError(error), controlPlaneConfigDir);
          ctx.print(summarizeError(error));
        }
        return;
      }
      if (sub === 'lock') {
        const key = args[1] as ConfigKey | undefined;
        const source = args[2];
        const reason = args.slice(3).join(' ').trim();
        if (!key || !source || !reason || !CONFIG_KEYS.has(key)) {
          ctx.print('Usage: /settings-sync lock <config-key> <source> <reason...>');
          return;
        }
        setManagedSettingLock(key, source, reason, controlPlaneConfigDir);
        ctx.print(`Managed lock recorded for ${key}.`);
        return;
      }
      if (sub === 'unlock') {
        const key = args[1] as ConfigKey | undefined;
        if (!key || !CONFIG_KEYS.has(key)) {
          ctx.print('Usage: /settings-sync unlock <config-key>');
          return;
        }
        ctx.print(clearManagedSettingLock(key, controlPlaneConfigDir) ? `Managed lock cleared for ${key}.` : `No managed lock found for ${key}.`);
        return;
      }
      ctx.print(formatSettingsControlPlaneReview(ctx.platform.configManager).join('\n'));
    },
  });
}
