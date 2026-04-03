/**
 * Core health types for the goodvibes-tui runtime health monitoring system.
 * These types model domain health status, composite system health, cascade rules,
 * and the effects that propagate when a domain transitions to a degraded or failed state.
 */

/** Health status for a single domain */
export type HealthStatus = 'healthy' | 'degraded' | 'failed' | 'unknown';

/**
 * All domains that participate in runtime health tracking.
 * Each domain maps to a subsystem or machine in the runtime.
 */
export type HealthDomain =
  | 'turn'
  | 'toolExecution'
  | 'permissions'
  | 'tasks'
  | 'agents'
  | 'plugins'
  | 'mcp'
  | 'transport'
  | 'session'
  | 'compaction'
  | 'conversation'
  | 'model'
  | 'panels'
  | 'overlays'
  | 'providerHealth'
  | 'daemon'
  | 'acp'
  | 'integrations'
  | 'telemetry'
  | 'git'
  | 'discovery'
  | 'intelligence'
  | 'uiPerf';

/** Per-domain health record capturing current status and recovery metadata */
export interface DomainHealth {
  /** The domain this record belongs to */
  domain: HealthDomain;
  /** Current health status */
  status: HealthStatus;
  /** Unix timestamp (ms) of the last status transition */
  lastTransitionAt: number;
  /** Capabilities reduced when the domain is degraded (not failed) */
  degradedCapabilities?: string[];
  /** Human-readable reason for the current failure, if any */
  failureReason?: string;
  /** Number of recovery attempts made since last failure */
  recoveryAttempts: number;
  /** Maximum recovery attempts allowed before cascading */
  maxRecoveryAttempts: number;
}

/** Composite system health derived from all domain states */
export interface CompositeHealth {
  /** Overall system health: failed > degraded > healthy; unknown if no domains are known */
  overall: HealthStatus;
  /** Health record for every tracked domain */
  domains: Map<HealthDomain, DomainHealth>;
  /** Domains currently in degraded state */
  degradedDomains: HealthDomain[];
  /** Domains currently in failed state */
  failedDomains: HealthDomain[];
  /** Unix timestamp (ms) of the last update to any domain */
  lastUpdatedAt: number;
}

/**
 * What happens when a cascade rule fires.
 * Each variant encodes the effect type and any scope or metadata needed to apply it.
 */
export type CascadeEffect =
  | { type: 'CANCEL_INFLIGHT'; scope: string }
  | { type: 'BLOCK_DISPATCH'; scope: string; queueable: boolean }
  | { type: 'MARK_CHILDREN'; status: 'failed' | 'blocked'; notifyParent: boolean }
  | { type: 'DEREGISTER_TOOLS'; pluginId?: string }
  | { type: 'EMIT_EVENT'; eventType: string }
  | { type: 'BLOCK_NEW'; scope: string };

/**
 * A single declarative cascade rule.
 * When the source domain reaches sourceState, the effect is applied to the target domain.
 * Rules are data-driven — adding a new rule requires only adding to the rules array.
 */
export interface CascadeRule {
  /** Unique rule identifier */
  id: string;
  /** The domain whose health change triggers this rule */
  source: HealthDomain;
  /** The health status of the source domain that triggers this rule */
  sourceState: HealthStatus;
  /** The domain (or 'ALL') affected by the cascade */
  target: HealthDomain | 'ALL';
  /** The effect to apply to the target */
  effect: CascadeEffect;
  /** Human-readable description of why this cascade exists */
  description: string;
  /** If true, a recovery attempt must be made before cascading */
  recoveryFirst: boolean;
}

/** Result of evaluating a single cascade rule */
export interface CascadeResult {
  /** ID of the rule that fired */
  ruleId: string;
  /** Source domain that triggered the cascade */
  source: HealthDomain;
  /** Target domain (or 'ALL') that receives the effect */
  target: HealthDomain | 'ALL';
  /** The effect that was (or should be) applied */
  effect: CascadeEffect;
  /** Unix timestamp (ms) when this result was produced */
  timestamp: number;
  /**
   * True when recovery was attempted and exhausted before cascading.
   * "We tried recovery, it failed, cascade anyway."
   * False for rules that do not use recoveryFirst.
   */
  recoveryExhausted: boolean;
  /** Optional context about the entity that triggered the cascade (e.g. { pluginId: 'foo' }) */
  sourceContext?: Record<string, string>;
  /**
   * Wall-clock latency (ms) of the cascade rule evaluation that produced this result.
   * Populated by CascadeTimer; undefined when evaluated directly via CascadeEngine.
   */
  latencyMs?: number;
  /**
   * Severity tier derived from the cascade effect type and recovery state.
   * Populated by CascadeTimer; undefined when evaluated directly via CascadeEngine.
   */
  severity?: string;
  /**
   * Playbook IDs providing remediation actions for this cascade type.
   * Populated by CascadeTimer; empty when evaluated directly via CascadeEngine.
   */
  remediationPlaybookIds?: readonly string[];
}

/**
 * Return value of CascadeEngine.evaluate().
 * Separates actionable cascades from those still awaiting recovery.
 */
export interface EvaluateResult {
  /** Cascades that are actionable — apply these effects now */
  cascades: CascadeResult[];
  /** Recovery still in progress — do not apply these effects yet */
  pendingRecovery: CascadeResult[];
}

/**
 * Event emitted when a cascade effect is applied.
 * Defined in v3 spec Section 23.2.
 */
export interface CascadeAppliedEvent {
  type: 'CASCADE_APPLIED';
  /** ID of the rule that fired */
  ruleId: string;
  /** Source domain that triggered the cascade */
  source: HealthDomain;
  /** Target domain (or 'ALL') that received the effect */
  target: HealthDomain | 'ALL';
  /** The effect that was applied */
  effect: CascadeEffect;
  /** Unix timestamp (ms) when the event was produced */
  timestamp: number;
  /** Whether recovery was exhausted before this cascade was applied */
  recoveryExhausted: boolean;
  /** Optional context about the entity that triggered the cascade */
  sourceContext?: Record<string, string>;
  /**
   * Wall-clock latency (ms) of the cascade evaluation that produced this event.
   * Populated when the event is created from a TimedCascadeResult.
   */
  latencyMs?: number;
  /**
   * Severity tier of this cascade event.
   * Populated when the event is created from a TimedCascadeResult.
   */
  severity?: string;
  /**
   * Playbook IDs that provide remediation actions for this cascade type.
   * Populated when the event is created from a TimedCascadeResult.
   */
  remediationPlaybookIds?: readonly string[];
}

/**
 * Create a CascadeAppliedEvent from a CascadeResult.
 * Call this after applying a cascade effect to produce a trace event.
 */
export function createCascadeAppliedEvent(result: CascadeResult): CascadeAppliedEvent {
  return {
    type: 'CASCADE_APPLIED',
    ruleId: result.ruleId,
    source: result.source,
    target: result.target,
    effect: result.effect,
    timestamp: result.timestamp,
    recoveryExhausted: result.recoveryExhausted,
    sourceContext: result.sourceContext,
    latencyMs: result.latencyMs,
    severity: result.severity,
    remediationPlaybookIds: result.remediationPlaybookIds,
  };
}
