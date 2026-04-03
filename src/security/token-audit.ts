/**
 * ApiTokenAuditor — minimum scope and rotation cadence enforcement.
 *
 * Security model (two audit dimensions):
 *   1. Scope audit  — verifies each registered token only holds the scopes
 *                     its declared policy permits (minimum scope principle)
 *   2. Rotation audit — checks token age against the rotation cadence policy
 *                       and emits warnings at the warning threshold, errors
 *                       when rotation is overdue
 *
 * In managed mode, out-of-policy tokens are blocked from use.
 * In advisory mode, violations are reported but not blocked.
 */

import { logger } from '../utils/logger.ts';
import type { SecurityEvent } from '../runtime/events/security.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default rotation cadence: 90 days in ms. */
export const DEFAULT_ROTATION_CADENCE_MS = 90 * 24 * 60 * 60 * 1000;

/** Default warning threshold: 14 days before rotation deadline. */
export const DEFAULT_ROTATION_WARNING_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata for a registered API token.
 * Callers supply this when registering a token with the auditor.
 */
export interface ApiTokenMetadata {
  /** Stable identifier for this token (never the secret value). */
  id: string;
  /** Human-readable label (e.g. 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN'). */
  label: string;
  /** Epoch ms when this token was issued / last rotated. */
  issuedAt: number;
  /** Scopes granted to this token (provider-specific strings). */
  grantedScopes: readonly string[];
  /** Policy ID this token is evaluated against (maps to TokenScopePolicy.id). */
  policyId: string;
}

/**
 * Scope policy for a category of tokens.
 * Defines the maximum set of scopes permitted under the minimum scope principle.
 */
export interface TokenScopePolicy {
  /** Stable policy identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /**
   * The complete list of scopes permitted for tokens governed by this policy.
   * Tokens holding scopes outside this set violate the minimum scope principle.
   */
  allowedScopes: readonly string[];
  /**
   * Rotation cadence in ms. Tokens older than this value are overdue.
   * Defaults to DEFAULT_ROTATION_CADENCE_MS when not specified.
   */
  rotationCadenceMs?: number;
  /**
   * Warning threshold in ms before the rotation deadline.
   * Defaults to DEFAULT_ROTATION_WARNING_THRESHOLD_MS when not specified.
   */
  rotationWarningThresholdMs?: number;
}

/** Outcome of a single scope audit check. */
export type ScopeAuditOutcome = 'ok' | 'violation';

/** Outcome of a single rotation audit check. */
export type RotationAuditOutcome = 'ok' | 'warning' | 'overdue';

/** Result of a scope audit for one token. */
export interface TokenScopeAuditResult {
  tokenId: string;
  outcome: ScopeAuditOutcome;
  /** Scopes present on the token that are not in the policy's allowedScopes. */
  excessScopes: string[];
  /** The policy evaluated against. */
  policyId: string;
}

/** Result of a rotation audit for one token. */
export interface TokenRotationAuditResult {
  tokenId: string;
  outcome: RotationAuditOutcome;
  /** How old the token is in ms. */
  ageMs: number;
  /** The configured rotation cadence in ms. */
  cadenceMs: number;
  /** Ms remaining until rotation is due (negative = overdue). */
  msUntilDue: number;
  /** Epoch ms when rotation was / is due. */
  dueAt: number;
}

/** Combined audit result for a single token. */
export interface TokenAuditResult {
  tokenId: string;
  label: string;
  scope: TokenScopeAuditResult;
  rotation: TokenRotationAuditResult;
  /**
   * Whether this token is blocked from use in managed mode.
   * A token is blocked when it has a scope violation or an overdue rotation.
   */
  blocked: boolean;
}

/** Full audit report across all registered tokens. */
export interface TokenAuditReport {
  results: TokenAuditResult[];
  /** Tokens blocked in managed mode. */
  blocked: string[];
  /** Tokens with scope violations. */
  scopeViolations: string[];
  /** Tokens with rotation warnings (approaching deadline). */
  rotationWarnings: string[];
  /** Tokens with overdue rotation. */
  rotationOverdue: string[];
  /** Epoch ms when this report was produced. */
  capturedAt: number;
}

/** Configuration for the ApiTokenAuditor. */
export interface TokenAuditorConfig {
  /**
   * When true, out-of-policy tokens are blocked from use.
   * When false, violations are reported but tokens remain usable.
   */
  managed: boolean;
}

/**
 * Callback invoked after each token is audited in `auditAll()`.
 * Receives one SecurityEvent per relevant audit outcome.
 * No-op by default — pass via `ApiTokenAuditor` constructor options.
 */
export type SecurityEventEmitter = (event: SecurityEvent) => void;

// ---------------------------------------------------------------------------
// ApiTokenAuditor
// ---------------------------------------------------------------------------

/**
 * Audits registered API tokens for scope minimization and rotation cadence.
 *
 * Usage:
 * ```ts
 * const auditor = new ApiTokenAuditor({ managed: true });
 * auditor.registerPolicy({
 *   id: 'openai',
 *   name: 'OpenAI API',
 *   allowedScopes: ['completions:write', 'models:read'],
 *   rotationCadenceMs: 90 * 24 * 60 * 60 * 1000,
 * });
 * auditor.registerToken({
 *   id: 'tok_openai_main',
 *   label: 'OPENAI_API_KEY',
 *   issuedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
 *   grantedScopes: ['completions:write', 'models:read'],
 *   policyId: 'openai',
 * });
 * const report = auditor.auditAll();
 * ```
 */
export class ApiTokenAuditor {
  private readonly _policies = new Map<string, TokenScopePolicy>();
  private readonly _tokens = new Map<string, ApiTokenMetadata>();
  private readonly _config: TokenAuditorConfig;
  private readonly _emitter: SecurityEventEmitter;

  constructor(
    config: TokenAuditorConfig = { managed: false },
    options?: { emitter?: SecurityEventEmitter },
  ) {
    this._config = config;
    this._emitter = options?.emitter ?? ((_event: SecurityEvent) => {});
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /**
   * Register a scope policy. Policies must be registered before tokens that
   * reference them.
   */
  registerPolicy(policy: TokenScopePolicy): void {
    this._policies.set(policy.id, policy);
    logger.debug('ApiTokenAuditor: registered policy', { policyId: policy.id });
  }

  /**
   * Register an API token for auditing.
   * Throws if the referenced policyId is not registered.
   */
  registerToken(metadata: ApiTokenMetadata): void {
    if (!this._policies.has(metadata.policyId)) {
      throw new Error(
        `ApiTokenAuditor: policyId '${metadata.policyId}' not registered — register the policy before the token`,
      );
    }
    this._tokens.set(metadata.id, metadata);
    logger.debug('ApiTokenAuditor: registered token', { tokenId: metadata.id, label: metadata.label });
  }

  /**
   * Deregister a token (e.g. on rotation — remove the old registration,
   * then registerToken with the new metadata).
   */
  deregisterToken(tokenId: string): boolean {
    return this._tokens.delete(tokenId);
  }

  // -------------------------------------------------------------------------
  // Individual audits
  // -------------------------------------------------------------------------

  /**
   * Audit the scope of a single token against its policy.
   * Returns a TokenScopeAuditResult or null if the token is not registered.
   */
  auditScope(tokenId: string): TokenScopeAuditResult | null {
    const token = this._tokens.get(tokenId);
    if (!token) return null;
    const policy = this._policies.get(token.policyId);
    if (!policy) return null;
    return this._auditScopeFor(token, policy);
  }

  /**
   * Audit the rotation cadence of a single token.
   * Returns a TokenRotationAuditResult or null if the token is not registered.
   */
  auditRotation(tokenId: string, now: number = Date.now()): TokenRotationAuditResult | null {
    const token = this._tokens.get(tokenId);
    if (!token) return null;
    const policy = this._policies.get(token.policyId);
    if (!policy) return null;
    return this._auditRotationFor(token, policy, now);
  }

  // -------------------------------------------------------------------------
  // Internal audit helpers (avoid map lookups + non-null assertions in auditAll)
  // -------------------------------------------------------------------------

  private _auditScopeFor(
    token: ApiTokenMetadata,
    policy: TokenScopePolicy,
  ): TokenScopeAuditResult {
    const allowedSet = new Set(policy.allowedScopes);
    const excessScopes = token.grantedScopes.filter((s) => !allowedSet.has(s));
    const outcome: ScopeAuditOutcome = excessScopes.length > 0 ? 'violation' : 'ok';

    if (outcome === 'violation') {
      logger.warn('ApiTokenAuditor: scope violation', {
        tokenId: token.id,
        label: token.label,
        excessScopes,
        policyId: policy.id,
      });
    }

    return { tokenId: token.id, outcome, excessScopes, policyId: policy.id };
  }

  private _auditRotationFor(
    token: ApiTokenMetadata,
    policy: TokenScopePolicy,
    now: number,
  ): TokenRotationAuditResult {
    const cadenceMs = policy.rotationCadenceMs ?? DEFAULT_ROTATION_CADENCE_MS;
    const warningThresholdMs =
      policy.rotationWarningThresholdMs ?? DEFAULT_ROTATION_WARNING_THRESHOLD_MS;

    const ageMs = now - token.issuedAt;
    const dueAt = token.issuedAt + cadenceMs;
    const msUntilDue = dueAt - now;

    let outcome: RotationAuditOutcome;
    if (msUntilDue < 0) {
      outcome = 'overdue';
      logger.warn('ApiTokenAuditor: token rotation overdue', {
        tokenId: token.id,
        label: token.label,
        ageMs,
        cadenceMs,
        overdueMsByMs: Math.abs(msUntilDue),
      });
    } else if (msUntilDue <= warningThresholdMs) {
      outcome = 'warning';
      logger.info('ApiTokenAuditor: token rotation approaching', {
        tokenId: token.id,
        label: token.label,
        msUntilDue,
        warningThresholdMs,
      });
    } else {
      outcome = 'ok';
    }

    return { tokenId: token.id, outcome, ageMs, cadenceMs, msUntilDue, dueAt };
  }

  // -------------------------------------------------------------------------
  // Full audit
  // -------------------------------------------------------------------------

  /**
   * Run scope and rotation audits for all registered tokens.
   *
   * In managed mode, tokens with scope violations or overdue rotation are
   * flagged as blocked. Callers must check `result.blocked` or
   * `report.blocked` before using a token.
   */
  auditAll(now: number = Date.now()): TokenAuditReport {
    const results: TokenAuditResult[] = [];
    const blocked: string[] = [];
    const scopeViolations: string[] = [];
    const rotationWarnings: string[] = [];
    const rotationOverdue: string[] = [];

    for (const [tokenId, metadata] of this._tokens) {
      const policy = this._policies.get(metadata.policyId);
      if (!policy) continue;

      const scope = this._auditScopeFor(metadata, policy);
      const rotation = this._auditRotationFor(metadata, policy, now);

      const hasViolation = scope.outcome === 'violation';
      const isOverdue = rotation.outcome === 'overdue';
      const isWarning = rotation.outcome === 'warning';

      // In managed mode: block tokens with scope violations or overdue rotation
      const isBlocked = this._config.managed && (hasViolation || isOverdue);

      const result: TokenAuditResult = {
        tokenId,
        label: metadata.label,
        scope,
        rotation,
        blocked: isBlocked,
      };

      results.push(result);

      if (hasViolation) {
        scopeViolations.push(tokenId);
        this._emitter({
          type: 'TOKEN_SCOPE_VIOLATION',
          tokenId,
          label: metadata.label,
          policyId: scope.policyId,
          excessScopes: scope.excessScopes,
        });
      }
      if (isOverdue) {
        rotationOverdue.push(tokenId);
        this._emitter({
          type: 'TOKEN_ROTATION_EXPIRED',
          tokenId,
          label: metadata.label,
          ageMs: rotation.ageMs,
          cadenceMs: rotation.cadenceMs,
          dueAt: rotation.dueAt,
        });
      }
      if (isWarning) {
        rotationWarnings.push(tokenId);
        this._emitter({
          type: 'TOKEN_ROTATION_WARNING',
          tokenId,
          label: metadata.label,
          msUntilDue: rotation.msUntilDue,
          dueAt: rotation.dueAt,
          ageMs: rotation.ageMs,
        });
      }
      if (isBlocked) {
        blocked.push(tokenId);
        const reason =
          hasViolation && isOverdue
            ? 'scope_violation_and_rotation_overdue'
            : hasViolation
              ? 'scope_violation'
              : 'rotation_overdue';
        this._emitter({ type: 'TOKEN_BLOCKED', tokenId, label: metadata.label, reason });
        logger.error('ApiTokenAuditor: token blocked (out-of-policy, managed mode)', {
          tokenId,
          label: metadata.label,
          scopeViolation: hasViolation,
          rotationOverdue: isOverdue,
        });
      }
    }

    return {
      results,
      blocked,
      scopeViolations,
      rotationWarnings,
      rotationOverdue,
      capturedAt: now,
    };
  }

  /**
   * Check whether a specific token is currently blocked.
   * Returns false when not in managed mode or when the token is not registered.
   */
  isBlocked(tokenId: string, now: number = Date.now()): boolean {
    if (!this._config.managed) return false;
    const scope = this.auditScope(tokenId);
    if (!scope) return false;
    const rotation = this.auditRotation(tokenId, now);
    if (!rotation) return false;
    return scope.outcome === 'violation' || rotation.outcome === 'overdue';
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Whether managed mode is active. */
  get isManaged(): boolean {
    return this._config.managed;
  }

  /** Number of registered tokens. */
  get tokenCount(): number {
    return this._tokens.size;
  }

  /** Number of registered policies. */
  get policyCount(): number {
    return this._policies.size;
  }

  /** Get a registered policy by id, or undefined if not found. */
  getPolicy(id: string): TokenScopePolicy | undefined {
    return this._policies.get(id);
  }

  /** Get registered token metadata by id (without the secret value). */
  getTokenMetadata(id: string): ApiTokenMetadata | undefined {
    return this._tokens.get(id);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _tokenAuditor: ApiTokenAuditor | undefined;

export function getTokenAuditor(): ApiTokenAuditor {
  if (!_tokenAuditor) _tokenAuditor = new ApiTokenAuditor({ managed: false });
  return _tokenAuditor;
}

/** Reset singleton — for testing only. */
export function _resetTokenAuditorForTesting(): void {
  _tokenAuditor = undefined;
}
