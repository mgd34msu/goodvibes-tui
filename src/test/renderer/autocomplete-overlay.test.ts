import { describe, expect, test } from 'bun:test';
import { renderAutocompleteOverlay } from '../../renderer/autocomplete-overlay.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';

describe('renderAutocompleteOverlay', () => {
  test('keeps selected-row highlight inside intact box borders', () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'approval',
      description: 'Review action-specific approval classes and specialized security paths',
      handler: async (_args: string[], _ctx: CommandContext) => {},
    });
    registry.register({
      name: 'auth',
      description: 'Review auth posture and exchange session login tokens with local services',
      handler: async (_args: string[], _ctx: CommandContext) => {},
    });
    registry.register({
      name: 'bookmarks',
      description: 'List bookmarked blocks',
      handler: async (_args: string[], _ctx: CommandContext) => {},
    });

    const autocomplete = new AutocompleteEngine(registry);
    autocomplete.update('a');

    const width = 80;
    const lines = renderAutocompleteOverlay(autocomplete, width);

    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }

    const top = lines[0];
    const boxMargin = top.findIndex((cell) => cell.char === '┌');
    const rightX = top.findLastIndex((cell) => cell.char === '┐');
    expect(boxMargin).toBeGreaterThanOrEqual(0);
    expect(rightX).toBeGreaterThan(boxMargin);

    const bottom = lines[lines.length - 1];
    expect(bottom[boxMargin].char).toBe('└');
    expect(bottom[rightX].char).toBe('┘');

    const selectedRow = lines[2];
    expect(selectedRow[boxMargin].char).toBe('│');
    expect(selectedRow[boxMargin].bg).toBe('');
    expect(selectedRow[rightX].char).toBe('│');
    expect(selectedRow[rightX].bg).toBe('');
    expect(selectedRow[boxMargin + 1].bg).toBe('#103040');
    expect(selectedRow[rightX - 1].bg).toBe('#103040');
    expect(selectedRow[boxMargin + 1].char).not.toBe('│');
    expect(selectedRow[rightX - 1].char).not.toBe('│');
  });
});
