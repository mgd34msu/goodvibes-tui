/**
 * Provider Capability Registry
 *
 * Unified capability contracts per provider/model for routing decisions.
 * Routing choices are fully explainable from capability records.
 */

import { getCacheCapability, type CacheType } from '@pellux/goodvibes-sdk/platform/providers/cache-capability';
import type { LLMProvider } from './interface.ts';

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

/**
 * Unified capability contract describing what a provider/model can do.
 * All fields are required — use `getCapability()` which always returns a
 * fully-resolved record derived from provider defaults and model overrides.
 */
export interface ProviderCapability {
  /** Whether the provider streams responses incrementally. */
  streaming: boolean;
  /** Whether the model accepts tool/function definitions in requests. */
  toolCalling: boolean;
  /** Whether the model can execute multiple tool calls in one turn. */
  parallelTools: boolean;
  /** Whether the provider supports JSON mode / structured output. */
  jsonMode: boolean;
  /** Whether the model exposes reasoning effort / budget controls. */
  reasoningControls: boolean;
  /** Maximum tokens the model can receive (context window). */
  maxContextTokens: number;
  /** Maximum tokens the model can generate in one response. */
  maxOutputTokens: number;
  /** Provider-level request timeout in milliseconds. */
  timeoutMs: number;
  /** Prompt-caching strategy supported by this provider. */
  caching: CacheType;
}

/**
 * A request profile describing what capabilities are needed to handle a
 * particular task. All fields are optional — omitted means "no requirement".
 */
export interface RequestProfile {
  /** Whether the request requires streaming output. */
  requiresStreaming?: boolean;
  /** Whether the request submits tool definitions. */
  requiresToolCalling?: boolean;
  /** Whether the request expects parallel tool execution. */
  requiresParallelTools?: boolean;
  /** Whether the request expects a JSON-mode / structured output response. */
  requiresJsonMode?: boolean;
  /** Whether the request tunes reasoning effort (budget, effort label). */
  requiresReasoningControls?: boolean;
  /** Minimum context window size the request needs (in tokens). */
  minContextTokens?: number;
  /** Minimum output capacity the request needs (in tokens). */
  minOutputTokens?: number;
}

// ---------------------------------------------------------------------------
// Route Explanation
// ---------------------------------------------------------------------------

/**
 * Typed reason codes for routing rejections.
 * Use these instead of free-form strings so callers can branch on them.
 */
export const RouteRejectionCode = {
  NO_STREAMING: 'NO_STREAMING',
  NO_TOOL_CALLING: 'NO_TOOL_CALLING',
  NO_PARALLEL_TOOLS: 'NO_PARALLEL_TOOLS',
  NO_JSON_MODE: 'NO_JSON_MODE',
  NO_REASONING_CONTROLS: 'NO_REASONING_CONTROLS',
  CONTEXT_TOO_SMALL: 'CONTEXT_TOO_SMALL',
  OUTPUT_TOO_SMALL: 'OUTPUT_TOO_SMALL',
} as const;

export type RouteRejectionCode = (typeof RouteRejectionCode)[keyof typeof RouteRejectionCode];

/** A single capability requirement that was not met. */
export interface RouteRejectionDetail {
  /** Machine-readable rejection code. */
  code: RouteRejectionCode;
  /** Human-readable description of why this requirement failed. */
  reason: string;
  /** Actual capability value on the provider. */
  actual: boolean | number | string;
  /** Required value from the request profile. */
  required: boolean | number | string;
}

/** Structured result of a routing decision for a provider/model/request triple. */
export type RouteExplanation =
  | {
      accepted: true;
      providerId: string;
      modelId: string;
      /** Human-readable summary of why this route was chosen. */
      summary: string;
      /** The resolved capability record used for this decision. */
      capability: ProviderCapability;
    }
  | {
      accepted: false;
      providerId: string;
      modelId: string;
      /** Human-readable summary of why this route was rejected. */
      summary: string;
      /** Ordered list of unmet requirements (non-empty when accepted=false). */
      rejections: RouteRejectionDetail[];
      /** The resolved capability record used for this decision. */
      capability: ProviderCapability;
    };

// ---------------------------------------------------------------------------
// Provider Defaults
// ---------------------------------------------------------------------------

/**
 * Baseline capability defaults per built-in provider.
 * Fields not listed fall back to `GLOBAL_DEFAULTS`.
 *
 * Note: All known providers intentionally specify every field — this makes each
 * provider's contract explicit and self-contained, at the cost of requiring all
 * entries to be updated when a new `ProviderCapability` field is added.
 * Unknown/custom providers fall back to `GLOBAL_DEFAULTS` for unspecified fields.
 */
const PROVIDER_DEFAULTS: Record<string, Partial<ProviderCapability>> = {
  anthropic: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,   // Anthropic uses structured output via tool schemas, not a json_mode flag
    reasoningControls: false,  // Extended thinking enabled per-model via reasoningEffort
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  openai: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,  // o-series models override this
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    timeoutMs: 120_000,
  },
  gemini: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  inceptionlabs: {
    streaming: true,
    toolCalling: false,   // mercury-2 does not support tool calling
    parallelTools: false,
    jsonMode: false,
    reasoningControls: true,  // mercury reasoning budget
    maxContextTokens: 128_000,
    maxOutputTokens: 32_000,
    timeoutMs: 60_000,
  },
  openrouter: {
    streaming: true,
    toolCalling: true,    // varies per routed model; default optimistic
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    timeoutMs: 120_000,
  },
  groq: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,  // Groq does not support parallel tool calls
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 30_000,  // Groq is very fast; short timeout appropriate
  },
  cerebras: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 30_000,
  },
  mistral: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    timeoutMs: 60_000,
  },
  huggingface: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: false,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  ollama: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 32_768,
    maxOutputTokens: 4_096,
    timeoutMs: 300_000,  // Local models may be slow
  },
  'ollama-cloud': {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  aihubmix: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  deepseek: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  together: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  fireworks: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'github-copilot': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'amazon-bedrock': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'amazon-bedrock-mantle': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'anthropic-vertex': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  minimax: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  xai: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
};

/**
 * Fallback defaults applied when a provider is not in `PROVIDER_DEFAULTS`.
 * Intentionally conservative: no reasoning controls, modest token limits.
 */
const GLOBAL_DEFAULTS: ProviderCapability = {
  streaming: true,
  toolCalling: true,
  parallelTools: false,
  jsonMode: false,
  reasoningControls: false,
  maxContextTokens: 32_768,
  maxOutputTokens: 4_096,
  timeoutMs: 120_000,
  caching: 'none',
};

// ---------------------------------------------------------------------------
// Per-model overrides
// ---------------------------------------------------------------------------

/**
 * Model-level capability overrides keyed by model ID.
 * These take precedence over both provider defaults and `LLMProvider.capabilities`.
 */
const MODEL_OVERRIDES: Record<string, Partial<ProviderCapability>> = {
  // Anthropic reasoning models
  'claude-opus-4-5': { reasoningControls: true, maxOutputTokens: 32_000 },
  'claude-sonnet-4-5': { reasoningControls: true, maxOutputTokens: 64_000 },
  'claude-3-5-sonnet-20241022': { maxOutputTokens: 8_192 },
  'claude-3-7-sonnet-20250219': { reasoningControls: true, maxOutputTokens: 64_000 },
  // OpenAI reasoning models
  'o1': { reasoningControls: true, jsonMode: false, maxOutputTokens: 32_768 },
  'o1-mini': { reasoningControls: true, jsonMode: false, maxOutputTokens: 65_536 },
  'o1-preview': { reasoningControls: true, jsonMode: false, maxOutputTokens: 32_768 },
  'o3': { reasoningControls: true, maxOutputTokens: 100_000 },
  'o3-mini': { reasoningControls: true, maxOutputTokens: 65_536 },
  'o4-mini': { reasoningControls: true, maxOutputTokens: 65_536 },
  // Mercury models (InceptionLabs)
  'mercury-2': { toolCalling: false, parallelTools: false, reasoningControls: true, maxOutputTokens: 32_000 },
  'mercury-edit': { toolCalling: false, parallelTools: false, reasoningControls: false, maxOutputTokens: 32_000 },
  // Gemini large context
  'gemini-2.5-pro': { maxContextTokens: 2_097_152, maxOutputTokens: 65_536, reasoningControls: true },
  'gemini-2.5-flash': { maxContextTokens: 1_048_576, maxOutputTokens: 65_536, reasoningControls: true },
  'gemini-2.0-flash': { maxContextTokens: 1_048_576, maxOutputTokens: 8_192 },
  // Gemini 3 series
  'gemini-3-flash-preview': { maxContextTokens: 1_048_576, maxOutputTokens: 65_536, reasoningControls: true },
};

// ---------------------------------------------------------------------------
// ProviderCapabilityRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that resolves and caches capability records per provider/model,
 * and provides explainable routing decisions.
 *
 * Merge order (lowest to highest priority):
 * 1. `GLOBAL_DEFAULTS` — conservative baseline
 * 2. `PROVIDER_DEFAULTS[providerId]` — provider-level defaults
 * 3. `LLMProvider.capabilities` — self-declared by the provider instance
 * 4. `MODEL_OVERRIDES` — static per-model overrides
 *
 * Exception: the `caching` field is always sourced from `getCacheCapability(providerId)`
 * (falling back to `MODEL_OVERRIDES.caching` if present), so self-declared caching
 * from `LLMProvider.capabilities` is intentionally ignored.
 *
 * The cache key is `${providerId}::${modelId}`. Call `invalidate()` after dynamic
 * provider registration to avoid stale entries.
 */
export class ProviderCapabilityRegistry {
  private readonly cache = new Map<string, ProviderCapability>();

  /**
   * Resolve the full capability record for a provider/model pair.
   *
   * @param providerId - The registered provider name (e.g. `'anthropic'`).
   * @param modelId    - The model ID (e.g. `'claude-opus-4-5'`).
   * @param provider   - Optional provider instance for self-declared capabilities.
   * @returns A fully-resolved, immutable `ProviderCapability`.
   */
  getCapability(
    providerId: string,
    modelId: string,
    provider?: Pick<LLMProvider, 'capabilities'>,
  ): ProviderCapability {
    const key = `${providerId}::${modelId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const resolved = this._resolve(providerId, modelId, provider);
    this.cache.set(key, resolved);
    return resolved;
  }

  /**
   * Invalidate all cached capability records.
   * Call after dynamic provider registration or model discovery.
   */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Check whether a resolved capability record satisfies a request profile.
   *
   * @param capability - Resolved capability from `getCapability()`.
   * @param request    - The request profile describing requirements.
   * @returns `true` if every requirement in the profile is satisfied.
   */
  canHandle(capability: ProviderCapability, request: RequestProfile): boolean {
    return this._collectRejections(capability, request).length === 0;
  }

  /**
   * Produce a structured routing explanation for a provider/model/request triple.
   * Always returns a complete `RouteExplanation` — never throws.
   *
   * @param providerId - The registered provider name.
   * @param modelId    - The model ID.
   * @param request    - The request profile.
   * @param provider   - Optional provider instance for self-declared capabilities.
   * @returns A `RouteExplanation` with `accepted` flag, rejections, and capability.
   */
  getRouteExplanation(
    providerId: string,
    modelId: string,
    request: RequestProfile,
    provider?: Pick<LLMProvider, 'capabilities'>,
  ): RouteExplanation {
    const capability = this.getCapability(providerId, modelId, provider);
    const rejections = this._collectRejections(capability, request);

    if (rejections.length === 0) {
      return {
        accepted: true,
        providerId,
        modelId,
        summary: `Route accepted: ${providerId}/${modelId} satisfies all request requirements.`,
        capability,
      };
    }

    const reasons = rejections.map((r) => r.reason).join('; ');
    return {
      accepted: false,
      providerId,
      modelId,
      summary: `Route rejected: ${providerId}/${modelId} — ${reasons}`,
      rejections,
      capability,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resolve(
    providerId: string,
    modelId: string,
    provider?: Pick<LLMProvider, 'capabilities'>,
  ): ProviderCapability {
    const providerDefaults = PROVIDER_DEFAULTS[providerId] ?? {};
    const selfDeclared: Partial<ProviderCapability> = provider?.capabilities ?? {};
    const modelOverride: Partial<ProviderCapability> = MODEL_OVERRIDES[modelId] ?? {};

    // Resolve caching separately via cache-capability module
    const cacheType = getCacheCapability(providerId).type;

    // Merge: GLOBAL_DEFAULTS < provider defaults < self-declared < model overrides
    return Object.freeze({
      ...GLOBAL_DEFAULTS,
      ...providerDefaults,
      ...selfDeclared,
      ...modelOverride,
      // caching always derived from getCacheCapability; not overridable via selfDeclared
      // but can be overridden by MODEL_OVERRIDES if a future model has different caching
      caching: modelOverride.caching ?? cacheType,
    });
  }

  private _collectRejections(
    capability: ProviderCapability,
    request: RequestProfile,
  ): RouteRejectionDetail[] {
    const rejections: RouteRejectionDetail[] = [];

    if (request.requiresStreaming === true && !capability.streaming) {
      rejections.push({
        code: RouteRejectionCode.NO_STREAMING,
        reason: 'Provider does not support streaming responses',
        actual: capability.streaming,
        required: true,
      });
    }

    if (request.requiresToolCalling === true && !capability.toolCalling) {
      rejections.push({
        code: RouteRejectionCode.NO_TOOL_CALLING,
        reason: 'Model does not support tool/function calling',
        actual: capability.toolCalling,
        required: true,
      });
    }

    if (request.requiresParallelTools === true && !capability.parallelTools) {
      rejections.push({
        code: RouteRejectionCode.NO_PARALLEL_TOOLS,
        reason: 'Model does not support parallel tool execution',
        actual: capability.parallelTools,
        required: true,
      });
    }

    if (request.requiresJsonMode === true && !capability.jsonMode) {
      rejections.push({
        code: RouteRejectionCode.NO_JSON_MODE,
        reason: 'Provider does not support JSON mode / structured output',
        actual: capability.jsonMode,
        required: true,
      });
    }

    if (request.requiresReasoningControls === true && !capability.reasoningControls) {
      rejections.push({
        code: RouteRejectionCode.NO_REASONING_CONTROLS,
        reason: 'Model does not expose reasoning effort or budget controls',
        actual: capability.reasoningControls,
        required: true,
      });
    }

    if (
      request.minContextTokens !== undefined &&
      capability.maxContextTokens < request.minContextTokens
    ) {
      rejections.push({
        code: RouteRejectionCode.CONTEXT_TOO_SMALL,
        reason: `Context window (${capability.maxContextTokens.toLocaleString()} tokens) is smaller than the required minimum (${request.minContextTokens.toLocaleString()} tokens)`,
        actual: capability.maxContextTokens,
        required: request.minContextTokens,
      });
    }

    if (
      request.minOutputTokens !== undefined &&
      capability.maxOutputTokens < request.minOutputTokens
    ) {
      rejections.push({
        code: RouteRejectionCode.OUTPUT_TOO_SMALL,
        reason: `Output capacity (${capability.maxOutputTokens.toLocaleString()} tokens) is smaller than the required minimum (${request.minOutputTokens.toLocaleString()} tokens)`,
        actual: capability.maxOutputTokens,
        required: request.minOutputTokens,
      });
    }

    return rejections;
  }
}
