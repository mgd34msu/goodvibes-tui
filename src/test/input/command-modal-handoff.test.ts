import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import { KillRing } from '../../input/kill-ring.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { handleCommandModeToken } from '../../input/handler-command-route.ts';
import { handlePromptTextToken, handlePromptKeyToken } from '../../input/handler-feed-routes.ts';
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
  const conversationManager = { log: () => {}, dismissSplash: () => {} } as never;
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
    getAllOpen: () => [{ id: 'git' }],
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
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      configModal: { active: false, close: () => {}, reopen: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
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

  test('escape on a slash command with typed text closes the menu but keeps the text', async () => {
    let resetCount = 0;
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const modalStack = ['command'];
    const result = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: true,
      modalStack,
      modalReturnFocus: 'prompt',
      panelFocused: false,
      indicatorFocused: false,
      prompt: '/pro',
      cursorPos: 4,
      helpScrollOffset: 0,
      shortcutsScrollOffset: 0,
      requestRender: () => {},
      saveUndoState: () => {},
      cancelGeneration: undefined,
      selectionCallback: null,
      bookmarkModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      configModal: { active: false, close: () => {}, reopen: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      modelPicker: { active: false, close: () => {} } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => { resetCount++; },
      autocompleteUpdate: () => {},
    });

    expect(result.commandMode).toBe(false);
    expect(result.prompt).toBe('/pro');
    expect(result.cursorPos).toBe(4);
    expect(modalStack).toEqual([]);
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
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      configModal: { active: false, close: () => {}, reopen: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
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
      conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(state.prompt).toBe('');
    expect(state.cursorPos).toBe(0);
    expect(modalStack).toEqual(['modelPicker']);
  });

  test('submitting a slash command retires the splash for the run (owner rule: text OR command input)', async () => {
    // The splash used to survive a slash command whose output was a modal (or
    // nothing), then sit under the first chat reply. A submission is a
    // submission: command mode's Enter dispatch takes it down.
    const dismissals: number[] = [];
    const registry = new CommandRegistry();
    const state = {
      commandMode: true,
      prompt: '/help',
      cursorPos: '/help'.length,
      autocomplete: null,
      modalStack: ['command'],
      commandRegistry: registry,
      commandContext: makeCommandContext({ executeCommand: async () => true }),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: () => {}, dismissSplash: () => { dismissals.push(1); } } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(dismissals).toHaveLength(1);
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
      conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(modalStack).toEqual([]);
    expect(state.prompt).toBe('');
    expect(state.cursorPos).toBe(0);
  });

  test('/paste inserts clipboard images into the command-cleared prompt buffer', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    registry.register({
      name: 'paste',
      description: 'Paste',
      handler: (_args, ctx) => {
        ctx.pasteFromClipboard?.();
      },
    });
    const state = {
      commandMode: true,
      prompt: '/paste',
      cursorPos: '/paste'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({
        workspace: {
          shellPaths: createShellPathService({
            workingDirectory: process.cwd(),
            homeDirectory: process.env.HOME ?? process.cwd(),
          }),
        },
      }),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      clipboard: {
        pasteImageFromClipboard: () => ({ mediaType: 'image/png', data: 'iVBORw0KGgo' + 'A'.repeat(200) }),
        pasteFromClipboard: () => '',
      },
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(state.prompt).toMatch(/^\[IMAGE: img1, clipboard, \d+KB\]$/);
    expect(state.cursorPos).toBe(state.prompt.length);
    expect(state.imageRegistry.get('img1')?.mediaType).toBe('image/png');
    expect(state.nextImageId).toBe(2);
  });

  // item 1a: the command path ("/panel open <id>" and every other
  // command that opens a panel) leaves keyboard focus in the composer by
  // default now — "the user is mid-command-flow". This used to force
  // panelFocused=true unconditionally; the evaluator's ranked friction catalog
  // treats an implicit focus grab from a typed command as the same class of
  // bug as chords silently absorbing typed text.
  test('slash panel commands open the panel but leave focus in the composer by default (command path never auto-focuses)', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    let showPanelCalled = false;
    registry.register({
      name: 'panel',
      description: 'Open panel',
      handler: (_args, ctx) => {
        ctx.showPanel?.('git');
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
      conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(showPanelCalled).toBe(true);
    expect(state.panelFocused).toBe(false);
    expect(state.commandMode).toBe(false);
  });

  test('a command that explicitly opts in with showPanel(id, pane, target, { focus: true }) still grabs focus (escape hatch preserved)', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    registry.register({
      name: 'panel',
      description: 'Open panel',
      handler: (_args, ctx) => {
        // Reconciled signature: (panelId, pane, target, opts) — the deep-link
        // target sits at arg 3, so the focus opt-in moves to arg 4 (opts).
        ctx.showPanel?.('git', undefined, undefined, { focus: true });
      },
    });
    const state = {
      commandMode: true,
      prompt: '/panel',
      cursorPos: '/panel'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({ showPanel: () => {} }),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: () => {}, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.panelFocused).toBe(true);
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
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      configModal: { active: false, close: () => {}, reopen: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
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
      killRing: new KillRing(),
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
      saveUndoStateForText: () => {},
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

      input.feed('/config daemon.enabled\r');
      await Promise.resolve();

      expect(input.settingsModal.active).toBe(true);
      expect(input.commandMode).toBe(false);
      expect(input.prompt).toBe('');
      expect(input.modalStack).toEqual(['settings']);
      expect(input.settingsModal.getSelected()?.setting.key).toBe('daemon.enabled');

      const before = configManager.get('daemon.enabled');
      input.feed(' ');

      expect(configManager.get('daemon.enabled')).toBe(!before);
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

  // The '/' -> commandMode transition (handlePromptTextToken) fired
  // exactly once, gated on `state.commandRegistry` being non-null at that
  // exact instant. commandRegistry can be transiently null during a modal/
  // overlay handoff (e.g. the help overlay closing while a chain runs) — if
  // the registry reattaches even one tick later, the one-shot window has
  // already been missed and every subsequent keystroke is processed as plain
  // chat text with no way to recover.
  test('typing / arms commandMode even when commandRegistry is transiently null at that instant', async () => {
    const textState = {
      prompt: '',
      cursorPos: 0,
      commandMode: false,
      killRing: new KillRing(),
      nextPasteId: 1,
      nextImageId: 1,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      inputHistory: null,
      commandRegistry: null as CommandRegistry | null, // registry not attached yet at this instant
      commandContext: makeCommandContext(),
      autocomplete: null,
      filePicker: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      ensureInputCursorVisible: () => {},
      registerPaste: (content: string) => content,
      requestRender: () => {},
    };

    const result = handlePromptTextToken(textState, { type: 'text', value: '/' });

    expect(result.commandMode).toBe(true);
    expect(result.prompt).toBe('/');
  });

  // Safety net: if commandMode somehow still ends up false (registry
  // desync, or any future regression upstream) but the submitted text is
  // literally slash-prefixed, the enter-key handler must never hand it to
  // submitInput as ordinary chat — it re-derives command intent from the
  // text itself and dispatches through commandContext.executeCommand.
  test('a stray slash-prefixed submission with commandMode false is never sent to submitInput as chat', async () => {
    const submitCalls: string[] = [];
    const executeCalls: Array<{ name: string; args: string[] }> = [];
    const commandContext = {
      submitInput: (text: string) => { submitCalls.push(text); },
      executeCommand: async (name: string, args: string[]) => {
        executeCalls.push({ name, args });
        return true;
      },
    } as unknown as CommandContext;

    const keyState = {
      prompt: '/shortcuts',
      cursorPos: '/shortcuts'.length,
      killRing: new KillRing(),
      inputScrollTop: 0,
      commandMode: false, // desynced: text is slash-shaped but commandMode never armed
      contentWidth: 80,
      maxInputRows: 10,
      inputHistory: null,
      indicatorFocused: false,
      conversationManager: null,
      commandContext,
      commandRegistry: new CommandRegistry(),
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      getBlockAnchorLine: () => 0,
      openFleetPanel: () => {},
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      breakUndoCoalesce: () => {},
      saveUndoStateForText: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => ({
        wrappedLines: ['/shortcuts'],
        segments: [],
        cursorWrappedLine: 0,
        cursorCol: '/shortcuts'.length,
        visibleLines: ['/shortcuts'],
        visibleCursorLine: 0,
        visibleCursorCol: '/shortcuts'.length,
      }),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    };

    handlePromptKeyToken(keyState, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    await Promise.resolve();

    expect(submitCalls).toEqual([]);
    expect(executeCalls).toEqual([{ name: 'shortcuts', args: [] }]);
  });

  // Regression coverage: the commandPromise chain in handleCommandModeToken
  // used to be a bare `.then(...)` with no `.catch()` — any handler that
  // threw or awaited a rejected promise became a silent unhandled rejection
  // (dead command, nothing rendered). This is defense in depth for EVERY
  // command, so a generic throwing handler is enough to exercise it.
  test('a handler that throws is caught by the generic command-route .catch(), rendering a visible error instead of an unhandled rejection', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    registry.register({
      name: 'boom',
      description: 'Always throws',
      handler: async () => {
        throw new Error('kaboom');
      },
    });
    const logged: Array<{ text: string; opts?: unknown }> = [];
    const state = {
      commandMode: true,
      prompt: '/boom',
      cursorPos: '/boom'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext(),
      panelFocused: false,
      panelManager: makePanelManager(),
      conversationManager: { log: (text: string, opts?: unknown) => { logged.push({ text, opts }); }, dismissSplash: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: process.cwd(),
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let handled: boolean;
    try {
      handled = handleCommandModeToken(state, key('enter'));
      // Let the rejected commandPromise's .then/.catch chain settle.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(handled).toBe(true);
    expect(logged.some((l) => l.text.includes('Command /boom failed') && l.text.includes('kaboom'))).toBe(true);
  });

  // smoke defect: the feed pipeline snapshots the help/shortcuts
  // overlay flags and wrote the stale snapshot back after token processing,
  // silently reverting an overlay a command handler had just opened. The
  // overlays never displayed even though the command executed.
  test('overlays opened by a command during the feed survive the write-back, and Escape still closes them', async () => {
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
    // Mirror the real shell-core handlers: synchronous ctx.open*Overlay call.
    registry.register({ name: 'shortcuts', description: 'overlay', handler: (_args, ctx) => { ctx.openShortcutsOverlay?.(); } });
    registry.register({ name: 'commands', description: 'overlay', handler: (_args, ctx) => { ctx.openHelpOverlay?.(); } });
    const context = makeCommandContext({});
    // Mirror ui-openers exactly: the opener mutates the handler directly.
    context.openShortcutsOverlay = () => {
      if (!input.shortcutsOverlayActive) input.modalOpened('shortcuts');
      input.shortcutsOverlayActive = !input.shortcutsOverlayActive;
      input.shortcutsScrollOffset = 0;
    };
    context.openHelpOverlay = () => {
      if (!input.helpOverlayActive) input.modalOpened('help');
      input.helpOverlayActive = !input.helpOverlayActive;
      input.helpScrollOffset = 0;
    };
    input.setCommandRegistry(registry, context);

    input.feed('/shortcuts\r');
    await Promise.resolve();
    expect(input.shortcutsOverlayActive).toBe(true);
    expect(input.modalStack).toEqual(['shortcuts']);

    // The pipeline-driven close path must still apply (Escape).
    input.feed('\x1b');
    expect(input.shortcutsOverlayActive).toBe(false);
    expect(input.modalStack).toEqual([]);

    input.feed('/commands\r');
    await Promise.resolve();
    expect(input.helpOverlayActive).toBe(true);
    expect(input.modalStack).toEqual(['help']);

    input.feed('\x1b');
    expect(input.helpOverlayActive).toBe(false);
    expect(input.modalStack).toEqual([]);
  });

  // Papercut sweep item 1: the same stale-snapshot write-back class of bug as
  // above, but at the per-token dispatch layer (handler-feed.ts)
  // rather than the per-feed layer (handler.ts). handleGlobalShortcutToken's
  // 'escape' branch calls context.handleEscape(), which mutates the handler
  // AND immediately syncs the live context (see handler.ts's
  // syncFeedContextMutableFields comment) — but the caller in handler-feed.ts
  // used to unconditionally copy back a `shortcutState` snapshot taken
  // *before* that call, stomping the just-cleared prompt/commandMode back to
  // their stale pre-escape values and even re-arming the autocomplete query.
  // Net effect: pressing Esc with the slash palette open did nothing visible
  // and the user had to backspace the '/' out by hand.
  test('Esc on a bare "/" closes the palette and clears the composer in one press', async () => {
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
    registry.register({ name: 'help', description: 'Help', handler: () => {} });
    input.setCommandRegistry(registry, makeCommandContext());

    input.feed('/');
    expect(input.commandMode).toBe(true);
    expect(input.prompt).toBe('/');
    expect(input.autocomplete?.isActive).toBe(true);

    input.feed('\x1b');

    expect(input.commandMode).toBe(false);
    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(input.modalStack).toEqual([]);
    expect(input.autocomplete?.isActive).toBe(false);
  });

  // Convention for the "typed past the slash" case (fzf-style): once there's
  // real content beyond the bare '/', Esc's job is only to dismiss the ghost-
  // suggestion overlay — the typed text is real composer content the user
  // asked for and is kept, just no longer treated as an in-progress command.
  test('Esc on "/help" (typed past the slash) closes the palette but keeps the typed text', async () => {
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
    registry.register({ name: 'help', description: 'Help', handler: () => {} });
    input.setCommandRegistry(registry, makeCommandContext());

    input.feed('/help');
    expect(input.commandMode).toBe(true);
    expect(input.prompt).toBe('/help');
    expect(input.autocomplete?.isActive).toBe(true);

    input.feed('\x1b');

    expect(input.commandMode).toBe(false);
    expect(input.prompt).toBe('/help');
    expect(input.cursorPos).toBe('/help'.length);
    expect(input.modalStack).toEqual([]);
    expect(input.autocomplete?.isActive).toBe(false);
  });
});
