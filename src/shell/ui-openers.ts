import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { openModelPickerNow, type ModelPickerOpenDeps } from '../input/model-picker-open.ts';
import { getProviderIdFromModel } from '@pellux/goodvibes-sdk/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { ShellViews } from '../panels/builtin-views.ts';
import type { ViewPanelAdapter } from '../panels/view-panel-adapter.ts';
import { wireViewOpeners } from './view-openers.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import type { EmbeddingProviderPickerEntry, ModelPickerTargetInfo } from '../input/model-picker.ts';
import { CommandPalette, buildPaletteEntries } from '../input/command-palette.ts';
import { confirmThrough } from '../input/confirm-dialog.ts';
import { bridgeNotificationFeedToToasts, getSharedToastCenter } from '../renderer/toast-center.ts';
import { getSharedNotificationFeed } from '../panels/notifications-feed.ts';
import { categorizeBuiltinCommands } from '../input/commands.ts';
import { syncServiceSettingToPlatform } from './service-settings-sync.ts';
import { setActiveThemeMode, setActiveThemeName } from '../renderer/theme.ts';
import { THEME_MODE_CONFIG_KEY, THEME_NAME_CONFIG_KEY, coerceThemeModeSetting } from '../renderer/theme-mode-config.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { buildFirstOpenItems, decodeFirstOpenChoice, selfRecordWorkspaceRegistration } from '../cli/tui-startup.ts';
import type { SettingsDaemonCredentialWriter } from '../input/settings-modal-secrets.ts';
import type { DaemonOwnedConfigWriter } from '../input/settings-modal-mutations.ts';
import type { WorkspaceTrustLevel } from '@pellux/goodvibes-sdk/platform/runtime/operations';

type WireShellUiOpenersOptions = {
  commandContext: CommandContext;
  input: InputHandler;
  /** The read models and config-modal surfaces behind the built-in modals. */
  views: ShellViews;
  /** The operator API's panels.list / panels.open, answered by the modal views. */
  viewPanels: ViewPanelAdapter;
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: MutableRuntimeState;
  featureFlags: FeatureFlagManager;
  mcpRegistry: McpRegistry;
  subscriptionManager: SubscriptionManager;
  secretsManager?: Pick<SecretsManager, 'delete' | 'get' | 'set'>;
  /**
   * The daemon's credential write. Present when a daemon is configured; a
   * daemon-scoped credential goes there rather than into this surface's own
   * store, which the daemon never reads.
   */
  daemonCredentials?: SettingsDaemonCredentialWriter | null;
  /**
   * Where a daemon-owned setting is written. `surfaces.*`, `watchers.*`,
   * `automation.*` and the rest are applied by the daemon; writing one into
   * this surface's own file reports success and configures nothing.
   */
  daemonConfig?: DaemonOwnedConfigWriter | null;
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  /** Backs the model picker's 'embeddings' target and its own item-list mode. */
  memoryEmbeddingRegistry: Pick<MemoryEmbeddingProviderRegistry, 'getDefaultProviderId' | 'setDefaultProvider' | 'status'>;
  workingDirectory: string;
  homeDirectory: string;
  getConfiguredProviderIds: () => string[];
  getPinned: () => Promise<string[]>;
  render: () => void;
  /** Trust-at-consequence-time bridge, patched here with the real modal-driving implementation. */
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

  // Tier 1: subscription check (most specific, subscription overrides env for this provider)
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
    views,
    viewPanels,
    configManager,
    providerRegistry,
    runtime,
    featureFlags,
    mcpRegistry,
    subscriptionManager,
    secretsManager,
    daemonCredentials,
    daemonConfig,
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
  // Registration self-records here too when trusted (never for restricted,
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
   * not carry `configured`, and unconfigured providers must be shown
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
        description: 'Embedding provider used for memory search and the code index. Not an LLM route: no model concept.',
        provider: embeddingProviderId,
        model: '',
        enabled: true,
        inherited: false,
        configuredNote: embeddingNote,
      },
    ];
  };

  // The picker opens at once on the cached catalog; the credential-source
  // reads, the embeddings probe and the live model re-check fill in after
  // (input/model-picker-open.ts). getSelectableModels() and listModels() can
  // name catalog providers this runtime never registered; both lists keep
  // runtime-registered providers only, so the picker never offers a model
  // that fails with "Provider not registered" at turn time.
  const pickerOpenDeps: ModelPickerOpenDeps = {
    picker: input.modelPicker,
    modalOpened: () => input.modalOpened('modelPicker'),
    render,
    listModels: () => providerRegistry.getSelectableModels().filter((m) => providerRegistry.has(m.provider)),
    listProviders: () => [...new Set(providerRegistry.listModels().map((m) => m.provider))].filter((id) => providerRegistry.has(id)),
    currentModelId: getCurrentModelForPickerTarget,
    currentProviderId: getCurrentProviderForPickerTarget,
    configuredProviderIds: () => new Set(getConfiguredProviderIds()),
    buildConfiguredVia: (ids, configured, secretIds) => buildConfiguredViaMap([...ids], new Set(configured), subscriptionManager, secretIds),
    buildTargets: buildModelPickerTargets,
    resolveSecretProviderIds,
    resolveEmbeddingProviders: resolveEmbeddingProviderEntries,
    refreshLiveModels: async () => ((await providerRegistry.refreshLiveModelDiscovery?.()) ?? []).some((r) => r.added.length > 0 || r.removed.length > 0),
    prefetch: async () => {
      input.modelPicker.pinnedIds = new Set(await getPinned());
      await input.modelPicker.loadRecentModels();
    },
    onError: (error) => { commandContext.print?.(`Model picker could not load everything: ${summarizeError(error)}`); render(); },
  };

  commandContext.openModelPicker = () => { void openModelPickerNow(pickerOpenDeps, 'models'); };

  commandContext.openModelPickerWithTarget = (target) => input.openModelPickerWithTarget(target);
  commandContext.openProviderModelPickerWithTarget = (target) => input.openProviderModelPickerWithTarget(target);

  commandContext.openProviderPicker = () => { void openModelPickerNow(pickerOpenDeps, 'providers'); };

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
    input.overlayFilters.help.clear();
    render();
  };

  // Mirrors the Ctrl+F chord's own toggle exactly (handler-shortcuts.ts's
  // 'search' case), the transcript search overlay isn't tracked on the
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
    input.overlayFilters.shortcuts.clear();
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
      // The Connections category probes through this app's catalog, which is
      // empty by construction, so those rows read 'unreachable' rather than
      // inventing a settled state nothing established. Retargeting that probe
      // at the daemon is the remaining half of this seam.
      ...(commandContext.workspace?.gatewayMethods
        ? { gatewayMethods: commandContext.workspace.gatewayMethods }
        : {}),
      // A daemon-scoped credential goes to the daemon, which writes the secret,
      // verifies it reads back, and only then points the config key at it.
      ...(daemonCredentials ? { daemonCredentials } : {}),
      // A daemon-owned setting is applied by the daemon, so it is written there.
      ...(daemonConfig ? { daemonConfig } : {}),
      reportError: (message: string) => { commandContext.print?.(message); },
      requestRender: render,
      onSettingApplied: (change) => {
        // forced dark/light applies immediately (rebuild palettes + full
        // repaint); auto only re-probes at startup, so it takes effect next launch.
        if (String(change.key) === THEME_NAME_CONFIG_KEY) {
          // Theme changes apply immediately: rebuild palettes + full repaint.
          const applied = setActiveThemeName(change.value);
          commandContext.requestFullRepaint?.();
          return { message: `Theme: ${applied} (applied now)` };
        }
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

  // Open a config-modal surface by name (or by an old name that redirects to
  // one, e.g. 'accounts' opens 'providers-modal'). Surfaces are registered in
  // builtin-modals.ts; a name with no registered surface degrades honestly to
  // a print rather than a blank modal.
  // The stack name is the stable 'config' slot (one config modal at a time,
  // opening another swaps the surface), so Esc close/return and the modal-stack
  // machinery need only the single 'config' case (handler-ui-state.ts).
  // Some panel-id redirects (and migrated front-doors) resolve to a NATIVE
  // modal that is not a ConfigModalSurface, e.g. `sessions` -> `sessionPicker`,
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
    const registry = views.modalSurfaces;
    const surface = registry.getModalSurface(name) ?? registry.getModalSurface(registry.getModalRedirect(name) ?? '');
    if (!surface) {
      commandContext.print(`'${name}' is not available yet in this build.`);
      render();
      return;
    }
    input.modalOpened('config');
    input.configModal.open(surface, render);
    render();
  };

  commandContext.openMcpWorkspace = () => {
    input.openMcpWorkspace(commandContext);
    render();
  };

  commandContext.openSessionPicker = () => {
    input.modalOpened('sessionPicker');
    input.sessionPickerModal.open();
    render();
  };

  // Registry-driven surfaces built inside command handlers (/help) group by
  // the same categories as the palette and the generated reference.
  commandContext.getCommandCategories = () => getCommandCategoryMap();

  input.surfaceModals.onChange = render;
  commandContext.confirm = (options) => confirmThrough(input.surfaceModals, options);
  const toasts = getSharedToastCenter();
  toasts.onChange = render;
  commandContext.showToast = (toast) => toasts.show(toast);
  bridgeNotificationFeedToToasts(getSharedNotificationFeed(), toasts);

  commandContext.openCommandPalette = () => {
    // The palette is built live from the command registry, never a hardcoded
    // list, so it can never drift from the real command set. Category labels
    // come from the same source the generated docs use (getCommandCategoryMap).
    const registry = input.commandRegistry;
    if (!registry) return;
    const top = input.surfaceModals.top();
    if (top instanceof CommandPalette) return;
    const palette = new CommandPalette({
      entries: buildPaletteEntries(registry.getAll(), getCommandCategoryMap()),
      describe: (id) => (id === 'model' ? commandContext.session.runtime.model || undefined : undefined),
      onRun: (entry, mode) => {
        if (mode === 'run' && commandContext.executeCommand) {
          void commandContext.executeCommand(entry.id, []).finally(() => render());
          return;
        }
        // Fill the composer with the command (and a trailing space so the
        // inline args hint shows what the command wants), command mode armed,
        // so the user types any arguments and presses Enter, matching
        // tab-completion's fill behavior.
        input.prompt = `/${entry.id} `;
        input.cursorPos = input.prompt.length;
        input.commandMode = true;
        input.autocomplete?.reset();
        commandContext.focusPrompt?.();
        render();
      },
    });
    input.surfaceModals.push(palette);
    render();
  };

  commandContext.focusPrompt = () => {
    input.indicatorFocused = false;
    render();
  };

  wireViewOpeners({ commandContext, input, views, viewPanels, render });
}
