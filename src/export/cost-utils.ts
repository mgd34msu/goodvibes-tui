// ---------------------------------------------------------------------------
// cost-utils — canonical pricing source for token cost calculations (consumed by CostTrackerPanel and share-runtime)
//
// Pricing resolution order (resolvePricing):
//   1. `:free` suffix (OpenRouter free-tier convention) — always priced at $0.
//   2. The live SDK model catalog, when a source has been wired via
//      setPricingSource() (bootstrap-core.ts wires ProviderRegistry.getRawCatalogModels()
//      once catalog init completes) — exact id match, then prefix/substring.
//   3. STATIC_FALLBACK_PRICING — a small hand-maintained safety net for common
//      frontier models, used when the catalog has no source wired (e.g. tests)
//      or hasn't matched (catalog not yet loaded, or a model this net covers
//      that the catalog happens to miss).
//   4. Unpriced: the model is genuinely unknown to every source above. This is
//      reported explicitly via `priced: false` so consumers can render an
//      honest "unpriced" state instead of a silent $0.
// ---------------------------------------------------------------------------

import { computeUsageCostUsd, type CatalogModel, type ResolvedModelPricing } from '@pellux/goodvibes-sdk/platform/providers';

export interface ModelPricing {
  input: number;
  output: number;
}

/**
 * Where a resolved price came from, for the render-side source distinction:
 * 'user' = the manual pricing.modelPrices entry ("your price"), 'provider' =
 * served by the provider API, 'catalog' = the live model catalog (dated),
 * 'fallback' = this module's small built-in safety net.
 */
export type PricingSourceKind = 'user' | 'provider' | 'catalog' | 'fallback';

/** Result of a pricing lookup: the resolved (possibly zero) price, and whether it's real. */
export interface PricingResult {
  pricing: ModelPricing;
  /** False when no source recognized the model — the zero pricing is a placeholder, not a real price. */
  priced: boolean;
  /** Which source priced the model (present only when priced). */
  source?: PricingSourceKind;
  /** ISO date (YYYY-MM-DD) of the catalog/provider snapshot the price came from, when known. */
  asOf?: string;
}

// Hand-maintained safety net, used only when the live catalog has no source
// wired or does not recognize the model. NOT the primary pricing source —
// see resolvePricing() below.
const STATIC_FALLBACK_PRICING: Record<string, ModelPricing> = {
  // Free tier
  'openrouter/free': { input: 0, output: 0 },

  // InceptionLabs
  'mercury-2':    { input: 0.50, output: 1.50 },
  'mercury-edit': { input: 0.50, output: 1.50 },

  // OpenAI
  'gpt-5.4':              { input: 5,    output: 15 },
  'gpt-5.3-chat-latest':  { input: 3,    output: 10 },
  'gpt-5-mini':           { input: 0.15, output: 0.60 },
  'gpt-5-nano':           { input: 0.05, output: 0.20 },
  'gpt-oss-120b':         { input: 0,    output: 0 },

  // Anthropic
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-6': { input: 3,    output: 15 },
  'claude-haiku-4-5':  { input: 0.80, output: 4 },

  // Google
  'gemini-3.1-pro':        { input: 1.25,  output: 5 },
  'gemini-3-flash':        { input: 0.075, output: 0.30 },
  'gemini-3.1-flash-lite': { input: 0.02,  output: 0.10 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5 },
};

// Module-level injection point. Kept as a bare singleton (not threaded through
// call sites) because the 9 existing consumers are pure functions with no
// ProviderRegistry in scope; see brief for the tradeoff. Tests that
// never call setPricingSource() fall through to the static-fallback path,
// which keeps them isolated from catalog state by default.
let pricingSource: (() => readonly CatalogModel[]) | null = null;

/** Wire (or clear, with null) the live catalog as the primary pricing source. */
export function setPricingSource(source: (() => readonly CatalogModel[]) | null): void {
  pricingSource = source;
}

// The ONE model pricing resolver (manual pricing.modelPrices -> registration
// -> provider-served -> catalog -> honest unknown), wired from
// bootstrap-core.ts as ProviderRegistry.resolveModelPricing once the runtime
// exists. When set, it is consulted FIRST so a manual price the user sets is
// visible to every cost surface immediately; the legacy catalog/static chain
// below remains the fallback for resolver-unknown models and for surfaces
// (tests, headless) that never wire a registry.
let modelPricingResolver: ((modelId: string) => ResolvedModelPricing) | null = null;

/** Wire (or clear, with null) the registry's resolveModelPricing as the primary pricing source. */
export function setModelPricingResolver(resolver: ((modelId: string) => ResolvedModelPricing) | null): void {
  modelPricingResolver = resolver;
}

function findInCatalog(modelId: string, models: readonly CatalogModel[]): ModelPricing | null {
  const exact = models.find((m) => m.id === modelId);
  if (exact) return exact.tier === 'free' ? { input: 0, output: 0 } : exact.pricing;
  for (const m of models) {
    if (modelId.startsWith(m.id) || modelId.includes(m.id)) {
      return m.tier === 'free' ? { input: 0, output: 0 } : m.pricing;
    }
  }
  return null;
}

function findInStaticFallback(modelId: string): ModelPricing | null {
  const exact = STATIC_FALLBACK_PRICING[modelId];
  if (exact) return exact;
  for (const [key, pricing] of Object.entries(STATIC_FALLBACK_PRICING)) {
    if (modelId.startsWith(key) || modelId.includes(key)) return pricing;
  }
  return null;
}

/**
 * resolvePricing — resolve USD-per-1M-token pricing for a model ID, and
 * whether that pricing is real (vs. an unpriced placeholder). See the module
 * header for the full resolution order.
 */
export function resolvePricing(modelId: string): PricingResult {
  if (modelId.endsWith(':free')) return { pricing: { input: 0, output: 0 }, priced: true, source: 'catalog' };

  // The ONE resolver first: manual price -> registration -> provider-served
  // -> catalog. A 'priced' answer carries its source (and snapshot date when
  // known) so render surfaces can say "your price" vs "catalog price, as of
  // <date>". Unknown/subscription answers fall through to the legacy chain
  // so nothing regresses while the catalog is still loading.
  if (modelPricingResolver) {
    const resolved = modelPricingResolver(modelId);
    if (resolved.status === 'priced') {
      return {
        pricing: { input: resolved.rates.inputPerMTok, output: resolved.rates.outputPerMTok },
        priced: true,
        source: resolved.source,
        ...(resolved.asOf ? { asOf: resolved.asOf } : {}),
      };
    }
  }

  const models = pricingSource?.() ?? [];
  const catalogHit = findInCatalog(modelId, models);
  if (catalogHit) return { pricing: catalogHit, priced: true, source: 'catalog' };

  const fallbackHit = findInStaticFallback(modelId);
  if (fallbackHit) return { pricing: fallbackHit, priced: true, source: 'fallback' };

  // Genuinely unknown — no source recognizes this model. Report honestly
  // rather than collapsing into the same zero a free model would return.
  return { pricing: { input: 0, output: 0 }, priced: false };
}

/**
 * The render-side source distinction for a priced model: "your price" for a
 * manual pricing.modelPrices entry, "catalog price, as of <date>" (or
 * provider-served/built-in equivalents) otherwise. Null when the model is
 * unpriced — callers render the explicit "price unknown" marker instead.
 */
export function describePricingSource(modelId: string): string | null {
  const result = resolvePricing(modelId);
  if (!result.priced) return null;
  switch (result.source) {
    case 'user':
      return 'your price';
    case 'provider':
      return result.asOf ? `provider price, as of ${result.asOf}` : 'provider price';
    case 'catalog':
      return result.asOf ? `catalog price, as of ${result.asOf}` : 'catalog price';
    case 'fallback':
      return 'built-in price';
    default:
      return 'catalog price';
  }
}

/**
 * getPricing — resolve USD-per-1M-token pricing for a model ID.
 * Back-compat wrapper over resolvePricing(); returns zero for both genuinely
 * free and genuinely unknown models (use resolvePricing/isModelPriced to
 * distinguish the two).
 */
export function getPricing(modelId: string): ModelPricing {
  return resolvePricing(modelId).pricing;
}

/** True when `modelId` resolves to a real price (free or paid), false when it's an unpriced placeholder. */
export function isModelPriced(modelId: string): boolean {
  return resolvePricing(modelId).priced;
}

/**
 * calcSessionCost — compute total session cost in USD given raw token counters
 * and the active model ID. Same formula used by CostTrackerPanel.onTurnComplete.
 *
 * inputTokens    — cumulative input tokens
 * outputTokens   — cumulative output tokens
 * cacheRead      — cumulative cache-read tokens
 * cacheWrite     — cumulative cache-write tokens
 * modelId        — registry model identifier
 *
 * Unpriced models contribute 0 to the total (same as before this WO) — only
 * the display layer distinguishes "genuinely free/priced" from "unpriced".
 */
export function calcSessionCost(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
  modelId: string,
): number {
  // Through the ONE resolver when wired: computeUsageCostUsd applies the
  // source's explicit cache rates (or the published per-provider ratio)
  // instead of billing cache traffic at the full input rate.
  if (modelPricingResolver) {
    const resolved = modelPricingResolver(modelId);
    if (resolved.status === 'priced') {
      return computeUsageCostUsd(resolved, {
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      }) ?? 0;
    }
  }
  const pricing = getPricing(modelId);
  // Cache reads/writes count toward billable input side (same convention as panel)
  const billableInput = inputTokens + cacheRead + cacheWrite;
  return (billableInput * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * computeBudgetBreach — pure predicate shared by CostTrackerPanel's render-time
 * "OVER BUDGET" flag and the background budget-breach notifier
 * (core/budget-breach-notifier.ts), so both agree on exactly one definition
 * of "over budget". `budgetThreshold <= 0` means no budget is configured
 * (disabled), which can never be breached.
 */
export function computeBudgetBreach(sessionCost: number, budgetThreshold: number): boolean {
  return budgetThreshold > 0 && sessionCost > budgetThreshold;
}

/** Read/write access to the `behavior.budgetAlertUsd` TUI-local config key. Plain
 * callbacks (rather than a ConfigManager reference) so callers can pass a
 * generic-key-cast wrapper without this module depending on the SDK config types. */
export interface BudgetAlertConfigAccess {
  readonly get: (key: string) => unknown;
  readonly set: (key: string, value: unknown) => void;
}

/** Default for the `behavior.budgetAlertUsd` synthetic setting: 0 = no budget configured. */
export const BUDGET_ALERT_USD_DEFAULT = 0;

/**
 * The dot-path config key backing the session cost-budget alert threshold.
 * Shared by cost-tracker-panel.ts (get/set), settings-modal-data.ts (the
 * settings-modal-visible synthetic entry), and readBudgetAlertUsd below, so
 * the string literal lives in exactly one place.
 */
export const BUDGET_ALERT_USD_CONFIG_KEY = 'behavior.budgetAlertUsd';

/**
 * readBudgetAlertUsd — read the session cost-budget alert threshold (USD) from
 * config. This is the single source of truth CostTrackerPanel and the
 * background budget-breach notifier (core/budget-breach-notifier.ts) both
 * read, so a threshold set via the panel's 'b' key is immediately visible to
 * the notifier and vice versa. Falls back to BUDGET_ALERT_USD_DEFAULT (off)
 * when the key is absent or invalid.
 */
export function readBudgetAlertUsd(configGet: (key: string) => unknown): number {
  const raw = configGet(BUDGET_ALERT_USD_CONFIG_KEY);
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : BUDGET_ALERT_USD_DEFAULT;
}

/**
 * The SDK settings key holding the user's manual per-model prices — the
 * highest-precedence source in the ONE pricing resolver. Object map of
 * `provider:model` -> { input, output, cacheRead?, cacheWrite? } in USD per
 * 1M tokens.
 */
export const MODEL_PRICES_CONFIG_KEY = 'pricing.modelPrices';

/**
 * Persist a manual price for one `provider:model` key into
 * pricing.modelPrices, preserving every other entry. The registry's resolver
 * reads the key live per call, so the new price is visible to every cost
 * surface on the next render — no restart.
 */
export function writeManualModelPrice(
  config: BudgetAlertConfigAccess,
  modelKey: string,
  price: { input: number; output: number },
): void {
  const current = config.get(MODEL_PRICES_CONFIG_KEY);
  const map: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  map[modelKey] = { input: price.input, output: price.output };
  config.set(MODEL_PRICES_CONFIG_KEY, map);
}
