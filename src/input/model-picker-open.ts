/**
 * model-picker-open.ts, opening the model picker without waiting on slow reads.
 *
 * The picker's model and provider lists come from the provider registry's
 * cached catalog, which is synchronous. What used to hold the open back for
 * seconds were the reads awaited before the modal appeared: one credential
 * store lookup per configured provider (which credential source configured
 * it) and the embedding registry's status probe (the Embeddings tab). Those
 * only decorate rows or feed other tabs, so the picker now opens at once on
 * the cached catalog with a muted "loading catalog…" row, and those reads,
 * plus the live re-check of each provider's served models, fill in when they
 * land. A close or a newer open drops any load still in flight.
 */

import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type {
  EmbeddingProviderPickerEntry,
  ModelPickerCatalogFill,
  ModelPickerModal,
  ModelPickerTargetInfo,
} from './model-picker.ts';

type ConfiguredVia = Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>;

export interface ModelPickerOpenDeps {
  readonly picker: ModelPickerModal;
  /** Register the picker as the open modal (input focus, modal stack). */
  readonly modalOpened: () => void;
  readonly render: () => void;
  /** The selectable models from the cached catalog (synchronous). */
  readonly listModels: () => ModelDefinition[];
  /** The selectable provider ids from the cached catalog (synchronous). */
  readonly listProviders: () => string[];
  readonly currentModelId: () => string;
  readonly currentProviderId: () => string;
  readonly configuredProviderIds: () => ReadonlySet<string>;
  /** Which credential source configured each provider, given the providers the credential store holds keys for. */
  readonly buildConfiguredVia: (providerIds: readonly string[], configured: ReadonlySet<string>, secretProviderIds: ReadonlySet<string>) => ConfiguredVia;
  readonly buildTargets: (embeddingProviders: EmbeddingProviderPickerEntry[]) => ModelPickerTargetInfo[];
  /** Slow: one credential store read per configured provider. */
  readonly resolveSecretProviderIds: () => Promise<ReadonlySet<string>>;
  /** Slow: the embedding registry's status probe. */
  readonly resolveEmbeddingProviders: () => Promise<EmbeddingProviderPickerEntry[]>;
  /** Optional live re-check of each provider's served models; resolves true when a list changed. */
  readonly refreshLiveModels?: () => Promise<boolean>;
  /** Best-effort prefetches (pinned and recent models); failures stay silent. */
  readonly prefetch?: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/**
 * Open the picker on the cached catalog right now (it is visible when this
 * returns), then fill in the slow parts. `mode` picks the model list (/model)
 * or the provider list (/provider). The returned promise settles when every
 * fill has landed or been dropped; callers do not need to await it.
 */
export function openModelPickerNow(deps: ModelPickerOpenDeps, mode: 'models' | 'providers' = 'models'): Promise<void> {
  const { picker } = deps;
  const configured = new Set(deps.configuredProviderIds());
  const models = deps.listModels();
  const providers = mode === 'providers' ? deps.listProviders() : [...new Set(models.map((m) => m.provider))];
  picker.configuredProviders = configured;
  picker.configuredViaMap = deps.buildConfiguredVia(providers, configured, new Set());
  deps.modalOpened();
  picker.setTargetInfos(deps.buildTargets(picker.embeddingProviders));
  if (mode === 'providers') picker.openProviders(providers, deps.currentProviderId());
  else picker.openAllModels(models, deps.currentModelId());
  const ticket = picker.beginCatalogLoad();
  deps.render();

  const prefetch = (deps.prefetch?.() ?? Promise.resolve()).catch(() => {}).then(() => deps.render());

  const decorations = (async () => {
    const [secretIds, embedding] = await Promise.all([deps.resolveSecretProviderIds(), deps.resolveEmbeddingProviders()]);
    const fill: ModelPickerCatalogFill = {
      configuredViaMap: deps.buildConfiguredVia(providers, configured, secretIds),
      embeddingProviders: embedding,
      targetInfos: deps.buildTargets(embedding),
    };
    if (picker.fillCatalog(ticket, fill, false)) deps.render();
  })();

  const live = (async () => {
    if (!deps.refreshLiveModels) return;
    const changed = await deps.refreshLiveModels().catch(() => false);
    if (!changed) return;
    const fresh = mode === 'providers' ? { providers: deps.listProviders() } : { models: deps.listModels() };
    if (picker.fillCatalog(ticket, fresh, false)) deps.render();
  })();

  return Promise.all([decorations, live])
    .catch((error: unknown) => deps.onError(error))
    .finally(() => {
      // Loaded or failed, the loading row goes: the picker keeps what it has.
      if (picker.fillCatalog(ticket, {})) deps.render();
      return prefetch;
    })
    .then(() => {});
}
