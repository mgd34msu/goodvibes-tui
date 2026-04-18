import type { ConfigManager } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { MutableRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/mutable-runtime-state';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';

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
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
};

/**
 * Derive the configuredVia tier for a provider.
 * Checks env-vars first (env tier), then falls back to subscription (from configuredIds
 * that aren't env-keyed). Returns undefined when not configured.
 */
function deriveConfiguredVia(
  providerId: string,
  configuredIds: Set<string>,
  subscriptionManager: SubscriptionManager,
): 'env' | 'secrets' | 'subscription' | 'anonymous' | undefined {
  if (!configuredIds.has(providerId)) return undefined;

  // Check if a subscription session is active for this provider
  const subs = subscriptionManager.list();
  if (subs.some((s) => s.provider === providerId)) return 'subscription';

  // Assume env-var backed (anonymous providers don't appear in configuredIds)
  return 'env';
}

/**
 * Build a configuredViaMap for the given provider list.
 */
function buildConfiguredViaMap(
  providers: string[],
  configuredIds: Set<string>,
  subscriptionManager: SubscriptionManager,
): Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'> {
  const map = new Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>();
  for (const p of providers) {
    const via = deriveConfiguredVia(p, configuredIds, subscriptionManager);
    if (via !== undefined) map.set(p, via);
  }
  return map;
}

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
    serviceRegistry,
    getConfiguredProviderIds,
    getPinned,
    render,
  } = options;

  commandContext.openModelPicker = () => {
    const models = providerRegistry.getSelectableModels();
    const configuredIds = new Set(getConfiguredProviderIds());
    input.modelPicker.configuredProviders = configuredIds;
    const providerIds = [...new Set(models.map((m) => m.provider))];
    input.modelPicker.configuredViaMap = buildConfiguredViaMap(providerIds, configuredIds, subscriptionManager);
    void getPinned().then((pinned) => {
      input.modelPicker.pinnedIds = new Set(pinned);
    });
    void input.modelPicker.loadRecentModels().catch(() => {}); // best-effort: prefetch for UI, failure is non-visible
    input.modalOpened('modelPicker');
    input.modelPicker.openAllModels(models, runtime.model);
    render();
  };

  commandContext.openProviderPicker = () => {
    const providers = [...new Set(providerRegistry.listModels().map((model) => model.provider))];
    const configuredIds = new Set(getConfiguredProviderIds());
    input.modelPicker.configuredProviders = configuredIds;
    input.modelPicker.configuredViaMap = buildConfiguredViaMap(providers, configuredIds, subscriptionManager);
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
    input.settingsModal.open(configManager, featureFlags, subscriptionManager, serviceRegistry, mcpRegistry);
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
          panelManager.open('panel-list');
        } catch {
          // non-fatal
        }
      }
      panelManager.show();
      input.panelFocused = true;
      conversation.setSplashSuppressed(true);
      conversation.rebuildHistory();
    } else if (!input.panelFocused) {
      if (panelManager.getAllOpen().length === 0) {
        try {
          panelManager.open('panel-list');
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
