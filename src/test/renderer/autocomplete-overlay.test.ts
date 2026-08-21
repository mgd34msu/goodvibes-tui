import { describe, expect, test } from 'bun:test';
import { renderAutocompleteOverlay } from '../../renderer/autocomplete-overlay.ts';
import { DEFAULT_OVERLAY_PALETTE } from '../../renderer/overlay-box.ts';
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
    expect(selectedRow[boxMargin + 1].bg).toBe(DEFAULT_OVERLAY_PALETTE.selectedBg);
    expect(selectedRow[rightX - 1].bg).toBe(DEFAULT_OVERLAY_PALETTE.selectedBg);
    expect(selectedRow[boxMargin + 1].char).not.toBe('│');
    expect(selectedRow[rightX - 1].char).not.toBe('│');
  });

  function flatten(lines: ReturnType<typeof renderAutocompleteOverlay>): string {
    return lines
      .map((line) => line.map((cell) => cell.char).join(''))
      .join(' ')
      .replace(/[│┌┐└┘├┤┬┴┼─▸]/g, ' ')
      .replace(/\s+/g, ' ');
  }

  // Owner design test (v1.16.1 modal rule, extended here): UI-authored
  // descriptive text is always shown in full, wrap or scroll, never clip.
  // Full strings, not prefixes: a facade assertion that only checks the first
  // few words would stay green even if everything after them were clipped.
  test('a description too long for its column wraps onto its own line(s) in full, never clipped, at 80x24 and 60-col', () => {
    const registry = new CommandRegistry();
    const longDescription = 'Review action-specific approval classes, specialized security paths, per-project override rules, and every remembered decision recorded for this workspace so far';
    registry.register({
      name: 'approval',
      description: longDescription,
      handler: async (_args: string[], _ctx: CommandContext) => {},
    });

    for (const width of [80, 60]) {
      const autocomplete = new AutocompleteEngine(registry);
      autocomplete.update('a');
      const text = flatten(renderAutocompleteOverlay(autocomplete, width, 24));
      expect(text).toContain(longDescription);
    }
  });

  test('the selected item is always shown in full even when other rows must scroll off, at 80x24 and 60-col', () => {
    const registry = new CommandRegistry();
    const longDescription = 'Explains exactly why a tool or command would be allowed, asked for confirmation, or denied outright under the currently active permission mode and every custom rule layered on top of it';
    const names = ['alpha', 'alpha-two', 'alpha-three', 'alpha-four', 'alpha-five', 'alpha-six'];
    for (const name of names) {
      registry.register({
        name,
        description: name === 'alpha-four' ? longDescription : `Short description for ${name}`,
        handler: async (_args: string[], _ctx: CommandContext) => {},
      });
    }

    for (const width of [80, 60]) {
      const autocomplete = new AutocompleteEngine(registry);
      autocomplete.update('alpha');
      // Select the entry with the long description.
      for (let i = 0; i < names.length && autocomplete.getSelected()?.name !== 'alpha-four'; i += 1) {
        autocomplete.moveDown();
      }
      expect(autocomplete.getSelected()?.name).toBe('alpha-four');
      const text = flatten(renderAutocompleteOverlay(autocomplete, width, 24));
      expect(text).toContain(longDescription);
    }
  });

  test('a short description that already fits renders inline on the command row (no unnecessary wrap)', () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'bookmarks',
      description: 'List bookmarked blocks',
      handler: async (_args: string[], _ctx: CommandContext) => {},
    });
    const autocomplete = new AutocompleteEngine(registry);
    autocomplete.update('bookmarks');
    const lines = renderAutocompleteOverlay(autocomplete, 80, 24);
    const rowText = lines
      .map((line) => line.map((cell) => cell.char).join(''))
      .find((line) => line.includes('List bookmarked blocks'));
    expect(rowText).toBeDefined();
    // Inline means the command name and its description share one physical
    // row rather than the description wrapping onto a line of its own.
    expect(rowText).toContain('/bookmarks');
  });
});
