import type { ConfigManager } from '../config/index.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import type { ConversationManager } from '../core/conversation';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
import type { EmbeddingProviderPickerEntry, ModelPickerTargetInfo } from '../input/model-picker.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import { categorizeBuiltinCommands } from '../input/commands.ts';
import { syncServiceSettingToPlatform } from './service-settings-sync.ts';
import { setActiveThemeMode } from '../renderer/theme.ts';
import { THEME_MODE_CONFIG_KEY, coerceThemeModeSetting } from '../renderer/theme-mode-config.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { buildFirstOpenItems, decodeFirstOpenChoice, selfRecordWorkspaceRegistration } from '../cli/tui-startup.ts';
import type { WorkspaceTrustLevel } from '../runtime/trust/workspace-trust.ts';

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
  secretsManager?: Pick<SecretsManager, 'delete' | 'get' | 'set'>;
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  /** Backs the model picker's 'embeddings' target and its own item-list mode. */
  memoryEmbeddingRegistry: Pick<MemoryEmbeddingProviderRegistry, 'getDefaultProviderId' | 'setDefaultProvider' | 'status'>;
  workingDirectory: string;
  homeDirectory: string;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
  /** Trust-at-consequence-time bridge — patched here with the real modal-driving implementation. */
  trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> };
};

let commandCategoryMapCache: Map<string, string> | null = null;

/**
 * Map each built-in command name to its reference category, memoized. Drives
 * the command palette's category grouping from the same single source of truth
 * as the generated docs (categorizeBuiltinCommands), so the palette is always
 * registry-derived and never a hand-maintained list.
 */
function getCommandCategoryMap(): Map<string, string> {
  if (!commandCategoryMapCache) {
    commandCategoryMapCache = new Map(
      categorizeBuiltinCommands().map((entry) => [entry.command.name, entry.category]),
    );
  }
  return commandCategoryMapCache;
}

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
    memoryEmbeddingRegistry,
    workingDirectory,
    homeDirectory,
    getConfiguredProviderIds,
    getPinned,
    render,
    trustPromptRef,
  } = options;

  // Trust-at-consequence-time: raised by trustGatedAsk on the first non-read
  // request in an undecided workspace; the answer persists via setLevel().
  // Registration self-records here too when trusted (never for restricted —
  // see selfRecordWorkspaceRegistration's doc).
  trustPromptRef.requestTrustDecision = () =>
    new Promise((resolve) => {
      const { title, items } = buildFirstOpenItems();
      if (!commandContext.openSelection) { resolve('restricted'); return; } // no selection surface (should not happen live)
      commandContext.openSelection(title, items, { allowSearch: false, primaryVerbLabel: 'Choose' }, (result) => {
        const level = decodeFirstOpenChoice(result?.item.id ?? null);
        resolve(level);
        if (level === 'trusted') void selfRecordWorkspaceRegistration(commandContext.workspace?.workspaceRegistrationManager);
        render();
      });
    });

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
    const selectedTarget = input.modelPicker.getSelectedTargetInfo();
    const target = selectedTarget?.target ?? input.modelPicker.target;
    if (target === 'helper') return String(configManager.get('helper.globalModel') || runtime.model);
    if (target === 'tool') return String(configManager.get('tools.llmModel') || runtime.model);
    if (target === 'tts') return String(configManager.get('tts.llmModel') || runtime.model);
    if (target === 'embeddings') return memoryEmbeddingRegistry.getDefaultProviderId();
    return runtime.model;
  };

  const getCurrentProviderForPickerTarget = (): string => {
    const selectedTarget = input.modelPicker.getSelectedTargetInfo();
    const target = selectedTarget?.target ?? input.modelPicker.target;
    if (target === 'helper') return String(configManager.get('helper.globalProvider') || runtime.provider);
    if (target === 'tool') return String(configManager.get('tools.llmProvider') || runtime.provider);
    if (target === 'tts') return String(configManager.get('tts.llmProvider') || runtime.provider);
    if (target === 'embeddings') return memoryEmbeddingRegistry.getDefaultProviderId();
    return runtime.provider;
  };

  /**
   * Fetch the embedding-provider status list once per picker-open and shape
   * it into the picker's own tiny item type. Uses the registry's async
   * `.status()` (not the sync `.list()`) specifically because `.list()` does
   * not carry `configured` — and unconfigured providers must be shown
   * honestly, not hidden.
   */
  async function resolveEmbeddingProviderEntries(): Promise<EmbeddingProviderPickerEntry[]> {
    const statuses = await memoryEmbeddingRegistry.status();
    return statuses.map((status) => ({
      id: status.id,
      label: status.label,
      dimensions: status.dimensions,
      configured: status.configured,
      ...(status.detail ? { detail: status.detail } : {}),
    }));
  }

  const buildModelPickerTargets = (embeddingEntries: EmbeddingProviderPickerEntry[]): ModelPickerTargetInfo[] => {
    const mainProvider = getProviderIdFromModel(configManager.get('provider.model') || runtime.provider).trim();
    const mainModel = String(configManager.get('provider.model') || runtime.model || '').trim();
    const helperProvider = String(configManager.get('helper.globalProvider') ?? '').trim();
    const helperModel = String(configManager.get('helper.globalModel') ?? '').trim();
    const toolProvider = String(configManager.get('tools.llmProvider') ?? '').trim();
    const toolModel = String(configManager.get('tools.llmModel') ?? '').trim();
    const ttsProvider = String(configManager.get('tts.llmProvider') ?? '').trim();
    const ttsModel = String(configManager.get('tts.llmModel') ?? '').trim();
    const embeddingProviderId = memoryEmbeddingRegistry.getDefaultProviderId();
    const embeddingEntry = embeddingEntries.find((entry) => entry.id === embeddingProviderId);
    const embeddingNote = embeddingEntry
      ? `${embeddingEntry.id} · ${embeddingEntry.dimensions}d${embeddingEntry.configured ? '' : ' · unconfigured'}`
      : `${embeddingProviderId} · unregistered`;

    return [
      {
        target: 'main',
        label: 'Main Chat',
        description: 'Default provider and model for normal chat turns in this TUI session.',
        provider: mainProvider,
        model: mainModel,
        enabled: true,
        inherited: false,
      },
      {
        target: 'helper',
        label: 'Helper Model',
        description: 'Optional helper route used for supporting work. Empty provider/model values inherit Main Chat.',
        provider: helperProvider || mainProvider,
        model: helperModel || mainModel,
        enabled: Boolean(configManager.get('helper.enabled')),
        inherited: helperProvider.length === 0 && helperModel.length === 0,
      },
      {
        target: 'tool',
        label: 'Tool LLM',
        description: 'Optional LLM route for tool-specific reasoning. Selecting a model enables the tool LLM route.',
        provider: toolProvider || mainProvider,
        model: toolModel || mainModel,
        enabled: Boolean(configManager.get('tools.llmEnabled')),
        inherited: toolProvider.length === 0 && toolModel.length === 0,
      },
      {
        target: 'tts',
        label: 'TTS LLM',
        description: 'Optional LLM override for /tts response generation. Empty values use the current chat model.',
        provider: ttsProvider || mainProvider,
        model: ttsModel || mainModel,
        enabled: true,
        inherited: ttsProvider.length === 0 && ttsModel.length === 0,
      },
      {
        target: 'embeddings',
        label: 'Embeddings',
        description: 'Embedding provider used for memory search and the code index. Not an LLM route — no model concept.',
        provider: embeddingProviderId,
        model: '',
        enabled: true,
        inherited: false,
        configuredNote: embeddingNote,
      },
    ];
  };

  commandContext.openModelPicker = () => {
    // Picker-open re-check: re-verify each provider's live model list (TTL-
    // respecting) so a freshly-opened picker reflects models the provider
    // started or stopped serving. Fire-and-forget; a completed refresh re-renders
    // so the list updates in place without blocking the open.
    void providerRegistry.refreshLiveModelDiscovery?.().then((reports) => {
      if (reports.some((report) => report.added.length > 0 || report.removed.length > 0)) render();
    }).catch(() => {});
    void (async () => {
      // getSelectableModels() is catalog-driven and can list models whose
      // `provider` id (e.g. 'google', sourced from the pricing catalog) was never
      // handed to providerRegistry.register()/registerRuntimeProvider(). Selecting
      // such a model fails hard at turn time with ProviderNotFoundError
      // ("Provider 'X' is not registered."). Filter to runtime-registered
      // providers only, so the picker never offers a model that cannot work.
      const models = providerRegistry.getSelectableModels().filter((m) => providerRegistry.has(m.provider));
      const configuredIds = new Set(getConfiguredProviderIds());
      input.modelPicker.configuredProviders = configuredIds;
      const providerIds = [...new Set(models.map((m) => m.provider))];
      const secretProviderIds = await resolveSecretProviderIds();
      input.modelPicker.configuredViaMap = buildConfiguredViaMap(providerIds, configuredIds, subscriptionManager, secretProviderIds);
      void getPinned().then((pinned) => {
        input.modelPicker.pinnedIds = new Set(pinned);
      });
      void input.modelPicker.loadRecentModels().catch(() => {}); // best-effort: prefetch for UI, failure is non-visible
      const embeddingEntries = await resolveEmbeddingProviderEntries();
      input.modelPicker.embeddingProviders = embeddingEntries;
      input.modalOpened('modelPicker');
      input.modelPicker.setTargetInfos(buildModelPickerTargets(embeddingEntries));
      input.modelPicker.openAllModels(models, getCurrentModelForPickerTarget());
      render();
    })().catch((error: unknown) => {
      commandContext.print?.(`Model picker failed to open: ${summarizeError(error)}`);
      render();
    });
  };

  commandContext.openModelPickerWithTarget = (target) => input.openModelPickerWithTarget(target);
  commandContext.openProviderModelPickerWithTarget = (target) => input.openProviderModelPickerWithTarget(target);

  commandContext.openProviderPicker = () => {
    void (async () => {
      // listModels() surfaces every catalog provider id, not just the ones
      // actually registered on this runtime (see openModelPicker above for the
      // same class of bug). Intersect against providerRegistry.has() so the
      // provider picker never offers a provider that will fail with
      // "Provider not registered" once a model under it is selected.
      const providers = [...new Set(providerRegistry.listModels().map((model) => model.provider))]
        .filter((providerId) => providerRegistry.has(providerId));
      const configuredIds = new Set(getConfiguredProviderIds());
      input.modelPicker.configuredProviders = configuredIds;
      const secretProviderIds = await resolveSecretProviderIds();
      input.modelPicker.configuredViaMap = buildConfiguredViaMap(providers, configuredIds, subscriptionManager, secretProviderIds);
      const embeddingEntries = await resolveEmbeddingProviderEntries();
      input.modelPicker.embeddingProviders = embeddingEntries;
      input.modalOpened('modelPicker');
      input.modelPicker.setTargetInfos(buildModelPickerTargets(embeddingEntries));
      input.modelPicker.openProviders(providers, getCurrentProviderForPickerTarget());
      render();
    })().catch((error: unknown) => {
      commandContext.print?.(`Provider picker failed to open: ${summarizeError(error)}`);
      render();
    });
  };

  commandContext.completeEmbeddingProviderSelection = (providerId: string) => {
    try {
      memoryEmbeddingRegistry.setDefaultProvider(providerId);
    } catch (error: unknown) {
      commandContext.print?.(`Failed to set embedding provider: ${summarizeError(error)}`);
    }
    render();
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
    render();
  };

  // Mirrors the Ctrl+F chord's own toggle exactly (handler-shortcuts.ts's
  // 'search' case) — the transcript search overlay isn't tracked on the
  // modal stack, so this doesn't call modalOpened either.
  commandContext.openTranscriptSearch = () => {
    if (input.searchManager.active) input.searchManager.close(input.conversationManager);
    else input.searchManager.open();
    render();
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

  commandContext.openSettingsModal = (target?: string) => {
    input.modalOpened('settings');
    input.settingsModal.open(configManager, featureFlags, subscriptionManager, serviceRegistry, mcpRegistry, secretsManager, {
      onSettingApplied: (change) => {
        // forced dark/light applies immediately (rebuild palettes + full
        // repaint); auto only re-probes at startup, so it takes effect next launch.
        if (String(change.key) === THEME_MODE_CONFIG_KEY) {
          const next = coerceThemeModeSetting(change.value);
          if (next === 'dark' || next === 'light') {
            setActiveThemeMode(next);
            commandContext.requestFullRepaint?.();
            return { message: `Theme mode: ${next} (applied now)` };
          }
          return { message: 'Theme mode: auto (probes terminal on next startup)' };
        }
        return syncServiceSettingToPlatform(
          { configManager, workingDirectory, homeDirectory },
          change,
        );
      },
    });
    input.settingsModal.selectTarget(target);
    render();
  };

  // (the purge): open a MIGRATE-TO-MODAL surface by name. Fed from both
  // ctx.openModal(name) (migrated command front-doors) and PanelManager's
  // open()-time modal-redirect callback (a legacy panel id resolving to a modal
  // name). Surfaces are registered in builtin-modals.ts; a name with no
  // registered surface degrades honestly to a print rather than a blank modal.
  // The stack name is the stable 'config' slot (one config modal at a time —
  // opening another swaps the surface), so Esc close/return and the modal-stack
  // machinery need only the single 'config' case (handler-ui-state.ts).
  // Some panel-id redirects (and migrated front-doors) resolve to a NATIVE
  // modal that is not a ConfigModalSurface — e.g. `sessions` -> `sessionPicker`,
  // where 'sessionPicker' is the real session-picker modal opened by
  // commandContext.openSessionPicker below, NOT a registered config surface.
  // getModalSurface can never find these, so consult this small name->opener
  // dispatch FIRST. Each entry reuses the same opener the front-door command
  // uses (no duplicated open logic); resolved lazily so wiring order does not
  // matter. Any name that is neither a native modal nor a registered surface
  // still falls through to the honest "not available" print below.
  const nativeModalOpeners: Record<string, () => void> = {
    // openSessionPicker is wired below in this same function; call it lazily
    // (optional-chained for the type, always present at invoke time).
    sessionPicker: () => commandContext.openSessionPicker?.(),
  };

  commandContext.openModal = (name: string) => {
    const openNative = nativeModalOpeners[name];
    if (openNative) {
      openNative();
      return;
    }
    const surface = panelManager.getModalSurface(name);
    if (!surface) {
      commandContext.print(`'${name}' is not available yet in this build.`);
      render();
      return;
    }
    input.modalOpened('config');
    input.configModal.open(surface, render);
    render();
  };
  panelManager.setOpenModalCallback(commandContext.openModal);

  commandContext.openMcpWorkspace = () => {
    input.openMcpWorkspace(commandContext);
    render();
  };

  commandContext.openSessionPicker = () => {
    input.modalOpened('sessionPicker');
    input.sessionPickerModal.open();
    render();
  };

  commandContext.openPanelPicker = () => {
    // Focus ownership lives in PanelManager (focusTarget); read it there rather
    // than tracking a parallel input.panelFocused flag. Toggle semantics: if the
    // workspace is visible AND already focused, hide it; otherwise reveal and
    // focus it (opening a picker when nothing is open yet).
    if (panelManager.isVisible() && panelManager.getFocusTarget() === 'panel') {
      panelManager.hide();
      panelManager.focusPrompt();
      conversation.setSplashSuppressed(false);
      conversation.rebuildHistory();
      render();
      return;
    }
    if (panelManager.getAllOpen().length === 0) {
      // (the purge): 'panel-list' (a browse-all-panels picker PANEL)
      // was DELETE-disposition — a picker over a handful of panels is dead
      // weight now. Its replacement is this selection MODAL, built from the
      // live registry (PanelManager.getRegisteredTypes()) rather than a
      // hardcoded list, so it can never list a retired/deleted id.
      const items: SelectionItem[] = panelManager.getRegisteredTypes().map((entry) => ({
        id: entry.id,
        label: `${entry.icon} ${entry.name}`,
        detail: entry.description,
        category: entry.category,
        primaryAction: 'select',
      }));
      commandContext.openSelection?.('Open Panel', items, { allowSearch: true }, (result) => {
        if (!result) return;
        panelManager.open(result.item.id);
        panelManager.show();
        panelManager.focusPanels();
        conversation.setSplashSuppressed(true);
        conversation.rebuildHistory();
        render();
      });
      return;
    }
    panelManager.show();
    panelManager.focusPanels();
    conversation.setSplashSuppressed(true);
    conversation.rebuildHistory();
    render();
  };

  // Registry-driven surfaces built inside command handlers (/help) group by
  // the same categories as the palette and the generated reference.
  commandContext.getCommandCategories = () => getCommandCategoryMap();

  commandContext.openCommandPalette = () => {
    // The palette is built live from the command registry — never a hardcoded
    // list — so it can never drift from the real command set. Category labels
    // come from the same source the generated docs use (getCommandCategoryMap).
    const registry = input.commandRegistry;
    if (!registry) return;
    const categoryByName = getCommandCategoryMap();
    const items: SelectionItem[] = registry
      .getAll()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cmd) => {
        const argsHint = cmd.argsHint ?? cmd.usage;
        const detailParts: string[] = [];
        if (cmd.description) detailParts.push(cmd.description);
        if (argsHint) detailParts.push(`(args: ${argsHint})`);
        if ((cmd.aliases ?? []).length > 0) detailParts.push(`[aka ${(cmd.aliases ?? []).map((a) => `/${a}`).join(', ')}]`);
        return {
          id: cmd.name,
          label: `/${cmd.name}`,
          detail: detailParts.join(' '),
          category: categoryByName.get(cmd.name) ?? 'Other',
          primaryAction: 'select' as const,
        };
      });
    commandContext.openSelection?.(
      'Command Palette',
      items,
      { allowSearch: true, primaryVerbLabel: 'Run' },
      (result) => {
        if (!result) return;
        const cmd = registry.get(result.item.id);
        if (!cmd) return;
        // Pre-fill the composer with the command (and a trailing space so the
        // inline args hint shows what the command wants). Keyboard-first: focus
        // returns to the composer with command mode armed so the user fills any
        // args and presses Enter — matching tab-completion's fill behavior.
        input.prompt = `/${cmd.name} `;
        input.cursorPos = input.prompt.length;
        input.commandMode = true;
        input.autocomplete?.reset();
        commandContext.focusPrompt?.();
        render();
      },
    );
  };

  commandContext.focusPanels = () => {
    panelManager.focusPanels();
    render();
  };

  commandContext.focusPrompt = () => {
    panelManager.focusPrompt();
    input.indicatorFocused = false;
    render();
  };

  commandContext.showPanel = (panelId, pane, target, opts) => {
    // forward the deep-link target so a jumped-to panel lands on the
    // right row (fleet --target); undefined for ordinary opens.
    panelManager.open(panelId, pane, target);
    panelManager.show();
    // focus rule 1a: every registered caller of showPanel is a slash
    // command (/panel open, /routes, /approval, /tasks, /ops-control, ...) —
    // the command path leaves focus in the composer ("the user is
    // mid-command-flow") unless the caller explicitly asks to grab it.
    if (opts?.focus) panelManager.focusPanels();
    conversation.setSplashSuppressed(true);
    conversation.rebuildHistory();
    render();
  };
}
