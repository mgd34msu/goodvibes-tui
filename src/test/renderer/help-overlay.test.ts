/**
 * Tests for renderHelpOverlay and renderShortcutsOverlay (modal surface kit).
 */
import { describe, test, expect } from 'bun:test';
import { renderHelpOverlay, renderShortcutsOverlay } from '../../renderer/help-overlay.ts';
import type { SlashCommand } from '../../input/command-registry.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { OverlayFilter, OverlayFilters } from '../../input/overlay-filter.ts';
import { handleOverlayToken } from '../../input/handler-ui-state.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';

const W = 120;
const TALL_VIEWPORT = 80;
const KEYBINDINGS = new KeybindingsManager({ configPath: '/nonexistent/path/keybindings.json' });

const SAMPLE_COMMANDS: SlashCommand[] = [
  { name: 'model', aliases: ['m'], description: 'Select LLM model', handler: () => {} },
  { name: 'help', aliases: ['h', '?'], description: 'Show help', handler: () => {} },
  { name: 'quit', aliases: ['q'], description: 'Exit application', handler: () => {} },
];

function linesToText(layer: SurfaceLayer): string[] {
  return layerText(layer);
}

/** Every row of the overlay, scrolled from the top to the end. */
function renderAllText(commands?: SlashCommand[]): string {
  const filter = new OverlayFilter();
  const frames: string[] = [linesToText(renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, commands, 0, filter)).join('\n')];
  for (let offset = 10; offset <= filter.maxScroll + 10; offset += 10) {
    frames.push(linesToText(renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, commands, offset, filter)).join('\n'));
  }
  return frames.join('\n');
}

describe('renderHelpOverlay', () => {
  test('draws a kit modal inside the screen: caps, ✦ title, esc keycap, no box frame', () => {
    const layer = renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, undefined, 0);
    const rows = linesToText(layer);
    expect(layer.x + rows[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + rows.length).toBeLessThanOrEqual(TALL_VIEWPORT);
    expect(rows[0]).toMatch(/^▄+$/);
    expect(rows[2]).toContain('Help');
    expect(rows[2]).toContain('esc');
    expect(rows.join('\n')).not.toMatch(/[┌┐└┘│]/);
  });

  test('keycap hints: scroll and close', () => {
    const text = layerTextBlock(renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, undefined, 0));
    expect(text).toContain('↑↓  scroll');
    expect(text).toContain('?  close');
  });

  test('groups are kit headers (lowercase)', () => {
    const texts = renderAllText();
    expect(texts).toContain('core navigation');
    expect(texts).toContain('prompt and editing');
    expect(texts).toContain('overlays and panels');
  });

  test('contains Quick Start section when featured commands are registered', () => {
    // Quick Start is built from the live registry: need at least one featured command.
    const cmds: SlashCommand[] = [{ name: 'cockpit', description: 'Control room', handler: () => {} }];
    const texts = renderAllText(cmds);
    expect(texts).toContain('quick start');
  });

  test('contains an Essentials command group with the memorable commands', () => {
    const cmds: SlashCommand[] = [
      { name: 'model', description: 'Select model', handler: () => {} },
      { name: 'keybindings', description: 'Customize keys', handler: () => {} },
      { name: 'clear', description: 'Clear conversation', handler: () => {} },
    ];
    const texts = renderAllText(cmds);
    expect(texts).toContain('essentials');
    expect(texts).toContain('/keybindings');
  });

  test('enumerates workspace panel bindings including Alt+digit tab jumps', () => {
    const texts = renderAllText();
    // Bindings are pulled from KeybindingsManager.getAll(); the Alt+digit jumps
    // are real, rebindable actions and must be discoverable here.
    expect(texts).toContain('Alt+1');
    expect(texts).toContain('Alt+9');
    expect(texts).toContain('Jump to workspace panel tab');
    // The shared in-panel contract is documented alongside the global bindings.
    expect(texts).toContain('in-panel controls');
    expect(texts).toContain('j / k');
  });

  test('shows the onboarding wizard quick-start row when onboarding is registered', () => {
    const text = renderAllText([{ name: 'onboarding', description: 'Setup surfaces', handler: () => {} }]);
    expect(text).toContain('/onboarding');
    expect(text).toContain('Open the onboarding wizard with current settings');
    expect(text).toContain('preloaded');
    expect(text).not.toContain('first-run checklist');
  });

  test('includes Ctrl+F shortcut in navigation', () => {
    const lines = renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, undefined, 0);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Ctrl+F');
  });

  test('includes PageUp/PageDn in navigation', () => {
    const lines = renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, undefined, 0);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('PageUp');
  });

  test('includes ? toggle shortcut', () => {
    const lines = renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, undefined, 0);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('?');
  });

  test('renders command list when commands provided', () => {
    const texts = renderAllText(SAMPLE_COMMANDS);
    expect(texts).toContain('/model');
    expect(texts).toContain('/help');
  });

  test('shows command aliases when provided when command is in the expanded list', () => {
    const texts = renderAllText(SAMPLE_COMMANDS);
    expect(texts).toContain('/model');
  });

  test('shows fallback command list when no commands provided', () => {
    const texts = renderAllText(undefined);
    // The fallback string includes known command names
    expect(texts).toContain('/help');
  });

  test('narrow screens take the full width minus one column per side', () => {
    const layer = renderHelpOverlay(60, 30, KEYBINDINGS, undefined, 0);
    expect(layer.x).toBe(1);
    expect(layer.lines[0]!.length).toBe(58);
  });

  test('the search row filters entries and group headers; the count is truthful', () => {
    const filter = new OverlayFilter();
    filter.query = 'model';
    const text = layerTextBlock(renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, SAMPLE_COMMANDS, 0, filter));
    expect(text).toContain('model▏');
    expect(text).toContain('/model');
    expect(text).not.toContain('Scroll by full page');
    expect(text).toMatch(/\d+ of \d+/);
  });

  test('the renderer records how far the list scrolls so the input never runs past the end', () => {
    const filter = new OverlayFilter();
    renderHelpOverlay(W, 24, KEYBINDINGS, SAMPLE_COMMANDS, 0, filter);
    expect(filter.maxScroll).toBeGreaterThan(0);
    const end = linesToText(renderHelpOverlay(W, 24, KEYBINDINGS, SAMPLE_COMMANDS, 10_000, filter)).join('\n');
    expect(end).not.toMatch(/more ↓/);
  });

  test('registry traversal crash guard: throwing command getter does not crash overlay', () => {
    // Simulate a plugin command whose property getter throws (e.g. a broken plugin).
    const throwingCmd = {
      name: 'cockpit',
      description: 'Control room',
      handler: () => {},
      get aliases(): string[] {
        throw new Error('plugin getter failure');
      },
    } as unknown as SlashCommand;

    // The overlay must not throw even when registry traversal errors occur.
    expect(() => {
      const layer = renderHelpOverlay(W, TALL_VIEWPORT, KEYBINDINGS, [throwingCmd], 0);
      // The title row (with the esc keycap) and the hints still render.
      expect(linesToText(layer)[2]).toContain('esc');
      expect(layerTextBlock(layer)).toContain('scroll');
    }).not.toThrow();
  });
});

describe('renderShortcutsOverlay (the concept keys screen)', () => {
  test('keys bold, actions muted, in columns; filterable by typing', () => {
    const layer = renderShortcutsOverlay(140, 40, KEYBINDINGS, 0, new OverlayFilter());
    const text = layerTextBlock(layer);
    expect(text).toContain('Keyboard shortcuts');
    expect(text).toContain('navigation & editing');
    const row = layer.lines.find((line) => line.map((c) => c.char).join('').includes('Shift+Enter'))!;
    const x = row.map((c) => c.char).join('').indexOf('Shift+Enter');
    expect(row[x]!.bold).toBe(true);
    // Three columns at this width: a group header sits past the first third.
    const headerCols = layerText(layer).flatMap((line) => [...line.matchAll(/✦/g)].map((m) => m.index!));
    expect(Math.max(...headerCols)).toBeGreaterThan(40);

    const filter = new OverlayFilter();
    filter.query = 'newline';
    const filtered = layerTextBlock(renderShortcutsOverlay(140, 40, KEYBINDINGS, 0, filter));
    expect(filtered).toContain('Shift+Enter');
    expect(filtered).not.toContain('Mouse wheel');
  });

  test('an unmatched query says so honestly', () => {
    const filter = new OverlayFilter();
    filter.query = 'zzzz-nothing';
    expect(layerTextBlock(renderShortcutsOverlay(100, 30, KEYBINDINGS, 0, filter))).toContain('No shortcuts match "zzzz-nothing"');
  });
});

describe('handleOverlayToken (help / shortcuts search rows)', () => {
  function helpState() {
    const filters = new OverlayFilters();
    const escapes = { n: 0 };
    const state = {
      helpOverlayActive: true, helpScrollOffset: 0, shortcutsOverlayActive: false, shortcutsScrollOffset: 0,
      overlayFilters: filters, requestRender: () => {}, handleEscape: () => { escapes.n++; },
    };
    return { state, filters, escapes };
  }

  test('typing goes into the query; ? closes help only while the query is empty', () => {
    const { state, filters } = helpState();
    handleOverlayToken(state, { type: 'text', value: 'm' } as never);
    handleOverlayToken(state, { type: 'text', value: '?' } as never);
    expect(filters.help.query).toBe('m?');
    expect(state.helpOverlayActive).toBe(true);
    handleOverlayToken(state, { type: 'key', logicalName: 'backspace' } as never);
    handleOverlayToken(state, { type: 'key', logicalName: 'backspace' } as never);
    expect(filters.help.query).toBe('');
    handleOverlayToken(state, { type: 'text', value: '?' } as never);
    expect(state.helpOverlayActive).toBe(false);
  });

  test('Esc closes in one press whatever the query holds; down never passes the recorded end', () => {
    const { state, filters, escapes } = helpState();
    filters.help.maxScroll = 2;
    for (let k = 0; k < 5; k++) handleOverlayToken(state, { type: 'key', logicalName: 'down' } as never);
    expect(state.helpScrollOffset).toBe(2);
    handleOverlayToken(state, { type: 'text', value: 'abc' } as never);
    expect(state.helpScrollOffset).toBe(0);
    handleOverlayToken(state, { type: 'key', logicalName: 'escape' } as never);
    expect(escapes.n).toBe(1);
  });
});
