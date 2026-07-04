import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

describe('wireShellUiOpeners', () => {
  let commandContext: Record<string, unknown>;
  let input: Record<string, unknown>;
  let panelManager: Record<string, unknown>;
  let conversation: Record<string, unknown>;
  let render: ReturnType<typeof mock>;
  let testManagers = createTestManagers();

  beforeEach(() => {
    testManagers = createTestManagers();
    commandContext = { print: mock(() => {}) };
    input = {
      indicatorFocused: false,
      modelPicker: {},
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
      providerRegistry: {} as never,
      runtime: {} as never,
      featureFlags: {} as never,
      mcpRegistry: {} as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
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
});
