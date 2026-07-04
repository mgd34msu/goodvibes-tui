import { describe, test, expect } from 'bun:test';
import {
  bindKeybindingsModal,
  keybindingsModalGoldenSurface,
  type KeybindingsModalProviderRegistry,
  type KeybindingsModalToolRegistry,
} from '../../../panels/modals/keybindings-modal.ts';
import { EMPTY_VIEW, type ModalViewState } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';
import { KeybindingsManager } from '../../../input/keybindings.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const tab of config.tabs ?? []) parts.push(`${tab.active ? '*' : ''}${tab.label}`);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

const FIXED_TOOLS: KeybindingsModalToolRegistry = {
  list: () => [
    { definition: { name: 'read_file', description: 'Read a file from disk.', sideEffects: ['read_fs'], concurrency: 'parallel' } },
    { definition: { name: 'run_shell', description: 'Execute a shell command.', sideEffects: ['exec'], concurrency: 'serial', supportsProgress: true, supportsStreamingOutput: true } },
  ],
};

const FIXED_MODELS: KeybindingsModalProviderRegistry = {
  listModels: () => [
    { id: 'a', provider: 'acme', registryKey: 'acme:a', displayName: 'Acme A', contextWindow: 128000, selectable: true },
    { id: 'b', provider: 'acme', registryKey: 'acme:b', displayName: 'Acme B', contextWindow: 0, selectable: false },
  ],
  getCurrentModel: () => ({ registryKey: 'acme:a' }),
};

function keybindings(): KeybindingsManager {
  return new KeybindingsManager({ configPath: '/nonexistent/keybindings-modal-test.json' });
}

describe('keybindings modal builder', () => {
  test('surface identity: name matches the docs -> keybindings redirect target', () => {
    const surface = bindKeybindingsModal({});
    expect(surface.name).toBe('keybindings');
  });

  test('tools tab: lists tools and shows selected-tool metadata', () => {
    const surface = bindKeybindingsModal({ toolRegistry: FIXED_TOOLS });
    const config = surface.buildConfig(EMPTY_VIEW);
    const text = configText(config);
    expect(text).toContain('*Tools');
    expect(text).toContain('read_file');
    expect(text).toContain('run_shell');
    expect(text).toContain('Read a file from disk.');
    expect(text).toContain('effects: read_fs');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['tool:read_file', 'tool:run_shell']);
  });

  test('tools tab degrades honestly when the tool registry is not wired', () => {
    const surface = bindKeybindingsModal({});
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text.toLowerCase()).toContain('tool registry not wired');
  });

  test('models tab: lists models sorted by provider/name and marks the active one', () => {
    const surface = bindKeybindingsModal({ providerRegistry: FIXED_MODELS });
    surface.actions.models!(EMPTY_VIEW);
    const config = surface.buildConfig(EMPTY_VIEW);
    const text = configText(config);
    expect(text).toContain('*Models');
    expect(text).toContain('Acme A');
    expect(text).toContain('ACTIVE');
    expect(text).toContain('Acme B');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['model:acme:a', 'model:acme:b']);
  });

  test('activate on a tools row routes to the fleet panel via command (no cross-modal openModal)', () => {
    const surface = bindKeybindingsModal({ toolRegistry: FIXED_TOOLS });
    const outcome = surface.actions.activate!(EMPTY_VIEW);
    expect(outcome).toEqual({ kind: 'runCommand', command: '/panel open fleet' });
  });

  test('activate on a selectable models row routes to /model <registryKey>; unselectable rows are a no-op', () => {
    const surface = bindKeybindingsModal({ providerRegistry: FIXED_MODELS });
    surface.actions.models!(EMPTY_VIEW);
    const first = surface.actions.activate!(EMPTY_VIEW);
    expect(first).toEqual({ kind: 'runCommand', command: '/model acme:a' });
    const second = surface.actions.activate!({ ...EMPTY_VIEW, selectedIndex: 1 } as ModalViewState);
    expect(second).toEqual({ kind: 'none' });
  });

  test('shortcuts tab folds in the shortcuts-overlay categories AND the exhaustive live binding table', () => {
    const surface = bindKeybindingsModal({ keybindingsManager: keybindings() });
    surface.actions.shortcuts!(EMPTY_VIEW);
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('*Shortcuts');
    // Categorized reference (from renderShortcutsOverlay).
    expect(text).toContain('Navigation');
    expect(text).toContain('In-Panel Controls');
    expect(text).toContain('Ctrl+F'); // 'search' combo label used by both the overlay and this modal
    // Exhaustive live table (from DocsPanel's original flat enumeration) —
    // includes an action the curated categories never mention.
    expect(text).toContain('All Bindings (live)');
    expect(text).toContain('Reverse input history search');
  });

  test('shortcuts tab degrades honestly when the keybindings manager is not wired', () => {
    const surface = bindKeybindingsModal({});
    surface.actions.shortcuts!(EMPTY_VIEW);
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text.toLowerCase()).toContain('keybindings manager not wired');
  });

  test('golden surface renders deterministically across two independent builds', () => {
    const a = keybindingsModalGoldenSurface();
    const b = keybindingsModalGoldenSurface();
    expect(configText(a.buildConfig(EMPTY_VIEW))).toBe(configText(b.buildConfig(EMPTY_VIEW)));
    a.actions.shortcuts!(EMPTY_VIEW);
    b.actions.shortcuts!(EMPTY_VIEW);
    expect(configText(a.buildConfig(EMPTY_VIEW))).toBe(configText(b.buildConfig(EMPTY_VIEW)));
  });
});
