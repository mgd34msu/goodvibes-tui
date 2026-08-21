import { describe, test, expect } from 'bun:test';
import { createKeybindingsModalSurface, type KeybindingsModalProviderRegistry, type KeybindingsModalToolRegistry } from '../../../panels/modals/keybindings-modal.ts';
import { KeybindingsManager } from '../../../input/keybindings.ts';
import { actionCtx, captureCommands, open, tabText } from './modal-surface-test-helpers.ts';

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
function keybindings(): KeybindingsManager { return new KeybindingsManager({ configPath: '/nonexistent/keybindings-modal-test.json' }); }

describe('keybindings modal surface', () => {
  test('surface identity matches the docs -> keybindings-modal redirect target', () => {
    expect(createKeybindingsModalSurface({}).name).toBe('keybindings-modal');
  });

  test('three tabs; Tools folds metadata into rows; Models marks the active one', () => {
    const view = open(createKeybindingsModalSurface({ toolRegistry: FIXED_TOOLS, providerRegistry: FIXED_MODELS, keybindingsManager: keybindings() }));
    expect(view.tabs.map((t) => t.id)).toEqual(['tools', 'models', 'shortcuts']);
    const tools = tabText(view, 'tools');
    expect(tools).toContain('read_file');
    expect(tools).toContain('Read a file from disk.');
    expect(tools).toContain('effects: read_fs');
    expect(view.tabs[0]!.rows.map((r) => r.id)).toEqual(['tool:read_file', 'tool:run_shell']);
    const models = tabText(view, 'models');
    expect(models).toContain('Acme A');
    expect(models).toContain('ACTIVE');
    expect(view.tabs[1]!.rows.map((r) => r.id)).toEqual(['model:acme:a', 'model:acme:b']);
  });

  test('tools/shortcuts tabs degrade honestly when their dependency is not wired', () => {
    const view = open(createKeybindingsModalSurface({}));
    expect(tabText(view, 'tools').toLowerCase()).toContain('tool registry not wired');
    expect(tabText(view, 'shortcuts').toLowerCase()).toContain('keybindings manager not wired');
  });

  test('activate: Tools tab -> /panel open fleet --target <tool>:tool (deep-link); Models tab -> /model <key>; unselectable model is a no-op', () => {
    const surface = createKeybindingsModalSurface({ toolRegistry: FIXED_TOOLS, providerRegistry: FIXED_MODELS });
    open(surface);
    const fleet = captureCommands();
    surface.onAction?.('activate', actionCtx({ id: 'tool:read_file', label: '' }, { ...fleet.extra, tabId: 'tools' }));
    expect(fleet.calls).toEqual([['panel', ['open', 'fleet', '--target', 'read_file:tool']]]);

    // A row with no parseable tool name (id doesn't start with 'tool:') falls
    // back to the plain generic jump, never crashes, never sends a garbage target.
    const noRow = captureCommands();
    surface.onAction?.('activate', actionCtx(null, { ...noRow.extra, tabId: 'tools' }));
    expect(noRow.calls).toEqual([['panel', ['open', 'fleet']]]);

    const model = captureCommands();
    surface.onAction?.('activate', actionCtx({ id: 'model:acme:a', label: '' }, { ...model.extra, tabId: 'models' }));
    expect(model.calls).toEqual([['model', ['acme:a']]]);

    const unsel = captureCommands();
    surface.onAction?.('activate', actionCtx({ id: 'model:acme:b', label: '' }, { ...unsel.extra, tabId: 'models' }));
    expect(unsel.calls).toEqual([]);
  });

  test('Shortcuts tab folds the categorized overlay reference AND the exhaustive live binding table', () => {
    const text = tabText(open(createKeybindingsModalSurface({ keybindingsManager: keybindings() })), 'shortcuts');
    expect(text).toContain('Navigation');
    expect(text).toContain('In-Panel Controls');
    expect(text).toContain('Ctrl+F'); // 'search' combo label
    expect(text).toContain('All Bindings (live)');
    expect(text).toContain('Reverse input history search');
  });
});
