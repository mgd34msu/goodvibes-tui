/**
 * Model domain state — tracks the active LLM provider and model,
 * fallback chain, token limits, and reasoning configuration.
 */

/** Reasoning effort levels matching provider interface. */
export type ReasoningEffort = 'instant' | 'low' | 'medium' | 'high';

/** Provider tier classification. */
export type ProviderTier = 'local' | 'hosted' | 'hosted_reasoning' | 'diffusion';

/** Token limit configuration for a model. */
export interface ModelTokenLimits {
  /** Maximum output tokens the model supports. */
  maxOutputTokens: number;
  /** Maximum tokens in a single tool result before truncation. */
  maxToolResultTokens: number;
  /** Maximum number of tool calls per turn. */
  maxToolCalls: number;
  /** Maximum reasoning/thinking tokens (undefined = not a reasoning model). */
  maxReasoningTokens?: number;
  /** Full context window size in tokens. */
  contextWindow: number;
}

/**
 * A single entry in the model fallback chain.
 * If the primary model fails, the runtime attempts each fallback in order.
 */
export interface FallbackChainEntry {
  /** Provider ID. */
  providerId: string;
  /** Model ID on that provider. */
  modelId: string;
  /** Human-readable name for display. */
  displayName: string;
  /** Reason this fallback was configured. */
  reason?: 'rate_limit' | 'unavailable' | 'context_exceeded' | 'manual';
}

/**
 * ModelDomainState — all information about the active model configuration.
 */
export interface ModelDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Active model ───────────────────────────────────────────────────────────
  /** ID of the currently active provider (e.g. 'anthropic', 'openai'). */
  activeProviderId: string;
  /** Model identifier on the provider (e.g. 'claude-sonnet-4-6'). */
  activeModelId: string;
  /** Human-readable display name. */
  displayName: string;
  /** Registry key used for config lookup. */
  registryKey: string;
  /** Provider tier (affects permission and UX behavior). */
  tier: ProviderTier;

  // ── Capabilities ───────────────────────────────────────────────────────────
  /** Token limits for the active model. */
  tokenLimits: ModelTokenLimits;
  /** Whether the active model supports streaming. */
  supportsStreaming: boolean;
  /** Whether the active model supports tool calls. */
  supportsTools: boolean;
  /** Whether the active model supports vision/image inputs. */
  supportsVision: boolean;

  // ── Reasoning ──────────────────────────────────────────────────────────────
  /** Current reasoning effort setting. */
  reasoningEffort: ReasoningEffort;
  /** Whether reasoning summaries are enabled. */
  reasoningSummary: boolean;

  // ── Fallback chain ─────────────────────────────────────────────────────────
  /** Ordered fallback chain to attempt if the primary model fails. */
  fallbackChain: FallbackChainEntry[];
  /** Index into fallbackChain of the currently active fallback (-1 = primary). */
  activeFallbackIndex: number;
  /** Number of fallover events since session start. */
  falloverCount: number;
  /** ID of the previous model before the last fallback (for display). */
  previousModelId?: string;
}

/**
 * Returns the default initial state for the model domain.
 */
export function createInitialModelState(): ModelDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    activeProviderId: '',
    activeModelId: '',
    displayName: '',
    registryKey: '',
    tier: 'hosted',
    tokenLimits: {
      maxOutputTokens: 8192,
      maxToolResultTokens: 50000,
      maxToolCalls: 64,
      contextWindow: 200000,
    },
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    reasoningEffort: 'medium',
    reasoningSummary: false,
    fallbackChain: [],
    activeFallbackIndex: -1,
    falloverCount: 0,
    previousModelId: undefined,
  };
}
