import type { ConfigManager } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { MutableRuntimeState } from '../runtime/context.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.ts';
import type { McpRegistry } from '../mcp/registry.ts';
import type { SubscriptionManager } from '../config/subscriptions.ts';

type WireShellUiOpenersOptions = {
  commandContext: CommandContext;
  input: InputHandler;
  panelManager: PanelManager;
  conversation: ConversationManager;
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: MutableRuntimeState;
  featureFlags: FeatureFlagManager;
  mcpRegistry: McpRegistry;
  subscriptionManager: SubscriptionManager;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
};

export function wireShellUiOpeners(options: WireShellUiOpenersOptions): void {
  const {
    commandContext,
    input,
    panelManager,
    conversation,
    configManager,
    providerRegistry,
    runtime,
    featureFlags,
    mcpRegistry,
    subscriptionManager,
    getConfiguredProviderIds,
    getPinned,
    render,
  } = options;

  commandContext.openModelPicker = () => {
    const models = providerRegistry.getSelectableModels();
    input.modelPicker.configuredProviders = new Set(getConfiguredProviderIds());
    void getPinned().then((pinned) => {
      input.modelPicker.pinnedIds = new Set(pinned);
    });
    void input.modelPicker.loadRecentModels().catch(() => {});
    input.modalOpened('modelPicker');
    input.modelPicker.openAllModels(models, runtime.model);
    render();
  };

  commandContext.openProviderPicker = () => {
    const providers = [...new Set(providerRegistry.listModels().map((model) => model.provider))];
    input.modelPicker.configuredProviders = new Set(getConfiguredProviderIds());
    input.modalOpened('modelPicker');
    input.modelPicker.openProviders(providers, runtime.provider);
    render();
  };

  commandContext.openSelection = (title, items, opts, callback) => {
    input.openSelection(title, items, opts, callback);
  };

  commandContext.openContextInspector = () => {
    input.modalOpened('contextInspector');
    input.contextInspectorModal.open();
    render();
  };

  commandContext.openBookmarkModal = () => {
    input.modalOpened('bookmark');
    input.bookmarkModal.open();
    render();
  };

  commandContext.openHelpOverlay = () => {
    if (!input.helpOverlayActive) input.modalOpened('help');
    input.helpOverlayActive = !input.helpOverlayActive;
    input.helpScrollOffset = 0;
  };

  commandContext.openShortcutsOverlay = () => {
    if (!input.shortcutsOverlayActive) input.modalOpened('shortcuts');
    input.shortcutsOverlayActive = !input.shortcutsOverlayActive;
    input.shortcutsScrollOffset = 0;
    render();
  };

  commandContext.openProfilePicker = () => {
    input.modalOpened('profilePicker');
    input.profilePickerModal.open();
    render();
  };

  commandContext.openSettingsModal = () => {
    input.modalOpened('settings');
    input.settingsModal.open(configManager, featureFlags, subscriptionManager, mcpRegistry);
    render();
  };

  commandContext.openSessionPicker = () => {
    input.modalOpened('sessionPicker');
    input.sessionPickerModal.open();
    render();
  };

  commandContext.openPanelPicker = () => {
    if (!panelManager.isVisible()) {
      if (panelManager.getAllOpen().length === 0) {
        try {
          panelManager.open('docs');
        } catch {
          // non-fatal
        }
      }
      panelManager.show();
      input.panelFocused = true;
      conversation.setSplashSuppressed(true);
      conversation.rebuildHistory();
    } else {
      panelManager.hide();
      input.panelFocused = false;
      conversation.setSplashSuppressed(false);
      conversation.rebuildHistory();
    }
    render();
  };

  commandContext.focusPanels = () => {
    if (!panelManager.isVisible() || panelManager.getAllOpen().length === 0) return;
    input.panelFocused = true;
    render();
  };

  commandContext.showPanel = (panelId, pane) => {
    panelManager.open(panelId, pane);
    panelManager.show();
    input.panelFocused = true;
    conversation.setSplashSuppressed(true);
    conversation.rebuildHistory();
    render();
  };
}
