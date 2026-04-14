import type { LLMProvider, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.ts';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import {
  ProviderCapabilityRegistry,
  type ProviderCapability,
  type RequestProfile,
  type RouteExplanation,
} from './capabilities.ts';
import type { DiscoveredServer } from '../discovery/scanner.ts';
import { createDiscoveredProvider, getDiscoveredReasoningFormat } from './discovered-factory.ts';
import { getDiscoveredTraits } from './discovered-traits.ts';
import { getConfiguredApiKeys, getConfiguredModelId, getConfiguredProviderId } from '../config/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { emitProvidersChanged, emitProviderWarning } from '../runtime/emitters/index.ts';
import { loadCustomProviders, watchCustomProviders } from './custom-loader.ts';
import {
  buildSyntheticCanonicalModels,
  fetchCatalog,
  getCatalogCachePath,
  getCatalogModelDefinitionsFrom,
  getCatalogTmpPath,
  getCostFromPricingCatalog,
  getSyntheticBackendModelIds,
  getSyntheticModelDefinitions,
  getSyntheticModelInfo,
  isCatalogCacheStale,
  loadCatalogCache,
  notifyCatalogChanges,
  saveCatalogCache,
  type CatalogModel,
  type CatalogProvider,
  type MinimalModelDefinition,
  type PricingCatalog,
} from './model-catalog.ts';
import { registerBuiltinProviders, CATALOG_PROVIDER_NAME_ALIASES } from './builtin-registry.ts';
import type { CacheHitTracker } from './cache-strategy.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { SubscriptionManager } from '../config/subscriptions.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.ts';
import type { FavoritesStore } from './favorites.ts';
import type { BenchmarkStore } from './model-benchmarks.ts';
import type { CanonicalModel } from './synthetic.ts';
import { LocalContextIngestionService } from './local-context-ingestion.ts';
import { getModelLimitsCachePath, ModelLimitsService } from './model-limits.ts';
import { getGitHubCopilotTokenCachePath } from './github-copilot.ts';
import { summarizeError } from '../utils/error-display.ts';
import {
  getBaseModelId,
  splitModelRegistryKey,
  stableStringify,
  withRegistryKey,
} from './registry-helpers.ts';
import {
  buildModelRegistry,
  findModelDefinition,
  findModelDefinitionForProvider,
} from './registry-models.ts';
import type {
  ModelDefinition,
  ProviderRegistryOptions,
  RuntimeProviderRegistration,
  TokenLimits,
} from './registry-types.ts';
export type {
  ContextWindowProvenance,
  ModelDefinition,
  ModelTier,
  ProviderRegistryOptions,
  RuntimeProviderRegistration,
  TokenLimits,
} from './registry-types.ts';

/**
 * ProviderRegistry — manages LLM provider instances and model selection.
 * Lazily instantiates providers on first use.
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private currentModelId: string;
  private discoveredProviderNames: Set<string> = new Set();
  private runtimeProviderNames: Set<string> = new Set();
  private customModels: ModelDefinition[] = [];
  private runtimeModels: ModelDefinition[] = [];
  private discoveredModels: ModelDefinition[] = [];
  private readonly runtimeCatalogSuppressions = new Map<string, readonly string[]>();
  private _watcher: { close: () => void } | undefined;
  private _readyPromise: Promise<void> | null = null;
  private readonly configManager: Pick<ConfigManager, 'get' | 'getCategory' | 'getControlPlaneConfigDir'>;
  private readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending' | 'saveSubscription' | 'resolveAccessToken'>;
  private readonly capabilityRegistry: ProviderCapabilityRegistry;
  private readonly cacheHitTracker: CacheHitTracker;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  private readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  private readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks' | 'getTopBenchmarkModelIds'>;
  private readonly modelLimitsService: ModelLimitsService;
  private readonly runtimeMetadataDeps: ProviderRuntimeMetadataDeps;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly localContextIngestionService = new LocalContextIngestionService();
  private catalogModels: CatalogModel[] = [];
  private pricingCatalog: PricingCatalog | null = null;
  private syntheticCanonicalModels: CanonicalModel[] = [];

  constructor(options: ProviderRegistryOptions) {
    this.configManager = options.configManager;
    this.subscriptionManager = options.subscriptionManager;
    this.capabilityRegistry = options.capabilityRegistry;
    this.cacheHitTracker = options.cacheHitTracker;
    this.favoritesStore = options.favoritesStore;
    this.benchmarkStore = options.benchmarkStore;
    this.modelLimitsService = options.modelLimitsService ?? new ModelLimitsService({
      cachePath: getModelLimitsCachePath(this.getPersistenceRoot()),
    });
    this.runtimeMetadataDeps = {
      secretsManager: options.secretsManager,
      serviceRegistry: options.serviceRegistry,
      subscriptionManager: options.subscriptionManager,
    };
    this.featureFlags = options.featureFlags ?? null;
    this.runtimeBus = options.runtimeBus ?? null;
    this.currentModelId = getConfiguredModelId(this.configManager) || 'openrouter/free';
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    const apiKey = (name: string): string => getConfiguredApiKeys()[name] ?? '';
    registerBuiltinProviders(
      this,
      (name) => this.providers.has(name),
      apiKey,
      {
        cacheHitTracker: this.cacheHitTracker,
        resolveProvider: (providerName) => this.get(providerName),
        getCatalogModels: () => this.syntheticCanonicalModels,
        getBenchmarks: (modelId) => this.benchmarkStore.getBenchmarks(modelId),
        githubCopilotTokenCachePath: getGitHubCopilotTokenCachePath(this.getPersistenceRoot()),
        subscriptionManager: this.subscriptionManager,
        runtimeBus: this.runtimeBus,
      },
    );
  }

  private getPersistenceRoot(): string {
    return this.configManager.getControlPlaneConfigDir();
  }

  private getCustomProvidersDir(): string {
    return join(this.getPersistenceRoot(), 'providers');
  }

  private getCatalogCachePaths(): { cachePath: string; tmpPath: string } {
    const cachePath = getCatalogCachePath(this.getPersistenceRoot());
    return {
      cachePath,
      tmpPath: getCatalogTmpPath(this.getPersistenceRoot()),
    };
  }

  private getCatalogBuiltins(): ModelDefinition[] {
    return getCatalogModelDefinitionsFrom(this.catalogModels) as ModelDefinition[];
  }

  private getSyntheticBuiltins(): ModelDefinition[] {
    return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels) as ModelDefinition[];
  }

  private updateCatalogState(models: readonly CatalogModel[]): void {
    this.catalogModels = [...models];
    this.pricingCatalog = { fetchedAt: Date.now(), models: this.catalogModels };
    this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels);
  }

  private getSuppressedCatalogModelIds(): Set<string> {
    return new Set([...this.runtimeCatalogSuppressions.values()].flat());
  }

  private getModelRegistry(): ModelDefinition[] {
    return buildModelRegistry({
      customModels: this.customModels,
      runtimeModels: this.runtimeModels,
      syntheticModels: this.getSyntheticBuiltins(),
      catalogModels: this.getCatalogBuiltins(),
      discoveredModels: this.discoveredModels,
      suppressedCatalogIds: this.getSuppressedCatalogModelIds(),
    });
  }

  /** Register a provider. Overwrites any existing entry with the same name. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Register a runtime/plugin-owned provider and optional model definitions.
   * Returns an unregister callback so plugin cleanup can remove the provider and
   * its runtime model/catalog contributions.
   */
  registerRuntimeProvider(registration: RuntimeProviderRegistration): () => void {
    const { provider, models = [], suppressCatalogModels = [], replace = false } = registration;
    if (this.providers.has(provider.name) && !this.runtimeProviderNames.has(provider.name) && !replace) {
      throw new Error(`Provider '${provider.name}' is already registered.`);
    }
    this.providers.set(provider.name, provider);
    this.runtimeProviderNames.add(provider.name);
    this.runtimeModels = [
      ...this.runtimeModels.filter((model) => model.provider !== provider.name),
      ...models.map((model) => withRegistryKey({
        ...model,
        provider: provider.name,
        registryKey: model.registryKey || `${provider.name}:${model.id}`,
      })),
    ];
    this.runtimeCatalogSuppressions.set(provider.name, [...new Set(suppressCatalogModels)]);
    this.capabilityRegistry.invalidate();
    return () => {
      if (!this.runtimeProviderNames.has(provider.name)) return;
      this.providers.delete(provider.name);
      this.runtimeProviderNames.delete(provider.name);
      this.runtimeModels = this.runtimeModels.filter((model) => model.provider !== provider.name);
      this.runtimeCatalogSuppressions.delete(provider.name);
      this.capabilityRegistry.invalidate();
    };
  }

  listProviders(): readonly LLMProvider[] {
    return [...this.providers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Register providers discovered by the local LLM scanner.
   * Clears previously discovered providers before re-registering.
   * Does not overwrite built-in or custom-loaded providers/models.
   */
  registerDiscoveredProviders(servers: DiscoveredServer[]): void {
    // Unregister previously discovered providers
    for (const name of this.discoveredProviderNames) {
      this.providers.delete(name);
    }
    this.discoveredProviderNames.clear();
    this.discoveredModels = [];

    for (const server of servers) {
      // Skip if a non-discovered provider already holds this name
      if (this.providers.has(server.name)) continue;
      // Skip servers with no models — defaultModel would be undefined
      if (server.models.length === 0) continue;

      const reasoningFormat = getDiscoveredReasoningFormat(server.serverType);
      const traits = getDiscoveredTraits(server.serverType);

      const provider = createDiscoveredProvider(server);

      this.providers.set(server.name, provider);
      this.discoveredProviderNames.add(server.name);

      for (const modelId of server.models) {
        this.discoveredModels.push({
          id: modelId,
          provider: server.name,
          registryKey: `${server.name}:${modelId}`,
          displayName: modelId,
          description: `Discovered local model on ${server.baseURL}`,
          capabilities: traits.modelCapabilities,
          ...(traits.reasoningEffort ? { reasoningEffort: traits.reasoningEffort } : {}),
          contextWindow: server.modelContextWindows?.[modelId] ?? 8192,
          ...(server.modelContextWindows?.[modelId] != null
            ? { contextWindowProvenance: 'provider_api' as const }
            : {}),
          ...(server.modelOutputLimits?.[modelId] != null
            ? { tokenLimits: { maxOutputTokens: server.modelOutputLimits[modelId] } }
            : {}),
          selectable: true,
          tier: 'standard',
        });
      }
    }
  }

  /** Retrieve a provider by name. Throws if not found. */
  get(name: string): LLMProvider {
    if (name === 'openai' && this.subscriptionManager.get('openai')) {
      const subscriber = this.providers.get('openai-subscriber');
      if (subscriber) return subscriber;
    }
    return this.getRegistered(name);
  }

  /** Retrieve the directly-registered provider without subscription route aliasing. */
  getRegistered(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (p) return p;
    // Check alias map — catalog may use a different name than the registered provider
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[name];
    if (aliased) {
      const pa = this.providers.get(aliased);
      if (pa) return pa;
    }
    throw new Error(`Provider '${name}' is not registered.`);
  }

  async describeRuntime(name: string): Promise<ProviderRuntimeMetadata | null> {
    const provider = this.getRegistered(name);
    if (!provider.describeRuntime) return null;
    return await provider.describeRuntime(this.runtimeMetadataDeps);
  }

  /** Return the provider responsible for a given model ID.
   * Accepts a registryKey (`provider:modelId`) OR a plain modelId.
   * - If input contains `:`, treats as registryKey — exact match on `m.registryKey`
   * - If no `:`, treats as plain modelId — exact match on `m.id`
   * When `provider` is supplied alongside a plain modelId, it disambiguates.
   * Explicit provider constraints do not fall through to other providers.
   */
  getForModel(modelId: string, provider?: string): LLMProvider {
    const registry = this.getModelRegistry();
    const def = provider
      ? findModelDefinitionForProvider(modelId, provider, registry, CATALOG_PROVIDER_NAME_ALIASES)
      : findModelDefinition(modelId, registry);
    if (!def) {
      if (provider) throw new Error(`No model '${modelId}' for provider '${provider}' in registry.`);
      throw new Error(`No model '${modelId}' in registry.`);
    }
    return this.get(def.provider);
  }

  /** All registered model definitions. */
  listModels(): ModelDefinition[] {
    return this.getModelRegistry();
  }

  getCostFromCatalog(modelId: string): { input: number; output: number } {
    return getCostFromPricingCatalog(
      modelId,
      this.pricingCatalog ?? { fetchedAt: Date.now(), models: this.catalogModels },
      this.modelLimitsService,
    );
  }

  getContextWindowForModel(modelDef: ModelDefinition): number {
    return this.modelLimitsService.getContextWindowForModel(modelDef);
  }

  getTokenLimitsForModel(modelDef: ModelDefinition): Required<TokenLimits> {
    return this.modelLimitsService.getTokenLimitsForModel(modelDef);
  }

  getPricingForModel(modelId: string, provider: string): { prompt: number; completion: number } | null {
    return this.modelLimitsService.getPricingForModel(modelId, provider);
  }

  getToolResultMaxCharsForModel(model: ModelDefinition | null | undefined): number {
    return this.modelLimitsService.getToolResultMaxCharsForModel(model);
  }

  initModelLimits(): void {
    this.modelLimitsService.init();
  }

  refreshModelLimits(): Promise<number> {
    return this.modelLimitsService.refresh();
  }

  getRawCatalogModels(): readonly CatalogModel[] {
    return [...this.catalogModels];
  }

  getCatalogModelDefinitions(): readonly MinimalModelDefinition[] {
    return getCatalogModelDefinitionsFrom(this.catalogModels);
  }

  getSyntheticModelDefinitions(): readonly MinimalModelDefinition[] {
    return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels);
  }

  getSyntheticCanonicalModels(): readonly CanonicalModel[] {
    return [...this.syntheticCanonicalModels];
  }

  getSyntheticBackendModelIds(): Set<string> {
    return getSyntheticBackendModelIds(this.syntheticCanonicalModels);
  }

  getSyntheticModelInfoFromCatalog(modelId: string) {
    return getSyntheticModelInfo(
      modelId,
      this.syntheticCanonicalModels,
      (candidateId) => this.benchmarkStore.getBenchmarks(candidateId),
    );
  }

  getConfiguredProviderIds(): string[] {
    const configured = new Set<string>();
    const providerEnvMap = new Map<string, string[]>();

    for (const model of this.catalogModels) {
      if (!providerEnvMap.has(model.providerId)) {
        providerEnvMap.set(model.providerId, model.providerEnvVars);
      }
    }

    for (const [providerId, envVars] of providerEnvMap) {
      if (envVars.length === 0) {
        configured.add(providerId);
      } else if (envVars.some((envVar) => {
        const value = process.env[envVar];
        return typeof value === 'string' && value.length > 0;
      })) {
        configured.add(providerId);
      }
    }

    try {
      const configApiKeys = getConfiguredApiKeys();
      const configToCatalog: Record<string, string> = { gemini: 'google', inceptionlabs: 'inception' };
      for (const [configName, key] of Object.entries(configApiKeys)) {
        if (key) {
          configured.add(configToCatalog[configName] ?? configName);
        }
      }
    } catch {
      // non-fatal
    }

    if (this.getSyntheticBackendModelIds().size > 0) {
      configured.add('synthetic');
    }

    return [...configured];
  }

  /** Only the models the user can switch to. */
  getSelectableModels(): ModelDefinition[] {
    return this.getModelRegistry().filter((m) => m.selectable);
  }

  /** Currently active model definition. */
  getCurrentModel(): ModelDefinition {
    const registry = this.getModelRegistry();
    const def = findModelDefinition(this.currentModelId, registry);
    if (!def) {
      const baseId = getBaseModelId(this.currentModelId);
      const isInCatalog = this.getCatalogBuiltins().some((m) => m.id === baseId || m.id === this.currentModelId);
      if (!isInCatalog && this.currentModelId) {
        const placeholderProvider = this.currentModelId.includes(':')
          ? this.currentModelId.split(':')[0]
          : (getConfiguredProviderId(this.configManager) || 'unknown');
        return {
          id: baseId,
          provider: placeholderProvider ?? 'unknown',
          registryKey: this.currentModelId.includes(':') ? this.currentModelId : `${placeholderProvider}:${baseId}`,
          displayName: baseId,
          description: 'Waiting for provider discovery...',
          capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
          contextWindow: 0, // Unknown until provider discovery completes; 0 = no progress bar
          selectable: true,
          tier: 'standard',
        };
      }
      // Builtin model not found — genuinely broken, fall back to first selectable
      const fallback = this.getModelRegistry().find((m) => m.selectable);
      if (fallback) {
        this.currentModelId = fallback.id;
        return fallback;
      }
      throw new Error(`Current model '${this.currentModelId}' not in registry.`);
    }
    return def;
  }

  /**
   * Override the context window cap for a custom or discovered (local) model.
   * Mutates the live model entry in customModels or discoveredModels so the change
   * is reflected immediately without requiring a full provider reload.
   *
   * @param registryKey - The model's registryKey (`provider:id`).
   * @param cap         - New context window value in tokens.
   * @remarks Context cap is session-only. Not persisted to config — lost on restart.
   */
  setModelContextCap(registryKey: string, cap: number): void {
    // Try customModels first, then discoveredModels
    const customIdx = this.customModels.findIndex((m) => m.registryKey === registryKey || m.id === registryKey);
    if (customIdx >= 0) {
      this.customModels[customIdx] = {
        ...this.customModels[customIdx]!,
        contextWindow: cap,
        contextWindowProvenance: 'configured_cap',
      };
      return;
    }
    const discoveredIdx = this.discoveredModels.findIndex((m) => m.registryKey === registryKey || m.id === registryKey);
    if (discoveredIdx >= 0) {
      this.discoveredModels[discoveredIdx] = {
        ...this.discoveredModels[discoveredIdx]!,
        contextWindow: cap,
        contextWindowProvenance: 'configured_cap',
      };
      return;
    }
    logger.warn('[registry] setModelContextCap: model not found', { registryKey });
  }

  /** Switch to a different model. Accepts registryKey or plain modelId. Throws if not selectable. */
  setCurrentModel(modelId: string): void {
    const def = findModelDefinition(modelId, this.getModelRegistry());
    if (!def) throw new Error(`Model '${modelId}' not found.`);
    if (!def.selectable) throw new Error(`Model '${modelId}' is not selectable.`);
    // Store the registryKey for unambiguous future lookups
    this.currentModelId = def.registryKey ?? modelId;
  }

  /**
   * Load custom providers from ~/.goodvibes/tui/providers/ and merge them
   * into the live model registry. Returns any warnings collected during loading.
   * Call this after construction to populate custom providers.
   */
  async loadCustomProviders(): Promise<{ warnings: string[]; added: string[]; removed: string[]; updated: string[] }> {
    const result = await loadCustomProviders({
      providersDir: this.getCustomProvidersDir(),
      ingestContextWindows: this.featureFlags?.isEnabled('local-provider-context-ingestion') ?? false,
      contextIngestion: this.localContextIngestionService,
    });
    const previousIds = new Set(this.customModels.map((m) => m.id));
    const newIds = new Set(result.models.map((m) => m.id));

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    for (const id of newIds) {
      if (!previousIds.has(id)) {
        added.push(id);
      } else {
        // Only mark as updated if the model definition actually changed
        const oldModel = this.customModels.find((m) => m.id === id);
        const newModel = result.models.find((m) => m.id === id);
        if (stableStringify(oldModel) !== stableStringify(newModel)) {
          updated.push(id);
        }
      }
    }
    for (const id of previousIds) {
      if (!newIds.has(id)) removed.push(id);
    }

    // Warn about collisions with catalog models
    const catalogIds = new Set(this.getCatalogBuiltins().map((b) => b.id));
    for (const model of result.models) {
      if (catalogIds.has(model.id)) {
        const msg = `[registry] Custom model '${model.id}' from provider '${model.provider}' overrides catalog model.`;
        result.warnings.push(msg);
        // Warning already added to result.warnings — don't console.warn (corrupts TUI)
      }
    }

    // Register provider instances
    for (const { provider } of result.providers) {
      this.register(provider);
    }

    // Swap custom models
    this.customModels = result.models;

    return { warnings: result.warnings, added, removed, updated };
  }

  /**
   * Start watching ~/.goodvibes/tui/providers/ for file changes.
   * On change, reloads custom providers and emits typed provider runtime events.
   * Safe to call multiple times — stops the previous watcher first.
   */
  startWatching(runtimeBus: RuntimeEventBus | null = null): void {
    this.stopWatching();
    this._watcher = watchCustomProviders(runtimeBus, async () => {
      const result = await this.loadCustomProviders();
      for (const msg of result.warnings) {
        if (runtimeBus) {
          emitProviderWarning(runtimeBus, {
            sessionId: 'system',
            traceId: `providers:warning:${Date.now()}`,
            source: 'provider-registry',
          }, { message: msg });
        }
      }
      if (runtimeBus) {
        emitProvidersChanged(runtimeBus, {
          sessionId: 'system',
          traceId: `providers:changed:${Date.now()}`,
          source: 'provider-registry',
        }, {
          added: result.added,
          removed: result.removed,
          updated: result.updated,
        });
      }
    }, this.getCustomProvidersDir());
  }

  /** Stop the file watcher started by startWatching(). */
  stopWatching(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  /**
   * Returns a promise that resolves when the initial custom provider load
   * completes. Callers can await this before calling getForModel() with a
   * custom model ID to avoid a "model not found" race window.
   */
  ready(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  /**
   * Find an alternative model when the current provider fails non-transiently.
   * Prefers a synthetic failover wrapper; falls back to same-tier model on a different provider.
   */
  findAlternativeModel(currentModelId: string): ModelDefinition | null {
    const current = findModelDefinition(currentModelId, this.getModelRegistry());
    if (!current || current.provider === 'synthetic') return null;
    // Check if synthetic wrapper exists
    const baseName = current.id.split('/').pop() ?? '';
    const syntheticMatch = this.getModelRegistry().find((model) => model.provider === 'synthetic' && (model.id === baseName || model.id.endsWith('/' + baseName)));
    if (syntheticMatch) return syntheticMatch;
    // Find same-tier model on different provider
    return this.getModelRegistry().find((model) => model.id !== currentModelId && model.provider !== current.provider && model.tier === current.tier && model.selectable) ?? null;
  }

  /**
   * Resolve the full capability record for a model.
   * Accepts a plain model ID or a `provider:modelId` registryKey.
   *
   * @param modelId - Plain model ID or registryKey (`provider:modelId`).
   * @returns A fully-resolved, immutable `ProviderCapability`.
   */
  getCapabilityForModel(modelId: string): ProviderCapability {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(modelId);
    return this.capabilityRegistry.getCapability(providerId, resolvedModelId, provider);
  }

  /**
   * Check whether a model can handle a request described by `profile`.
   * Fails early with a typed explanation when unsupported — avoids mid-stream errors.
   *
   * @param modelId - Plain model ID or registryKey.
   * @param profile - The capability requirements for this request.
   * @returns A `RouteExplanation` with `accepted` flag, rejections, and capability.
   */
  explainRoute(modelId: string, profile: RequestProfile): RouteExplanation {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(modelId);
    return this.capabilityRegistry.getRouteExplanation(providerId, resolvedModelId, profile, provider);
  }

  /**
   * Resolve the provider identity and instance for a plain model ID or registryKey.
   * Shared by `getCapabilityForModel` and `explainRoute` to avoid duplication.
   *
   * @param modelId - Plain model ID or registryKey (`provider:modelId`).
   */
  private _resolveModelContext(modelId: string): {
    providerId: string;
    resolvedModelId: string;
    provider: LLMProvider | undefined;
  } {
    const registry = this.getModelRegistry();
    const def = findModelDefinition(modelId, registry);
    const { providerId: fallbackProviderId, resolvedModelId: fallbackModelId } = splitModelRegistryKey(modelId);
    const providerId = def?.provider ?? fallbackProviderId;
    const resolvedModelId = def?.id ?? fallbackModelId;
    let provider: LLMProvider | undefined;
    try {
      provider = this.get(providerId);
    } catch {
      // Provider not registered yet — proceed without self-declared capabilities
    }
    return { providerId, resolvedModelId, provider };
  }

  /** Kick off async custom provider loading. Called once from bootstrap-owned construction. */
  initCustomProviders(): void {
    this._readyPromise = this.loadCustomProviders()
      .then((result) => {
        // Warnings captured in result.warnings — don't console.warn (corrupts TUI)
        // Invalidate the capability cache so custom providers' self-declared
        // capabilities are reflected in subsequent getCapabilityForModel calls.
        this.capabilityRegistry.invalidate();
        this._readyPromise = null;
      })
      .catch((err) => {
        // Non-fatal — don't console.warn (corrupts TUI display)
        this._readyPromise = null;
      });
  }

  initCatalog(): void {
    const cached = loadCatalogCache(this.getCatalogCachePaths().cachePath);
    if (cached) {
      this.catalogModels = [...cached.models];
      this.pricingCatalog = { fetchedAt: cached.fetchedAt, models: this.catalogModels };
      this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels);
    }
    if (!cached || isCatalogCacheStale(cached)) {
      void this.refreshCatalog().catch((err) => {
        logger.debug('[model-catalog] Background refresh failed', { error: summarizeError(err) });
      });
    }
  }

  async refreshCatalog(): Promise<void> {
    const previous = [...this.catalogModels];
    const models = await fetchCatalog();
    if (models.length === 0) {
      logger.warn('[model-catalog] Refresh returned 0 models — keeping existing catalog');
      return;
    }
    const { cachePath, tmpPath } = this.getCatalogCachePaths();
    saveCatalogCache(models, cachePath, tmpPath);
    this.updateCatalogState(models);
    const favorites = await this.favoritesStore.load();
    notifyCatalogChanges(
      previous,
      this.catalogModels,
      favorites,
      this.benchmarkStore.getTopBenchmarkModelIds(10),
    );
    logger.debug('[model-catalog] Catalog updated', { count: models.length });
  }
}
