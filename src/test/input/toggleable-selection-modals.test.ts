import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '../../config/manager.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
import { registerPermissionsRuntimeCommands } from '../../input/commands/permissions-runtime.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';
import type { SelectionAction, SelectionItem, SelectionResult } from '../../input/selection-modal.ts';

function makeContext(dir: string): {
  ctx: CommandContext;
  cm: ConfigManager;
  calls: {
    printed: string[];
    renders: number;
    selection?: {
      title: string;
      items: SelectionItem[];
      callback: (result: SelectionResult | null) => void;
      opts?: { customActions?: Map<string, SelectionAction> };
    };
  };
} {
  const cm = new ConfigManager({
    workingDir: dir,
    configDir: join(dir, '.goodvibes', 'tui'),
  });
  const calls: {
    printed: string[];
    renders: number;
    selection?: {
      title: string;
      items: SelectionItem[];
      callback: (result: SelectionResult | null) => void;
      opts?: { customActions?: Map<string, SelectionAction> };
    };
  } = {
    printed: [],
    renders: 0,
  };
  const ctx = ({
    providerRegistry: {
      getCurrentModel: () => ({ displayName: 'test', reasoningEffort: [], capabilities: { multimodal: false } }),
      getSelectableModels: () => [],
    },
    conversationManager: {} as never,
    config: cm.getAll(),
    configManager: cm,
    runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
    renderRequest: () => { calls.renders++; },
    print: (text: string) => { calls.printed.push(text); },
    exit: () => {},
    toolRegistry: { list: () => [] },
    mcpRegistry: {} as never,
    openSelection: (
      title: string,
      items: SelectionItem[],
      opts: { customActions?: Map<string, SelectionAction> } | undefined,
      callback: (result: SelectionResult | null) => void,
    ) => {
      calls.selection = { title, items, opts, callback };
    },
  } as unknown) as CommandContext;
  return { ctx, cm, calls };
}

describe('toggleable selection modals', () => {
  test('/config uses per-item toggle actions for toggleable settings', async () => {
    const dir = join(tmpdir(), `gv-toggle-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerConfigCommand(registry);
      const command = registry.get('config');
      expect(command).toBeDefined();
      const { ctx, cm, calls } = makeContext(dir);

      await command!.handler([], ctx);

      const streamItem = calls.selection!.items.find((entry) => entry.id === 'display.stream');
      expect(streamItem?.primaryAction).toBe('toggle');
      expect(streamItem?.adjustable).toBe(true);
      const modelItem = calls.selection!.items.find((entry) => entry.id === 'provider.model');
      expect(modelItem?.primaryAction).toBe('select');

      const before = cm.get('display.stream');
      calls.selection!.callback({ item: streamItem!, action: 'toggle' });
      expect(cm.get('display.stream')).toBe(!before);
      expect(calls.printed).toHaveLength(0);
      expect(calls.renders).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/permissions opens a toggle modal for every entry', async () => {
    const dir = join(tmpdir(), `gv-toggle-permissions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerPermissionsRuntimeCommands(registry);
      const command = registry.get('permissions');
      expect(command).toBeDefined();
      const { ctx, cm, calls } = makeContext(dir);

      await command!.handler([], ctx);

      expect(calls.selection).toBeDefined();
      expect(calls.selection!.items.every((item) => item.primaryAction === 'toggle')).toBe(true);
      expect(calls.selection!.items.every((item) => item.adjustable === true)).toBe(true);
      const modeItem = calls.selection!.items.find((entry) => entry.id === '__mode__');
      expect(modeItem?.actions).toContain('Space/Enter');

      const before = cm.get('permissions.mode');
      calls.selection!.callback({ item: modeItem!, action: 'toggle' });
      expect(cm.get('permissions.mode')).not.toBe(before);
      expect(calls.printed).toHaveLength(0);
      expect(calls.renders).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/danger opens a toggle modal for its boolean rows', async () => {
    const dir = join(tmpdir(), `gv-toggle-danger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = new CommandRegistry();
      registerLocalRuntimeCommands(registry);
      const command = registry.get('danger');
      expect(command).toBeDefined();
      const { ctx, cm, calls } = makeContext(dir);

      await command!.handler([], ctx);

      const daemonItem = calls.selection!.items.find((entry) => entry.id === 'danger.daemon');
      expect(daemonItem?.primaryAction).toBe('toggle');
      expect(daemonItem?.adjustable).toBe(true);
      expect(daemonItem?.actions).toContain('Space/Enter');

      expect(calls.selection!.items.every((entry) => entry.primaryAction === 'toggle')).toBe(true);

      const before = cm.get('danger.daemon');
      calls.selection!.callback({ item: daemonItem!, action: 'toggle' });
      expect(cm.get('danger.daemon')).toBe(!before);
      expect(calls.printed).toHaveLength(0);
      expect(calls.renders).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
