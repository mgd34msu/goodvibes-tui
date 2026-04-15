/**
 * Provider Optimizer
 *
 * Lives above provider implementations. Routes requests based on capability
 * contracts from ProviderCapabilityRegistry. Supports auto/manual/pinned
 * routing modes with deterministic, fully-explainable decisions.
 *
 * Optimizer off → zero behavior change (selectRoute returns null).
 * Optimizer on  → deterministic route explanation for every request profile.
 */

import {
  ProviderCapabilityRegistry,
  type RequestProfile,
  type RouteExplanation,
} from './capabilities.ts';
import type { ModelDefinition, ProviderRegistry } from './registry.ts';
import type { ProviderHealthRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optimizer routing mode. */
export type OptimizerMode = 'auto' | 'manual' | 'pinned';

/** A single fallback transition log entry. */
export interface FallbackTransition {
  /** Epoch ms when the transition occurred. */
  readonly ts: number;
  /** Provider/model that failed or was skipped. */
  readonly from: string;
  /** Provider/model selected as fallback. */
  readonly to: string;
  /** Human-readable reason for the transition. */
  readonly reason: string;
}

/** Result of a route selection decision. */
export interface RouteDecision {
  /** Provider ID selected. */
  readonly providerId: string;
  /** Model ID selected. */
  readonly modelId: string;
  /** Full route explanation from the capability registry. */
  readonly explanation: RouteExplanation;
  /** All candidates considered (accepted and rejected). */
  readonly allCandidates: readonly RouteExplanation[];
  /** Epoch ms when this decision was made. */
  readonly decidedAt: number;
  /** Whether this decision was constrained by a pin. */
  readonly pinned: boolean;
}

/** Result of a fallback chain test. */
export interface FallbackTestResult {
  /** Ordered nodes in the simulated fallback chain. */
  readonly chain: ReadonlyArray<{
    readonly position: number;
    readonly providerId: string;
    readonly modelId: string;
    readonly capable: boolean;
    readonly explanation: RouteExplanation;
  }>;
  /** Number of nodes that satisfy the empty request profile. */
  readonly viableCount: number;
  /** Total nodes tested. */
  readonly totalCount: number;
  /** Epoch ms when the test was run. */
  readonly testedAt: number;
}

// ---------------------------------------------------------------------------
// ProviderOptimizer
// ---------------------------------------------------------------------------

/**
 * Optimizer that selects the best provider/model for a given request profile.
 *
 * When disabled (`enabled = false`) every method returns null/empty — the
 * optimizer has zero effect on normal request flow.
 *
 * When enabled, routing decisions are driven entirely by `ProviderCapabilityRegistry`
 * capability contracts. The selection algorithm is deterministic: candidates are
 * evaluated in registry order (custom → synthetic → catalog → discovered), and
 * the first capable model wins. Ties are never broken by opaque scoring.
 */
export class ProviderOptimizer {
  private _mode: OptimizerMode = 'manual';
  private _enabled: boolean;
  private _pinnedProvider: string | null = null;
  private _pinnedModel: string | null = null;
  private readonly _fallbackLog: FallbackTransition[] = [];
  private static readonly MAX_LOG_ENTRIES = 200;
  private readonly _clock: () => number;
  private readonly registry: Pick<ProviderRegistry, 'getCurrentModel' | 'getSelectableModels' | 'explainRoute'>;
  private readonly capabilityRegistry: ProviderCapabilityRegistry;

  constructor(
    registry: Pick<ProviderRegistry, 'getCurrentModel' | 'getSelectableModels' | 'explainRoute'>,
    capabilityRegistry: ProviderCapabilityRegistry,
    enabled = false,
    clock: () => number = Date.now,
  ) {
    this.registry = registry;
    this.capabilityRegistry = capabilityRegistry;
    this._enabled = enabled;
    this._clock = clock;
  }

  // -------------------------------------------------------------------------
  // Mode control
  // -------------------------------------------------------------------------

  /** Current routing mode. */
  get mode(): OptimizerMode {
    return this._mode;
  }

  /** Whether the optimizer is active. When false, selectRoute always returns null. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Enable or disable the optimizer. */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /**
   * Set the routing mode.
   * - `auto`   — optimizer selects the best capable provider for each request profile.
   * - `manual` — optimizer is advisory only; caller drives provider selection.
   * - `pinned` — optimizer always returns the pinned provider/model (if capable).
   */
  setMode(mode: OptimizerMode): void {
    this._mode = mode;
    if (mode !== 'pinned') {
      this._pinnedProvider = null;
      this._pinnedModel = null;
    }
  }

  // -------------------------------------------------------------------------
  // Pinning
  // -------------------------------------------------------------------------

  /**
   * Pin routing to a specific provider and model.
   * Automatically switches mode to `pinned`.
   *
   * @param providerId - Provider name (e.g. `'anthropic'`).
   * @param modelId    - Model ID (e.g. `'claude-opus-4-5'`).
   */
  pin(providerId: string, modelId: string): void {
    this._pinnedProvider = providerId;
    this._pinnedModel = modelId;
    this._mode = 'pinned';
  }

  /** Remove the current pin and return to `manual` mode. */
  unpin(): void {
    this._pinnedProvider = null;
    this._pinnedModel = null;
    this._mode = 'manual';
  }

  /** Current pin target, or null if not pinned. */
  get pinnedTarget(): { providerId: string; modelId: string } | null {
    if (this._pinnedProvider && this._pinnedModel) {
      return { providerId: this._pinnedProvider, modelId: this._pinnedModel };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Route selection
  // -------------------------------------------------------------------------

  /**
   * Select the best route for the given request profile.
   *
   * Returns `null` when the optimizer is disabled — callers must handle null
   * and fall through to their own provider selection logic.
   *
   * @param profile        - Capability requirements for the request.
   * @param healthSnapshot - Optional map of provider health records for filtering
   *                         unhealthy providers in `auto` mode.
   * @returns A `RouteDecision` or `null` when optimizer is off.
   *
   * @remarks
   * `selectRoute` is wired by the orchestrator when the `provider-optimizer`
   * feature flag is enabled. This follows the same deferred-integration pattern
   * as session emitters — the method is fully functional but called externally
   * only when the feature is active. Until then it is a no-op (returns `null`).
   */
  selectRoute(
    profile: RequestProfile,
    healthSnapshot?: ReadonlyMap<string, ProviderHealthRecord>,
  ): RouteDecision | null {
    if (!this._enabled) return null;

    const candidates = this.registry.getSelectableModels();
    const allCandidates: RouteExplanation[] = [];

    // Pinned mode — evaluate only the pinned target
    if (this._mode === 'pinned' && this._pinnedProvider && this._pinnedModel) {
      const explanation = this.capabilityRegistry.getRouteExplanation(
        this._pinnedProvider,
        this._pinnedModel,
        profile,
      );
      allCandidates.push(explanation);
      return {
        providerId: this._pinnedProvider,
        modelId: this._pinnedModel,
        explanation,
        allCandidates,
        decidedAt: this._clock(),
        pinned: true,
      };
    }

    // Auto mode — evaluate all selectable models; pick first capable
    // Manual mode — same evaluation but result is advisory (caller may ignore)
    let selected: ModelDefinition | null = null;
    let selectedExplanation: RouteExplanation | null = null;

    for (const model of candidates) {
      // Skip unhealthy providers in auto mode when health data is available
      if (this._mode === 'auto' && healthSnapshot) {
        const health = healthSnapshot.get(model.provider);
        if (health && (health.status === 'unavailable' || health.status === 'auth_error')) {
          continue;
        }
      }

      const explanation = this.capabilityRegistry.getRouteExplanation(
        model.provider,
        model.id,
        profile,
      );
      allCandidates.push(explanation);

      if (explanation.accepted && !selected) {
        selected = model;
        selectedExplanation = explanation;
      }
    }

    if (!selected || !selectedExplanation) {
      // No capable provider found — return first candidate's explanation as the decision
      // so callers get a fully-populated rejection explanation
      const fallbackExpl = allCandidates[0] ?? this._emptyExplanation();
      return {
        providerId: fallbackExpl.providerId,
        modelId: fallbackExpl.modelId,
        explanation: fallbackExpl,
        allCandidates,
        decidedAt: this._clock(),
        pinned: false,
      };
    }

    return {
      providerId: selected.provider,
      modelId: selected.id,
      explanation: selectedExplanation,
      allCandidates,
      decidedAt: this._clock(),
      pinned: false,
    };
  }

  /**
   * Explain the current routing decision for the active model without changing it.
   * Always returns a full explanation even when the optimizer is in manual mode.
   *
   * @param profile - Optional request profile; defaults to empty (no requirements).
   */
  explainCurrentRoute(profile: RequestProfile = {}): RouteExplanation {
    const current = this.registry.getCurrentModel();
    return this.registry.explainRoute(current.registryKey ?? `${current.provider}:${current.id}`, profile);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Returns a fully-typed rejection explanation when no candidates are available. */
  private _emptyExplanation() {
    return {
      accepted: false as const,
      providerId: 'none',
      modelId: 'none',
      summary: 'No selectable models available in registry.',
      rejections: [] as import('./capabilities.ts').RouteRejectionDetail[],
      capability: this.capabilityRegistry.getCapability('unknown', 'unknown'),
    };
  }

  // -------------------------------------------------------------------------
  // Fallback test
  // -------------------------------------------------------------------------

  /**
   * Simulate the fallback chain by evaluating all selectable models against
   * the given profile. Returns an ordered list of results (capable first,
   * then incapable) so operators can visualize the full fallback topology.
   *
   * @param profile - Capability requirements to test against.
   */
  testFallback(profile: RequestProfile = {}): FallbackTestResult {
    const candidates = this.registry.getSelectableModels();

    const chain: Array<{
      position: number;
      providerId: string;
      modelId: string;
      capable: boolean;
      explanation: RouteExplanation;
    }> = [];

    let position = 0;
    for (const model of candidates) {
      const explanation = this.capabilityRegistry.getRouteExplanation(model.provider, model.id, profile);
      chain.push({
        position,
        providerId: model.provider,
        modelId: model.id,
        capable: explanation.accepted,
        explanation,
      });
      position++;
    }

    const viableCount = chain.filter((n) => n.capable).length;

    return {
      chain,
      viableCount,
      totalCount: chain.length,
      testedAt: this._clock(),
    };
  }

  // -------------------------------------------------------------------------
  // Fallback transition log
  // -------------------------------------------------------------------------

  /**
   * Record a fallback transition. Called by orchestration layers when a
   * provider fails and routing switches to a fallback.
   *
   * Transitions are always recorded regardless of optimizer enabled state
   * so that manual fallbacks are also visible in the log.
   */
  recordFallbackTransition(from: string, to: string, reason: string): void {
    const entry: FallbackTransition = {
      ts: this._clock(),
      from,
      to,
      reason,
    };
    this._fallbackLog.push(entry);
    // Trim to bounded size
    if (this._fallbackLog.length > ProviderOptimizer.MAX_LOG_ENTRIES) {
      this._fallbackLog.splice(0, this._fallbackLog.length - ProviderOptimizer.MAX_LOG_ENTRIES);
    }
  }

  /** All recorded fallback transitions (oldest first). */
  get fallbackLog(): readonly FallbackTransition[] {
    return this._fallbackLog;
  }

  /** Clear the fallback transition log. */
  clearFallbackLog(): void {
    this._fallbackLog.splice(0);
  }
}
