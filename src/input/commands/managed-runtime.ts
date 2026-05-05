import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { profileDataToConfigSnapshot } from '@pellux/goodvibes-sdk/platform/profiles';
import { CONFIG_SCHEMA, type ConfigKey } from '../../config/index.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import { CONFIG_KEYS } from '@pellux/goodvibes-sdk/platform/config';
import type { ManagedSettingsBundle } from '@/runtime/index.ts';
import {
  applyStagedManagedBundle,
  clearManagedSettingLock,
  formatStagedManagedBundleReview,
  getSettingsControlPlaneSnapshot,
  inspectManagedSettingsBundle,
  recordSettingsSyncEvent,
  recordSettingsSyncFailure,
  rollbackManagedApply,
  setManagedSettingLock,
  stageManagedSettingsBundle,
} from '@/runtime/index.ts';
import { requireProfileManager, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

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

export function registerManagedRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'managed',
    description: 'Export, inspect, and apply managed settings bundles',
    usage: '[review|staged|rollback-history|export <profile> <path>|inspect <path>|stage <path>|apply <path> [key ...]|apply-staged [key ...]|rollback <token>|lock <key> <source> <reason...>|unlock <key>]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const controlPlaneConfigDir = ctx.platform.configManager.getControlPlaneConfigDir();
      const sub = args[0] ?? 'review';
      const pm = requireProfileManager(ctx);
      if (sub === 'review') {
        const profiles = pm.list();
        const snapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
        ctx.print([
          'Managed Settings Review',
          `  saved profiles: ${profiles.length}`,
          `  live config keys: ${Object.keys(buildConfigSnapshot(ctx.platform.configManager)).length}`,
          `  staged bundle: ${snapshot.stagedManagedBundle ? snapshot.stagedManagedBundle.profileName : 'none'}`,
          `  active locks: ${snapshot.managedLockCount}`,
          `  rollback records: ${snapshot.rollbackHistory.length}`,
        ].join('\n'));
        return;
      }

      if (sub === 'staged') {
        ctx.print(formatStagedManagedBundleReview(ctx.platform.configManager));
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
          : 'Managed Rollback History\n  No managed rollback records yet.');
        return;
      }

      if (sub === 'lock') {
        const key = args[1] as ConfigKey | undefined;
        const source = args[2];
        const reason = args.slice(3).join(' ').trim();
        if (!key || !source || !reason) {
          ctx.print('Usage: /managed lock <key> <source> <reason...>');
          return;
        }
        setManagedSettingLock(key, source, reason, controlPlaneConfigDir);
        ctx.print(`Managed lock recorded for ${key}.`);
        return;
      }

      if (sub === 'unlock') {
        const key = args[1] as ConfigKey | undefined;
        if (!key) {
          ctx.print('Usage: /managed unlock <key>');
          return;
        }
        ctx.print(clearManagedSettingLock(key, controlPlaneConfigDir) ? `Managed lock cleared for ${key}.` : `No managed lock found for ${key}.`);
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
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        recordSettingsSyncEvent({
          surface: 'managed',
          direction: 'export',
          path: targetPath,
          timestamp: Date.now(),
          detail: `${Object.keys(bundle.settings).length} settings exported from ${profileName}`,
        }, controlPlaneConfigDir);
        ctx.print(`Managed settings bundle exported to ${targetPath}`);
        return;
      }

      if (sub === 'apply-staged') {
        const requestedKeys = args.slice(1).filter((value): value is ConfigKey => CONFIG_KEYS.has(value as ConfigKey));
        const invalidKeys = args.slice(1).filter((value) => !CONFIG_KEYS.has(value as ConfigKey));
        if (invalidKeys.length > 0) {
          ctx.print(`Unknown config key(s): ${invalidKeys.join(', ')}`);
          return;
        }
        try {
          const result = applyStagedManagedBundle(ctx.platform.configManager, requestedKeys);
          ctx.session.runtime.model = String(ctx.platform.configManager.get('provider.model'));
          ctx.session.runtime.provider = getProviderIdFromModel(ctx.platform.configManager.get('provider.model'));
          ctx.session.runtime.reasoningEffort = ctx.platform.configManager.get('provider.reasoningEffort') as string;
          ctx.print(`Staged managed settings applied (${result.appliedCount} changes, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).`);
        } catch (error) {
          recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
          ctx.print(summarizeError(error));
        }
        return;
      }

      if (sub === 'rollback') {
        const token = args[1];
        if (!token) {
          ctx.print('Usage: /managed rollback <token>');
          return;
        }
        try {
          const restored = rollbackManagedApply(ctx.platform.configManager, token);
          ctx.session.runtime.model = String(ctx.platform.configManager.get('provider.model'));
          ctx.session.runtime.provider = getProviderIdFromModel(ctx.platform.configManager.get('provider.model'));
          ctx.session.runtime.reasoningEffort = ctx.platform.configManager.get('provider.reasoningEffort') as string;
          ctx.print(`Managed rollback ${token} restored ${restored} setting(s).`);
        } catch (error) {
          recordSettingsSyncFailure('managed', summarizeError(error), controlPlaneConfigDir);
          ctx.print(summarizeError(error));
        }
        return;
      }

      const pathArg = args[1];
      if (!pathArg) {
        ctx.print(`Usage: /managed ${sub} <path>`);
        return;
      }
      const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
      const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as ManagedSettingsBundle;

      if (sub === 'inspect') {
        ctx.print(inspectManagedSettingsBundle(ctx.platform.configManager, bundle, sourcePath));
        return;
      }

      if (sub === 'stage') {
        const stage = stageManagedSettingsBundle(ctx.platform.configManager, bundle, sourcePath);
        ctx.print(`Managed settings bundle staged from ${sourcePath} (${stage.changeCount} changes, risk=${stage.risk}).`);
        return;
      }

      if (sub === 'apply') {
        const requestedKeys = args.slice(2).filter((value): value is ConfigKey => CONFIG_KEYS.has(value as ConfigKey));
        const invalidKeys = args.slice(2).filter((value) => !CONFIG_KEYS.has(value as ConfigKey));
        if (invalidKeys.length > 0) {
          ctx.print(`Unknown config key(s): ${invalidKeys.join(', ')}`);
          return;
        }
        stageManagedSettingsBundle(ctx.platform.configManager, bundle, sourcePath);
        const result = applyStagedManagedBundle(ctx.platform.configManager, requestedKeys);
        ctx.session.runtime.model = String(ctx.platform.configManager.get('provider.model'));
        ctx.session.runtime.provider = getProviderIdFromModel(ctx.platform.configManager.get('provider.model'));
        ctx.session.runtime.reasoningEffort = ctx.platform.configManager.get('provider.reasoningEffort') as string;
        ctx.print(`Managed settings bundle applied from ${sourcePath} (${result.appliedCount} changes, rollback ${result.rollbackToken}${result.remainingCount > 0 ? `, ${result.remainingCount} still staged` : ''}).`);
        return;
      }

      recordSettingsSyncFailure('managed', `unsupported subcommand: ${sub}`, controlPlaneConfigDir);
      ctx.print('Usage: /managed [review|staged|rollback-history|export <profile> <path>|inspect <path>|stage <path>|apply <path> [key ...]|apply-staged [key ...]|rollback <token>|lock <key> <source> <reason...>|unlock <key>]');
    },
  });
}
