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
import type { SecretsManager } from '@pellux/goodvibes-sdk/platform/config/secrets';
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
  secretsManager?: Pick<SecretsManager, 'get'>;
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
};

/**
 * Derive the configuredVia tier for a provider.
 * Tier order mirrors SDK provider-routes.ts: env → secrets → subscription → undefined.
 * The preResolvedSecretKeys set is pre-fetched async before the sync picker render cycle.
 */
function deriveConfiguredVia(
  providerId: string,
  configuredIds: Set<string>,
  subscriptionManager: SubscriptionManager,
  preResolvedSecretKeys?: ReadonlySet<string>,
): 'env' | 'secrets' | 'subscription' | 'anonymous' | undefined {
  if (!configuredIds.has(providerId)) return undefined;

  // Tier 1: subscription check (most specific — subscription overrides env for this provider)
  const subs = subscriptionManager.list();
  if (subs.some((s) => s.provider === providerId)) return 'subscription';

  // Tier 2: env-var present (process.env check; anonymous providers don't appear in configuredIds)
  // We don't have BUILTIN_PROVIDER_ENV_KEYS here; if env was used the configuredIds path covers it.
  // The presence in configuredIds and no subscription → either env or secrets.
  // Tier 3: secrets-manager backed (pre-resolved async batch)
  if (preResolvedSecretKeys && preResolvedSecretKeys.has(providerId)) return 'secrets';

  return 'env';
}

/**
 * Build a configuredViaMap for the given provider list.
 * Pass preResolvedSecretKeys (from an async SecretsManager batch) to surface the 'secrets' tier.
 */
function buildConfiguredViaMap(
  providers: string[],
  configuredIds: Set<string>,
  subscriptionManager: SubscriptionManager,
  preResolvedSecretKeys?: ReadonlySet<string>,
): Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'> {
  const map = new Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>();
  for (const p of providers) {
    const via = deriveConfiguredVia(p, configuredIds, subscriptionManager, preResolvedSecretKeys);
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
    secretsManager,
    serviceRegistry,
    getConfiguredProviderIds,
    getPinned,
    render,
  } = options;

  /**
   * Pre-resolve which provider IDs have secrets-manager keys (async batch, SDK tier pattern).
   * Returns a set of provider IDs (not env var names) that are secrets-backed.
   * Falls back to empty set if secretsManager is not provided.
   */
  async function resolveSecretProviderIds(): Promise<ReadonlySet<string>> {
    if (!secretsManager) return new Set<string>();
    const configuredIds = new Set(getConfiguredProviderIds());
    // For each configured provider, check if secretsManager has a key for it by provider ID.
    // We use provider ID as the lookup key since we don't have BUILTIN_PROVIDER_ENV_KEYS here.
    const results = await Promise.all(
      [...configuredIds].map(async (providerId) => {
        const val = await secretsManager.get(providerId).catch(() => null);
        return val !== null ? providerId : null;
      }),
    );
    return new Set(results.filter((v): v is string => v !== null));
  }

  const getCurrentModelForPickerTarget = (): string => {
    const target = input.modelPicker.target;
    if (target === 'helper') return String(configManager.get('helper.globalModel') || runtime.model);
    if (target === 'tool') return String(configManager.get('tools.llmModel') || runtime.model);
    if (target === 'tts') return String(configManager.get('tts.llmModel') || runtime.model);
    return runtime.model;
  };

  commandContext.openModelPicker = () => {
    void (async () => {
      const models = providerRegistry.getSelectableModels();
      const configuredIds = new Set(getConfiguredProviderIds());
      input.modelPicker.configuredProviders = configuredIds;
      const providerIds = [...new Set(models.map((m) => m.provider))];
      const secretProviderIds = await resolveSecretProviderIds();
      input.modelPicker.configuredViaMap = buildConfiguredViaMap(providerIds, configuredIds, subscriptionManager, secretProviderIds);
      void getPinned().then((pinned) => {
        input.modelPicker.pinnedIds = new Set(pinned);
      });
      void input.modelPicker.loadRecentModels().catch(() => {}); // best-effort: prefetch for UI, failure is non-visible
      input.modalOpened('modelPicker');
      input.modelPicker.openAllModels(models, getCurrentModelForPickerTarget());
      render();
    })().catch((error: unknown) => {
      commandContext.print?.(`Model picker failed to open: ${error instanceof Error ? error.message : String(error)}`);
      render();
    });
  };

  commandContext.openModelPickerWithTarget = (target) => input.openModelPickerWithTarget(target);

  commandContext.openProviderPicker = () => {
    void (async () => {
      const providers = [...new Set(providerRegistry.listModels().map((model) => model.provider))];
      const configuredIds = new Set(getConfiguredProviderIds());
      input.modelPicker.configuredProviders = configuredIds;
      const secretProviderIds = await resolveSecretProviderIds();
      input.modelPicker.configuredViaMap = buildConfiguredViaMap(providers, configuredIds, subscriptionManager, secretProviderIds);
      input.modalOpened('modelPicker');
      input.modelPicker.openProviders(providers, runtime.provider);
      render();
    })().catch((error: unknown) => {
      commandContext.print?.(`Provider picker failed to open: ${error instanceof Error ? error.message : String(error)}`);
      render();
    });
  };

  commandContext.openSelection = (title, items, opts, callback) => {
    input.openSelection(title, items, opts, callback);
  };

  commandContext.openOnboardingWizard = (modeOrOptions) => {
    input.openOnboardingWizard(modeOrOptions);
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
