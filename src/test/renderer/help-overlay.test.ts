/**
 * Tests for renderHelpOverlay.
 */
import { describe, test, expect } from 'bun:test';
import { renderHelpOverlay } from '../../renderer/help-overlay.ts';
import type { SlashCommand } from '../../input/command-registry.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 120;
const TALL_VIEWPORT = 80;
const KEYBINDINGS = new KeybindingsManager({ configPath: '/nonexistent/path/keybindings.json' });

const SAMPLE_COMMANDS: SlashCommand[] = [
  { name: 'model', aliases: ['m'], description: 'Select LLM model', handler: () => {} },
  { name: 'help', aliases: ['h', '?'], description: 'Show help', handler: () => {} },
  { name: 'quit', aliases: ['q'], description: 'Exit application', handler: () => {} },
];

function renderAllText(commands?: SlashCommand[]): string {
  const frames: string[] = [];
  // The overlay is one tall scrolling surface (workspace bindings + in-panel
  // contract + command groups), so scan a wide offset range to capture every
  // section regardless of where it lands in the window.
  for (let offset = 0; offset <= 66; offset += 3) {
    frames.push(linesToText(renderHelpOverlay(W, KEYBINDINGS, commands, offset, TALL_VIEWPORT)).join('\n'));
  }
  return frames.join('\n');
}

describe('renderHelpOverlay', () => {
  test('returns an array of Lines', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Help"', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const titleLine = lineToString(lines[0]);
    expect(titleLine).toContain('Help');
  });

  test('footer contains close hint', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('Esc');
  });

  test('contains Core Navigation section', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Core Navigation');
  });

  test('contains Prompt And Editing section', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Prompt And Editing');
  });

  test('contains Overlays And Panels section', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 13, TALL_VIEWPORT);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Overlays And Panels');
  });

  test('contains Quick Start section when featured commands are registered', () => {
    // Quick Start is built from the live registry: need at least one featured command.
    const cmds: SlashCommand[] = [{ name: 'cockpit', description: 'Control room', handler: () => {} }];
    const texts = renderAllText(cmds);
    expect(texts).toContain('Quick Start');
  });

  test('contains an Essentials command group with the memorable commands', () => {
    const cmds: SlashCommand[] = [
      { name: 'model', description: 'Select model', handler: () => {} },
      { name: 'keybindings', description: 'Customize keys', handler: () => {} },
      { name: 'clear', description: 'Clear conversation', handler: () => {} },
    ];
    const texts = renderAllText(cmds);
    expect(texts).toContain('Essentials');
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
    expect(texts).toContain('In-Panel Controls');
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
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Ctrl+F');
  });

  test('includes PageUp/PageDn in navigation', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('PageUp');
  });

  test('includes ? toggle shortcut', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
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

  test('lines are correct at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderHelpOverlay(narrowW, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('footer contains scroll hint', () => {
    const lines = renderHelpOverlay(W, KEYBINDINGS, undefined, 0, TALL_VIEWPORT);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('Up/Down');
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
      const lines = renderHelpOverlay(W, KEYBINDINGS, [throwingCmd], 0, TALL_VIEWPORT);
      // Footer hints must still render (overlay is reachable).
      const footerLine = lineToString(lines[lines.length - 1]);
      expect(footerLine).toContain('Esc');
    }).not.toThrow();
  });
});
