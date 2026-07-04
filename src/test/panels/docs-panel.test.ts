import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocsPanel } from '../../panels/docs-panel.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { PanelManager } from '../../panels/panel-manager.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';

function linesText(lines: ReturnType<DocsPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

/** Config-path-only manager — resolves a path but never touches disk unless loadFromDisk() is called. */
function makeKeybindingsManager(configPath?: string): KeybindingsManager {
  return new KeybindingsManager({ configPath: configPath ?? join(tmpdir(), 'goodvibes-docs-panel-test-nonexistent.json') });
}

describe('DocsPanel', () => {
  test('renders shared workspace shell and tool docs', () => {
    const toolRegistry = {
      list: () => [
        {
          definition: {
            name: 'read',
            description: 'Read files from disk',
            sideEffects: [],
            concurrency: 'safe',
            supportsProgress: false,
            supportsStreamingOutput: false,
          },
        },
      ],
    } as unknown as ToolRegistry;
    const providerRegistry = {
      listModels: () => [],
    } as unknown as ProviderRegistry;

    const panel = new DocsPanel(toolRegistry, providerRegistry);
    panel.onActivate();
    const lines = panel.render(80, 18);
    const text = linesText(lines);
    expect(text).toContain('Docs / Tools');
    expect(text).toContain('read');
    expect(text).toContain('Read files from disk');
  });

  test('renders keyboard shortcut section from live KeybindingsManager.getAll()', () => {
    const panel = new DocsPanel(undefined, undefined, makeKeybindingsManager());
    panel.onActivate();
    panel.handleInput('k');
    const lines = panel.render(80, 18);
    const text = linesText(lines);
    expect(text).toContain('Keyboard Shortcuts');
    // Default panel-picker binding + its live ACTION_DESCRIPTIONS text — not
    // the old hardcoded 19-entry SHORTCUTS array.
    expect(text).toContain('Ctrl+P');
    expect(text).toContain('Open, focus, or hide the panel workspace');
  });

  test('shortcuts reflect user overrides from keybindings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodvibes-docs-panel-'));
    const configPath = join(dir, 'keybindings.json');
    writeFileSync(configPath, JSON.stringify({ 'panel-picker': { key: 'q', ctrl: true } }));
    const km = makeKeybindingsManager(configPath);
    km.loadFromDisk();

    const panel = new DocsPanel(undefined, undefined, km);
    panel.onActivate();
    panel.handleInput('k');
    const text = linesText(panel.render(80, 18));
    expect(text).toContain('Ctrl+Q');
    expect(text).not.toContain('Ctrl+P');
  });

  test('empty state when no keybindings manager is wired', () => {
    const panel = new DocsPanel();
    panel.onActivate();
    panel.handleInput('k');
    const text = linesText(panel.render(80, 18));
    expect(text).toContain('Keybindings manager not wired into this session.');
  });

  // W6.1 (the purge): 'tools'/ToolInspectorPanel was DELETE-disposition (tool
  // results already render inline in the transcript, plus a per-node tool
  // list in Fleet). Enter on a tool row now opens Fleet instead — there is
  // no filter-by-tool equivalent there yet, so this only asserts the coarser
  // jump, not a specific-tool filter.
  test('Enter on a tool row opens fleet (tools retired — no filtered inspector remains)', () => {
    const toolRegistry = {
      list: () => [
        { definition: { name: 'read', description: 'Read files', sideEffects: [], concurrency: 'safe', supportsProgress: false, supportsStreamingOutput: false } },
        { definition: { name: 'write', description: 'Write files', sideEffects: ['fs'], concurrency: 'exclusive', supportsProgress: false, supportsStreamingOutput: false } },
      ],
    } as unknown as ToolRegistry;

    const panel = new DocsPanel(toolRegistry);
    panel.onActivate();
    // Cursor starts on the header row; move down onto the first tool item row.
    panel.handleInput('down');
    expect(panel.handleInput('enter')).toBe(true);

    let openedId: string | null = null;
    const panelManager = {
      open: (id: string) => {
        openedId = id;
        return null;
      },
    } as unknown as PanelManager;
    const ctx: PanelIntegrationContext = { panelManager };

    expect(panel.handlePanelIntegrationAction?.('enter', ctx)).toBe(true);
    expect(openedId).toBe('fleet');
  });

  test('Enter on a model row marks it ACTIVE via providerRegistry.setCurrentModel', () => {
    let currentKey = 'anthropic:claude-a';
    const providerRegistry = {
      listModels: () => [
        { id: 'claude-a', provider: 'anthropic', registryKey: 'anthropic:claude-a', displayName: 'Claude A', contextWindow: 100000, selectable: true },
        { id: 'claude-b', provider: 'anthropic', registryKey: 'anthropic:claude-b', displayName: 'Claude B', contextWindow: 200000, selectable: true },
      ],
      getCurrentModel: () => ({ registryKey: currentKey }),
      setCurrentModel: (key: string) => { currentKey = key; },
    } as unknown as ProviderRegistry;

    const panel = new DocsPanel(undefined, providerRegistry);
    panel.onActivate();
    panel.handleInput('m');
    let text = linesText(panel.render(80, 18));
    expect(text).toContain('Claude A');
    expect(text).toContain('ACTIVE');
    expect(text.split('\n').find((l) => l.includes('Claude A'))).toContain('ACTIVE');

    // Move onto the second model's item row and switch to it.
    panel.handleInput('down'); // provider header -> Claude A item
    panel.handleInput('down'); // Claude A item -> Claude A detail
    panel.handleInput('down'); // Claude A detail -> Claude B item
    expect(panel.handleInput('enter')).toBe(true);
    expect(currentKey).toBe('anthropic:claude-b');

    text = linesText(panel.render(80, 18));
    expect(text.split('\n').find((l) => l.includes('Claude B'))).toContain('ACTIVE');
    expect(text.split('\n').find((l) => l.includes('Claude A'))).not.toContain('ACTIVE');
  });

  test('/ activates the filter before section hotkeys apply; Esc clears it', () => {
    const panel = new DocsPanel();
    panel.onActivate();
    panel.handleInput('/');
    panel.handleInput('m');
    let text = linesText(panel.render(80, 18));
    // WO-153: converged modal filter — pinned '[Filter] ' + literal '_' cursor contract.
    expect(text).toContain('[Filter] m_');
    expect(text).toContain('Docs / Tools');

    panel.handleInput('escape');
    panel.handleInput('m');
    text = linesText(panel.render(80, 18));
    expect(text).toContain('Docs / Models');
  });
});
