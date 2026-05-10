import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { handleCommandModeToken } from '../../input/handler-command-route.ts';
import { handlePromptTextToken } from '../../input/handler-feed-routes.ts';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';


function makeCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = { log: () => {} } as never;
  const configManager = {} as never;
  const base: CommandContext = {
    session: {
      conversationManager,
      runtime: {} as never,
    },
    provider: {
      providerRegistry,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    renderRequest: () => {},
    submitInput: () => {},
    executeCommand: async () => false,
    cancelGeneration: () => {},
    clearScreen: () => {},
    requestPermission: async () => ({ approved: false } as never),
    completeModelSelection: () => {},
    jumpToBookmark: () => {},
    scrollToLine: () => {},
    print: () => {},
    exit: () => {},
  };
  return {
    ...base,
    ...overrides,
    session: {
      ...base.session,
      ...overrides.session,
    },
    provider: {
      ...base.provider,
      ...overrides.provider,
    },
    workspace: {
      ...base.workspace,
      ...overrides.workspace,
    },
    platform: {
      ...base.platform,
      ...overrides.platform,
    },
    ops: {
      ...base.ops,
      ...overrides.ops,
    },
    extensions: {
      ...base.extensions,
      ...overrides.extensions,
    },
  } as CommandContext;
}

function makePanelManager(overrides: Record<string, unknown> = {}) {
  return {
    isVisible: () => true,
    getAllOpen: () => [{ id: 'panel-list' }],
    ...overrides,
  } as never;
}

function key(logicalName: string) {
  return { type: 'key' as const, name: logicalName, logicalName, ctrl: false, shift: false, meta: false };
}

describe('command modal handoff', () => {
  test('escape closes the slash menu completely and removes stale command stack entries', async () => {
    let resetCount = 0;
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const modalStack = ['command', 'selection', 'command'];
    const result = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: true,
      modalStack,
      modalReturnFocus: 'prompt',
      panelFocused: false,
      indicatorFocused: false,
      prompt: '/',
      cursorPos: 1,
      helpScrollOffset: 0,
      shortcutsScrollOffset: 0,
      requestRender: () => {},
      saveUndoState: () => {},
      cancelGeneration: undefined,
      selectionCallback: null,
      bookmarkModal: { active: false, close: () => {} } as never,
      agentDetailModal: { active: false, close: () => {} } as never,
      liveTailModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      processModal: { active: false, close: () => {} } as never,
      modelPicker: { active: false, close: () => {} } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => { resetCount++; },
      autocompleteUpdate: () => {},
    });

    expect(result.commandMode).toBe(false);
    expect(result.prompt).toBe('');
    expect(result.cursorPos).toBe(0);
    expect(modalStack).toEqual(['selection']);
    expect(resetCount).toBe(1);
  });

  test('reopens the previous modal when a stacked modal closes', async () => {
    const modalStack = ['command', 'modelPicker'];
    let activeName = 'modelPicker';
    let autocompleteQuery = 'stale';
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const result = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: false,
      modalStack,
      modalReturnFocus: 'prompt',
      panelFocused: false,
      indicatorFocused: false,
      prompt: '',
      cursorPos: 0,
      helpScrollOffset: 0,
      shortcutsScrollOffset: 0,
      requestRender: () => {},
      saveUndoState: () => {},
      cancelGeneration: undefined,
      selectionCallback: null,
      bookmarkModal: { active: false, close: () => {} } as never,
      agentDetailModal: { active: false, close: () => {} } as never,
      liveTailModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      processModal: { active: false, close: () => {} } as never,
      modelPicker: { active: true, close: () => { activeName = 'command'; } } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => {},
      autocompleteUpdate: (query: string) => { autocompleteQuery = query; },
    });

    expect(modalStack).toEqual(['command']);
    expect(result.commandMode).toBe(true);
    expect(result.prompt).toBe('/');
    expect(result.cursorPos).toBe(1);
    expect(autocompleteQuery).toBe('');
    expect(activeName).toBe('command');
  });

  test('consumes the slash-command layer once a nested modal opens', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    const state = {
      commandMode: true,
      prompt: '/provider',
      cursorPos: '/provider'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({
        executeCommand: async () => {
          modalStack.push('modelPicker');
          return true;
        },
      }),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(state.prompt).toBe('');
    expect(state.cursorPos).toBe(0);
    expect(modalStack).toEqual(['modelPicker']);
  });

  test('removes command from the stack when no nested modal opens', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    const state = {
      commandMode: true,
      prompt: '/help',
      cursorPos: '/help'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({
        executeCommand: async () => true,
      }),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(modalStack).toEqual([]);
    expect(state.prompt).toBe('');
    expect(state.cursorPos).toBe(0);
  });

  test('slash panel commands can hand focus directly to the panel workspace', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    let showPanelCalled = false;
    registry.register({
      name: 'panel',
      description: 'Open panel',
      handler: (_args, ctx) => {
        ctx.showPanel?.('panel-list');
      },
    });
    const state = {
      commandMode: true,
      prompt: '/panel',
      cursorPos: '/panel'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({
        showPanel: () => {
          showPanelCalled = true;
        },
      }),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(showPanelCalled).toBe(true);
    expect(state.panelFocused).toBe(true);
    expect(state.commandMode).toBe(false);
  });

  test('after escape closes slash mode, subsequent typing stays in normal prompt mode until / is typed again', async () => {
    let resetCount = 0;
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const modalStack = ['command'];
    const escaped = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: true,
      modalStack,
      modalReturnFocus: 'prompt',
      panelFocused: false,
      indicatorFocused: false,
      prompt: '/',
      cursorPos: 1,
      helpScrollOffset: 0,
      shortcutsScrollOffset: 0,
      requestRender: () => {},
      saveUndoState: () => {},
      cancelGeneration: undefined,
      selectionCallback: null,
      bookmarkModal: { active: false, close: () => {} } as never,
      agentDetailModal: { active: false, close: () => {} } as never,
      liveTailModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      processModal: { active: false, close: () => {} } as never,
      modelPicker: { active: false, close: () => {} } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => { resetCount++; },
      autocompleteUpdate: () => {},
    });

    const registry = new CommandRegistry();
    const textRoute = handlePromptTextToken({
      prompt: escaped.prompt,
      cursorPos: escaped.cursorPos,
      commandMode: escaped.commandMode,
      nextPasteId: 1,
      nextImageId: 1,
      pasteRegistry: new Map(),
      imageRegistry: new Map(),
      inputHistory: null,
      commandRegistry: registry,
      commandContext: makeCommandContext(),
      autocomplete: null,
      filePicker: { open: () => {} },
      modalOpened: () => { throw new Error('slash menu should not reopen while typing normal text'); },
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      registerPaste: (content: string) => content,
      requestRender: () => {},
    }, { type: 'text', value: 'a' });

    expect(resetCount).toBe(1);
    expect(escaped.commandMode).toBe(false);
    expect(escaped.prompt).toBe('');
    expect(textRoute.commandMode).toBe(false);
    expect(textRoute.prompt).toBe('a');
    expect(modalStack).toEqual([]);
  });

  test('input handler clears command mode after a slash command opens a selection modal', async () => {
    const dir = join(tmpdir(), `gv-command-modal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const history = new InfiniteBuffer();
      const input = new InputHandler(
        () => {},
        new SelectionManager(),
        () => 0,
        () => 20,
        () => history,
        () => {},
        () => {},
        createDefaultUiRuntimeServices(),
      );
      input.setContentWidth(80);

      const registry = new CommandRegistry();
      registerConfigCommand(registry);
      const configManager = new ConfigManager({ surfaceRoot: 'tui',
        workingDir: dir,
        configDir: join(dir, '.goodvibes', 'tui'),
      });
      const context = makeCommandContext({
        platform: {
          config: configManager.getAll(),
          configManager,
        },
        renderRequest: () => {},
        workspace: {
          shellPaths: createShellPathService({
            workingDirectory: dir,
            homeDirectory: dir,
          }),
        },
        executeCommand: async (name, args) => registry.execute(name, args, context),
      });
      const subscriptions = new SubscriptionManager(join(dir, '.goodvibes', 'tui', 'subscriptions.json'));
      const services = new ServiceRegistry(join(dir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: dir, globalHome: dir, configManager }),
        subscriptionManager: subscriptions,
      });
      context.openSettingsModal = (target?: string) => {
        input.modalOpened('settings');
        input.settingsModal.open(configManager, createFeatureFlagManager(), subscriptions, services);
        input.settingsModal.selectTarget(target);
      };
      input.setCommandRegistry(registry, context);

      input.feed('/config danger.daemon\r');
      await Promise.resolve();

      expect(input.settingsModal.active).toBe(true);
      expect(input.commandMode).toBe(false);
      expect(input.prompt).toBe('');
      expect(input.modalStack).toEqual(['settings']);
      expect(input.settingsModal.getSelected()?.setting.key).toBe('danger.daemon');

      const before = configManager.get('danger.daemon');
      input.feed(' ');

      expect(configManager.get('danger.daemon')).toBe(!before);
      expect(input.settingsModal.active).toBe(true);
      expect(input.commandMode).toBe(false);
      expect(input.modalStack).toEqual(['settings']);

      input.feed('\x1b');

      expect(input.settingsModal.active).toBe(false);
      expect(input.commandMode).toBe(false);
      expect(input.prompt).toBe('');
      expect(input.modalStack).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
