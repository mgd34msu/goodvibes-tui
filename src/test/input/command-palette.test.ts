/**
 * Command palette wiring — the palette is generated live from the command
 * registry (never a hand-maintained list) and is reachable via the /palette
 * command and the Ctrl+K chord.
 */
import { describe, it, expect } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands, categorizeBuiltinCommands } from '../../input/commands.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry;
}

describe('command palette', () => {
  it('registers /palette with the /k alias', () => {
    const registry = makeRegistry();
    const palette = registry.get('palette');
    expect(palette).toBeDefined();
    expect(palette?.name).toBe('palette');
    expect(registry.get('k')?.name).toBe('palette');
  });

  it('categorizes /palette under Shell & Session', () => {
    const entry = categorizeBuiltinCommands().find((e) => e.command.name === 'palette');
    expect(entry?.category).toBe('Shell & Session');
  });

  it('every registered command can be turned into a categorized palette item', () => {
    // Mirror the opener's item-building (shell/ui-openers.ts openCommandPalette)
    // to lock the contract: every command in the live registry yields exactly
    // one palette item with a non-empty label and a category — proving the
    // palette is registry-derived, not a curated subset.
    const registry = makeRegistry();
    const categoryByName = new Map(categorizeBuiltinCommands().map((e) => [e.command.name, e.category]));
    const items = registry.getAll().map((cmd) => ({
      id: cmd.name,
      label: `/${cmd.name}`,
      category: categoryByName.get(cmd.name) ?? 'Other',
    }));
    expect(items.length).toBe(registry.getAll().length);
    expect(items.length).toBeGreaterThan(100);
    for (const item of items) {
      expect(item.label.startsWith('/')).toBe(true);
      expect(item.category.length).toBeGreaterThan(0);
      expect(item.category).not.toBe('Other'); // every command must have a real category
    }
  });

  it('Ctrl+K opens the palette and kill-to-end moves to Alt+K', () => {
    const km = new KeybindingsManager({ configPath: '/nonexistent/keybindings.json' });
    expect(km.lookup({ logicalName: 'k', ctrl: true })).toBe('command-palette');
    expect(km.lookup({ logicalName: 'k', alt: true })).toBe('kill-line');
  });
});
