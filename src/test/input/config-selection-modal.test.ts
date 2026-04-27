import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../../config/secrets.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { createShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type { SelectionAction, SelectionItem, SelectionResult } from '../../input/selection-modal.ts';

function makeContext(dir: string): {
  ctx: CommandContext;
  cm: ConfigManager;
  calls: {
    printed: string[];
    renders: number;
    selection?: {
      items: SelectionItem[];
      callback: (result: SelectionResult | null) => void;
      opts?: { customActions?: Map<string, SelectionAction> };
    };
  };
} {
  const cm = new ConfigManager({ surfaceRoot: 'tui',
    workingDir: dir,
    configDir: join(dir, '.goodvibes', 'tui'),
  });
  const secretsManager = new SecretsManager({ projectRoot: dir, globalHome: dir, configManager: cm });
  const calls: {
    printed: string[];
    renders: number;
    selection?: {
      items: SelectionItem[];
      callback: (result: SelectionResult | null) => void;
      opts?: { customActions?: Map<string, SelectionAction> };
    };
  } = {
    printed: [],
    renders: 0,
  };
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const ctx = {
    session: {
      conversationManager,
      runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths: createShellPathService({
        workingDirectory: dir,
        homeDirectory: dir,
      }),
    },
    platform: {
      config: cm.getAll(),
      configManager: cm,
      secretsManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    renderRequest: () => { calls.renders++; },
    print: (text: string) => { calls.printed.push(text); },
    exit: () => {},
    openSelection: (
      title: string,
      items: SelectionItem[],
      opts: { customActions?: Map<string, SelectionAction> } | undefined,
      callback: (result: SelectionResult | null) => void,
    ) => {
      void title;
      calls.selection = { items, opts, callback };
    },
  } as unknown as CommandContext;
  return { ctx, cm, calls };
}

describe('/config selection modal', () => {
  test('uses a toggle-style modal contract for toggleable settings', async () => {
    const dir = join(tmpdir(), `gv-config-selection-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerConfigCommand(registry);
      const command = registry.get('config');
      expect(command).toBeDefined();

      const { ctx, cm, calls } = makeContext(dir);
      await command!.handler([], ctx);

      expect(calls.selection).toBeDefined();
      const item = calls.selection!.items.find((entry) => entry.id === 'display.stream');
      expect(item).toBeDefined();
      expect(item?.primaryAction).toBe('toggle');
      expect(item?.actions).toContain('toggle');

      const before = cm.get('display.stream') as boolean;
      calls.selection!.callback({ item: item!, action: 'toggle' });
      expect(cm.get('display.stream')).toBe(!before);
      expect(calls.renders).toBe(1);
      expect(calls.printed).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses decimal stepping metadata for wrfc score threshold and clamps updates', async () => {
    const dir = join(tmpdir(), `gv-config-selection-wrfc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerConfigCommand(registry);
      const command = registry.get('config');
      expect(command).toBeDefined();

      const { ctx, cm, calls } = makeContext(dir);
      await command!.handler([], ctx);

      const item = calls.selection!.items.find((entry) => entry.id === 'wrfc.scoreThreshold');
      expect(item).toBeDefined();
      expect(item?.adjustable).toBe(true);
      expect(item?.adjustStep).toBe(0.1);
      expect(item?.adjustMin).toBe(0);
      expect(item?.adjustMax).toBe(10);
      expect(item?.adjustPrecision).toBe(1);

      calls.selection!.callback({ item: item!, action: 'increment', step: 0.1 });
      expect(cm.get('wrfc.scoreThreshold')).toBe(10);

      calls.selection!.callback({ item: item!, action: 'increment', step: 0.1 });
      expect(cm.get('wrfc.scoreThreshold')).toBe(10);

      calls.selection!.callback({ item: item!, action: 'decrement', step: 1 });
      expect(cm.get('wrfc.scoreThreshold')).toBe(9);
      expect(calls.printed).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prints Home Assistant surface keys and stores direct secret edits through goodvibes refs', async () => {
    const dir = join(tmpdir(), `gv-config-homeassistant-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerConfigCommand(registry);
      const command = registry.get('config');
      expect(command).toBeDefined();

      const { ctx, cm, calls } = makeContext(dir);
      await command!.handler(['surfaces'], ctx);
      expect(calls.printed.at(-1)).toContain('surfaces.homeassistant.instanceUrl');
      expect(calls.printed.at(-1)).toContain('surfaces.homeassistant.accessToken');

      await command!.handler(['surfaces.homeassistant.accessToken', 'ha-long-lived-token'], ctx);
      const secretKey = buildGoodVibesSecretKey('surfaces.homeassistant.accessToken');
      expect(cm.get('surfaces.homeassistant.accessToken')).toBe(buildGoodVibesSecretRef(secretKey));
      expect(await ctx.platform.secretsManager!.get(secretKey)).toBe('ha-long-lived-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
