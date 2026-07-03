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
    commandContext = {};
    input = {
      indicatorFocused: false,
      modelPicker: {},
      modalOpened: mock(() => {}),
    };
    panelManager = {
      isVisible: mock(() => false),
      getAllOpen: mock(() => []),
      getFocusTarget: mock(() => 'prompt'),
      open: mock(() => ({})),
      show: mock(() => {}),
      hide: mock(() => {}),
      focusPanels: mock(() => {}),
      focusPrompt: mock(() => {}),
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

  test('openPanelPicker focuses panels when opening the workspace', () => {
    (commandContext.openPanelPicker as () => void)();
    expect(panelManager.open).toHaveBeenCalledWith('panel-list');
    expect(panelManager.show).toHaveBeenCalled();
    expect(panelManager.focusPanels).toHaveBeenCalled();
    expect(panelManager.hide).not.toHaveBeenCalled();
    expect(conversation.setSplashSuppressed).toHaveBeenCalledWith(true);
  });

  test('openPanelPicker focuses an already-visible-but-unfocused workspace instead of hiding it', () => {
    (panelManager.isVisible as ReturnType<typeof mock>).mockReturnValue(true);
    (panelManager.getAllOpen as ReturnType<typeof mock>).mockReturnValue([{ id: 'system-messages' }]);
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
});
