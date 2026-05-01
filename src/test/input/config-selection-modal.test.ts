import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config/schema';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { SecretsManager } from '../../config/secrets.ts';

function makeConfigManager(dir: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: dir,
    configDir: join(dir, '.goodvibes', 'tui'),
  });
}

function makeContext(dir: string): {
  ctx: CommandContext;
  calls: {
    printed: string[];
    settingsTargets: Array<string | undefined>;
  };
} {
  const cm = makeConfigManager(dir);
  const calls = {
    printed: [] as string[],
    settingsTargets: [] as Array<string | undefined>,
  };
  const ctx = {
    session: {
      conversationManager: {} as never,
      runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
    },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: {
      config: cm.getAll(),
      configManager: cm,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    renderRequest: () => {},
    print: (text: string) => { calls.printed.push(text); },
    exit: () => {},
    openSettingsModal: (target?: string) => {
      calls.settingsTargets.push(target);
    },
  } as unknown as CommandContext;
  return { ctx, calls };
}

describe('/config fullscreen workspace command', () => {
  test('/config opens the fullscreen configuration workspace at an optional target', async () => {
    const dir = join(tmpdir(), `gv-config-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerConfigCommand(registry);

      const command = registry.get('config');
      expect(command).toBeDefined();
      expect(registry.get('cfg')).toBe(command);
      expect(registry.get('config-old')).toBeUndefined();
      expect(registry.get('cfg-old')).toBeUndefined();

      const { ctx, calls } = makeContext(dir);
      await command!.handler(['surfaces.homeassistant.instanceUrl'], ctx);

      expect(calls.settingsTargets).toEqual(['surfaces.homeassistant.instanceUrl']);
      expect(calls.printed).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fullscreen workspace includes every SDK config key previously reachable through raw config', () => {
    const dir = join(tmpdir(), `gv-config-coverage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const cm = makeConfigManager(dir);
      const modal = new SettingsModal();
      const subscriptions = new SubscriptionManager(join(dir, '.goodvibes', 'tui', 'subscriptions.json'));
      const services = new ServiceRegistry(join(dir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: dir, globalHome: dir, configManager: cm }),
        subscriptionManager: subscriptions,
      });

      modal.open(cm, createFeatureFlagManager(), subscriptions, services);

      const workspaceKeys = new Set<string>();
      for (const entries of modal.groups.values()) {
        for (const entry of entries) workspaceKeys.add(entry.setting.key);
      }

      expect(CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => !workspaceKeys.has(key))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
