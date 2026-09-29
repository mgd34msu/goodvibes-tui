import { describe, expect, test } from 'bun:test';
import { renderAutocompleteOverlay } from '../../renderer/autocomplete-overlay.ts';
import { POPUP_BAR_X } from '../../renderer/surface-kit-parts.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';

describe('renderAutocompleteOverlay', () => {
  test('draws a composer popup: ┃ bar on every row, surface fill, gradient selected row, no frame', () => {
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
    const t = activeTokens();

    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line.length).toBe(width);
      // The ┃ bar runs the popup's full height, the fill starts right of it.
      expect(line[POPUP_BAR_X]!.char).toBe('┃');
      expect(line[POPUP_BAR_X + 1]!.bg).not.toBe('');
      // No box-drawing frame anywhere.
      expect(line.some((cell) => '┌┐└┘│─'.includes(cell.char) && cell.char !== '')).toBe(false);
    }
    // Padding rows above and below the list.
    expect(lines[0]!.slice(POPUP_BAR_X + 1).every((cell) => cell.char === ' ')).toBe(true);
    expect(lines[lines.length - 1]!.slice(POPUP_BAR_X + 1).every((cell) => cell.char === ' ')).toBe(true);
    // The selected row carries the gradient across the fill with dark bold text.
    const selectedRow = lines[1]!;
    expect(selectedRow[POPUP_BAR_X + 1]!.bg).toBe(t.brand);
    const nameCell = selectedRow[POPUP_BAR_X + 3]!;
    expect(nameCell.char).toBe('/');
    expect(nameCell.fg).toBe(t.selectedListItemText);
    expect(nameCell.bold).toBe(true);
    expect(lines.map((line) => line.map((c) => c.char).join('')).join('\n')).toContain('tab complete');
  });

  function flatten(lines: ReturnType<typeof renderAutocompleteOverlay>): string {
    return lines
      .map((line) => line.map((cell) => cell.char).join(''))
      .join(' ')
      .replace(/[│┌┐└┘├┤┬┴┼─▸┃]/g, ' ')
      // The selected row's right-aligned "tab complete" sits on the first
      // line of its wrapped description; it is not part of the description.
      .replace(/tab complete/g, ' ')
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
