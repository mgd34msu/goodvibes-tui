import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { PanelManager } from '../../panels/panel-manager.ts';

interface FakeEmbeddingStatus {
  readonly id: string;
  readonly label: string;
  readonly dimensions: number;
  readonly configured: boolean;
  readonly detail?: string;
}

function makeFakeEmbeddingRegistry(options: {
  defaultProviderId?: string;
  statuses?: FakeEmbeddingStatus[];
} = {}) {
  let defaultProviderId = options.defaultProviderId ?? 'hashed-local';
  const statuses = options.statuses ?? [
    { id: 'hashed-local', label: 'Hashed Local Embeddings', dimensions: 384, configured: true },
    { id: 'openai', label: 'OpenAI Embeddings', dimensions: 1536, configured: false, detail: 'Set OPENAI_API_KEY to enable.' },
  ];
  return {
    getDefaultProviderId: mock(() => defaultProviderId),
    setDefaultProvider: mock((id: string) => {
      if (!statuses.some((s) => s.id === id)) throw new Error(`Unknown memory embedding provider: ${id}`);
      defaultProviderId = id;
    }),
    status: mock(async () => statuses),
  };
}

describe('wireShellUiOpeners', () => {
  let commandContext: Record<string, unknown>;
  let input: Record<string, unknown>;
  let panelManager: Record<string, unknown>;
  let conversation: Record<string, unknown>;
  let render: ReturnType<typeof mock>;
  let testManagers = createTestManagers();
  let fakeEmbeddingRegistry = makeFakeEmbeddingRegistry();

  beforeEach(() => {
    testManagers = createTestManagers();
    fakeEmbeddingRegistry = makeFakeEmbeddingRegistry();
    commandContext = { print: mock(() => {}) };
    input = {
      indicatorFocused: false,
      modelPicker: {
        embeddingProviders: [],
        setTargetInfos: mock(() => {}),
        openAllModels: mock(() => {}),
        openProviders: mock(() => {}),
        loadRecentModels: mock(async () => {}),
        getSelectedTargetInfo: mock(() => null),
        target: 'main',
      },
      modalOpened: mock(() => {}),
      openSelection: mock(() => {}),
    };
    panelManager = {
      isVisible: mock(() => false),
      getAllOpen: mock(() => []),
      getFocusTarget: mock(() => 'prompt'),
      getRegisteredTypes: mock(() => [
        { id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: 'fleet' },
        { id: 'git', name: 'Git', icon: 'G', category: 'development', description: 'git' },
      ]),
      open: mock(() => ({})),
      show: mock(() => {}),
      hide: mock(() => {}),
      focusPanels: mock(() => {}),
      focusPrompt: mock(() => {}),
      setOpenModalCallback: mock(() => {}),
      // W6.1: no config-modal surface registered on this bare mock manager, so
      // getModalSurface always resolves to undefined (the honest no-op path).
      getModalSurface: mock(() => undefined),
    };
    conversation = {
      setSplashSuppressed: mock(() => {}),
      rebuildHistory: mock(() => {}),
    };
    render = mock(() => {});

    wireShellUiOpeners({
      commandContext: commandContext as never,
      input: input as never,
      panelManager: panelManager as never,
      conversation: conversation as never,
      configManager: testManagers.configManager,
      providerRegistry: { getSelectableModels: () => [], listModels: () => [] } as never,
      runtime: { model: 'm', provider: 'p' } as never,
      featureFlags: {} as never,
      mcpRegistry: {} as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
      memoryEmbeddingRegistry: fakeEmbeddingRegistry as never,
      getConfiguredProviderIds: () => [],
      getPinned: async () => [],
      render,
    });
  });

  // W6.1 (the purge): 'panel-list' (a picker PANEL) was DELETE-disposition.
  // openPanelPicker now opens a selection MODAL built from the live
  // registry instead of force-opening a specific panel — see
  // shell/ui-openers.ts.
  test('openPanelPicker opens a selection modal built from the live registry when nothing is open', () => {
    (commandContext.openPanelPicker as () => void)();
    expect(input.openSelection).toHaveBeenCalledTimes(1);
    const [title, items] = (input.openSelection as ReturnType<typeof mock>).mock.calls[0] as [string, Array<{ id: string }>, unknown, unknown];
    expect(title).toBe('Open Panel');
    expect(items.map((i) => i.id)).toEqual(['fleet', 'git']);
    // No panel is opened until the user actually picks one.
    expect(panelManager.open).not.toHaveBeenCalled();
  });

  test('openPanelPicker opens the selected panel once the selection modal resolves', () => {
    (commandContext.openPanelPicker as () => void)();
    const callback = (input.openSelection as ReturnType<typeof mock>).mock.calls[0]![3] as (result: unknown) => void;
    callback({ item: { id: 'git' }, action: 'select' });
    expect(panelManager.open).toHaveBeenCalledWith('git');
    expect(panelManager.show).toHaveBeenCalled();
    expect(panelManager.focusPanels).toHaveBeenCalled();
    expect(panelManager.hide).not.toHaveBeenCalled();
    expect(conversation.setSplashSuppressed).toHaveBeenCalledWith(true);
  });

  test('openPanelPicker does nothing when the selection modal is cancelled', () => {
    (commandContext.openPanelPicker as () => void)();
    const callback = (input.openSelection as ReturnType<typeof mock>).mock.calls[0]![3] as (result: unknown) => void;
    callback(null);
    expect(panelManager.open).not.toHaveBeenCalled();
    expect(panelManager.show).not.toHaveBeenCalled();
  });

  test('openPanelPicker focuses an already-visible-but-unfocused workspace instead of hiding it', () => {
    (panelManager.isVisible as ReturnType<typeof mock>).mockReturnValue(true);
    (panelManager.getAllOpen as ReturnType<typeof mock>).mockReturnValue([{ id: 'git' }]);
    (panelManager.getFocusTarget as ReturnType<typeof mock>).mockReturnValue('prompt');
    (commandContext.openPanelPicker as () => void)();
    expect(panelManager.hide).not.toHaveBeenCalled();
    expect(panelManager.show).toHaveBeenCalled();
    expect(panelManager.focusPanels).toHaveBeenCalled();
  });

  test('openPanelPicker clears panel focus when hiding an already-focused workspace', () => {
    (panelManager.isVisible as ReturnType<typeof mock>).mockReturnValue(true);
    (panelManager.getAllOpen as ReturnType<typeof mock>).mockReturnValue([{ id: 'docs' }]);
    (panelManager.getFocusTarget as ReturnType<typeof mock>).mockReturnValue('panel');
    (commandContext.openPanelPicker as () => void)();
    expect(panelManager.hide).toHaveBeenCalled();
    expect(panelManager.focusPrompt).toHaveBeenCalled();
    expect(conversation.setSplashSuppressed).toHaveBeenCalledWith(false);
  });

  test('showPanel opens, shows, and focuses the panel workspace', () => {
    (commandContext.showPanel as (panelId: string) => void)('tasks');
    expect(panelManager.open).toHaveBeenCalledWith('tasks', undefined);
    expect(panelManager.show).toHaveBeenCalled();
    expect(panelManager.focusPanels).toHaveBeenCalled();
    expect(conversation.setSplashSuppressed).toHaveBeenCalledWith(true);
  });

  test('openOnboardingWizard delegates through the shared opener seam', () => {
    input.openOnboardingWizard = mock(() => {});
    (commandContext.openOnboardingWizard as (mode?: 'new' | 'edit') => void)('new');
    expect(input.openOnboardingWizard).toHaveBeenCalledWith('new');
    expect(render).not.toHaveBeenCalled();
  });

  // W6.1 (the purge): openModal resolves the name to a registered config-modal
  // surface (PanelManager.getModalSurface). With no surface registered it must
  // stay a safe, honest no-op — an explanatory print, not a throw or a blank
  // modal. The same callback is injected into PanelManager for redirect hits.
  test('openModal is wired onto both CommandContext and PanelManager, and is safe with no real modal registered', () => {
    expect(panelManager.setOpenModalCallback).toHaveBeenCalledWith(commandContext.openModal);
    (commandContext.openModal as (name: string) => void)('providers-modal');
    expect(panelManager.getModalSurface).toHaveBeenCalledWith('providers-modal');
    expect(commandContext.print).toHaveBeenCalledWith("'providers-modal' is not available yet in this build.");
    expect(render).toHaveBeenCalled();
  });

  // W6 review (finding 3): the retired 'sessions' front door redirects to the
  // NATIVE session-picker modal ('sessionPicker'), which is NOT a
  // ConfigModalSurface — getModalSurface can never find it, so before the fix
  // the openModal callback printed "'sessionPicker' is not available yet in
  // this build." A small native-modal dispatch, consulted before
  // getModalSurface, now routes it to the real opener.
  test("openModal routes the native 'sessionPicker' target to the session-picker modal, not the honest-print fallback", () => {
    const open = mock(() => {});
    (input as Record<string, unknown>).sessionPickerModal = { open };
    (commandContext.openModal as (name: string) => void)('sessionPicker');
    expect(open).toHaveBeenCalledTimes(1);
    expect(input.modalOpened).toHaveBeenCalledWith('sessionPicker');
    // The native dispatch is consulted BEFORE getModalSurface — which never
    // sees 'sessionPicker' — and the old "not available yet" lie is gone.
    expect(panelManager.getModalSurface).not.toHaveBeenCalledWith('sessionPicker');
    expect(commandContext.print).not.toHaveBeenCalledWith("'sessionPicker' is not available yet in this build.");
  });

  test("PanelManager.open('sessions') redirect opens the session picker end to end (no lie); the restore skip hook resolves honestly", () => {
    const open = mock(() => {});
    (input as Record<string, unknown>).sessionPickerModal = { open };
    const realPm = new PanelManager();
    realPm.registerModalRedirect('sessions', 'sessionPicker');
    // Inject the SAME production openModal callback the shell wires onto
    // PanelManager, then drive open('sessions') exactly as a front door or a
    // saved-layout restore would.
    realPm.setOpenModalCallback(commandContext.openModal as (name: string) => void);

    realPm.open('sessions');

    expect(open).toHaveBeenCalledTimes(1);
    expect(commandContext.print).not.toHaveBeenCalledWith("'sessionPicker' is not available yet in this build.");
    // reopenPanelsFromReturnContext skips redirects via getModalRedirect and
    // notes them honestly instead of opening a phantom panel — assert that hook
    // still resolves 'sessions' -> the picker modal name.
    expect(realPm.getModalRedirect('sessions')).toBe('sessionPicker');
  });

  describe('embeddings target (B29)', () => {
    async function openModelPickerAndFlush(): Promise<void> {
      (commandContext.openModelPicker as () => void)();
      // openModelPicker's body is a fire-and-forget async IIFE (`void (async () => ...)()`);
      // a macrotask tick lets every microtask-based await inside it settle before assertions.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    function getModelPicker(): Record<string, unknown> {
      return input.modelPicker as Record<string, unknown>;
    }

    test('adds a 5th "embeddings" target with an honest provider + dimensions + configured note', async () => {
      await openModelPickerAndFlush();

      const setTargetInfos = getModelPicker().setTargetInfos as ReturnType<typeof mock>;
      expect(setTargetInfos).toHaveBeenCalledTimes(1);
      const targets = setTargetInfos.mock.calls[0]![0] as Array<{ target: string; label: string; configuredNote?: string; model: string }>;
      expect(targets.map((t) => t.target)).toEqual(['main', 'helper', 'tool', 'tts', 'embeddings']);

      const embeddingsTarget = targets.find((t) => t.target === 'embeddings')!;
      expect(embeddingsTarget.label).toBe('Embeddings');
      expect(embeddingsTarget.model).toBe(''); // no phantom model value
      expect(embeddingsTarget.configuredNote).toBe('hashed-local · 384d');
    });

    test('the four existing targets are unchanged', async () => {
      await openModelPickerAndFlush();

      const setTargetInfos = getModelPicker().setTargetInfos as ReturnType<typeof mock>;
      const targets = setTargetInfos.mock.calls[0]![0] as Array<{ target: string; label: string }>;
      expect(targets.find((t) => t.target === 'main')?.label).toBe('Main Chat');
      expect(targets.find((t) => t.target === 'helper')?.label).toBe('Helper Model');
      expect(targets.find((t) => t.target === 'tool')?.label).toBe('Tool LLM');
      expect(targets.find((t) => t.target === 'tts')?.label).toBe('TTS LLM');
    });

    test('populates the picker\'s embedding-provider list, showing unconfigured providers honestly', async () => {
      await openModelPickerAndFlush();

      const embeddingProviders = getModelPicker().embeddingProviders as Array<{ id: string; configured: boolean }>;
      expect(embeddingProviders).toHaveLength(2);
      expect(embeddingProviders.find((p) => p.id === 'hashed-local')?.configured).toBe(true);
      expect(embeddingProviders.find((p) => p.id === 'openai')?.configured).toBe(false);
    });

    test('an unregistered persisted default renders honestly instead of a fabricated note', async () => {
      fakeEmbeddingRegistry.getDefaultProviderId.mockReturnValue('vanished-provider');
      await openModelPickerAndFlush();

      const setTargetInfos = getModelPicker().setTargetInfos as ReturnType<typeof mock>;
      const targets = setTargetInfos.mock.calls[0]![0] as Array<{ target: string; configuredNote?: string }>;
      expect(targets.find((t) => t.target === 'embeddings')?.configuredNote).toBe('vanished-provider · unregistered');
    });

    test('completeEmbeddingProviderSelection persists the selection via the registry', () => {
      (commandContext.completeEmbeddingProviderSelection as (id: string) => void)('openai');
      expect(fakeEmbeddingRegistry.setDefaultProvider).toHaveBeenCalledWith('openai');
      expect(render).toHaveBeenCalled();
    });

    test('completeEmbeddingProviderSelection reports an honest error for an unknown provider id', () => {
      const print = mock(() => {});
      commandContext.print = print;
      (commandContext.completeEmbeddingProviderSelection as (id: string) => void)('does-not-exist');
      expect(print).toHaveBeenCalledWith(expect.stringContaining('Failed to set embedding provider'));
    });
  });
});
