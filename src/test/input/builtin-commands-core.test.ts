import { describe, expect, test } from 'bun:test';

import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { categorizeBuiltinCommands, registerBuiltinCommands } from '../../input/commands.ts';
import type { SelectionItem } from '../../input/selection-modal.ts';

describe('input/registerBuiltinCommands shell core extraction', () => {
  test('registers the extracted shell core commands', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('model')?.name).toBe('model');
    expect(registry.get('help')?.name).toBe('help');
    expect(registry.get('clear')?.name).toBe('clear');
    expect(registry.get('compact')?.name).toBe('compact');
    expect(registry.get('paste')?.name).toBe('paste');
    expect(registry.get('clip')?.name).toBe('paste');
    expect(registry.get('quit')?.name).toBe('quit');
    expect(registry.get('wq')?.name).toBe('wq');
    expect(registry.get('effort')?.name).toBe('effort');
    expect(registry.get('lines')).toBeUndefined();
  });
});

describe('/help: generated live from the command registry', () => {
  function fullRegistry(): CommandRegistry {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    return registry;
  }

  test('the modal lists EVERY registered command with its real description and reference category', async () => {
    const registry = fullRegistry();
    let captured: { title: string; items: SelectionItem[] } | null = null;
    const categoryByName = new Map(categorizeBuiltinCommands().map((entry) => [entry.command.name, entry.category]));
    const ctx = {
      openSelection: (title: string, items: SelectionItem[]) => {
        captured = { title, items };
      },
      getCommandCategories: () => categoryByName,
      print: () => {},
    } as unknown as CommandContext;

    await registry.get('help')!.handler([], ctx);

    expect(captured).not.toBeNull();
    const { items } = captured!;
    const registered = registry.getAll();
    // Complete: one row per registered command, no hand-maintained subset.
    expect(items).toHaveLength(registered.length);
    expect(new Set(items.map((item) => item.id))).toEqual(new Set(registered.map((cmd) => cmd.name)));
    for (const item of items) {
      const command = registry.get(item.id)!;
      // Every row shows the command's REAL registered description...
      expect(item.detail).toContain(command.description);
      expect(item.label.startsWith(`/${command.name}`)).toBe(true);
      // ...and its category from the generated-reference source of truth.
      expect(item.category).toBe(categoryByName.get(command.name)!);
    }
  });

  test('without a modal capability, the printed fallback still lists every command with its description', async () => {
    const registry = fullRegistry();
    const printed: string[] = [];
    const ctx = { print: (line: string) => printed.push(line) } as unknown as CommandContext;

    await registry.get('help')!.handler([], ctx);

    const text = printed.join('\n');
    for (const command of registry.getAll()) {
      expect(text).toContain(`/${command.name}`);
      expect(text).toContain(command.description);
    }
  });

  test('picking a row runs that command', async () => {
    const registry = fullRegistry();
    const executed: Array<{ name: string; args: string[] }> = [];
    const ctx = {
      openSelection: (
        _title: string,
        items: SelectionItem[],
        _opts: unknown,
        callback: (result: { item: SelectionItem } | null) => void,
      ) => {
        const target = items.find((item) => item.id === 'clear')!;
        callback({ item: target });
      },
      executeCommand: async (name: string, args: string[]) => {
        executed.push({ name, args });
        return true;
      },
      getCommandCategories: () => new Map<string, string>(),
      print: () => {},
    } as unknown as CommandContext;

    await registry.get('help')!.handler([], ctx);

    expect(executed).toEqual([{ name: 'clear', args: [] }]);
  });
});
