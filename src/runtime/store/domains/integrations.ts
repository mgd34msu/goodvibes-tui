/**
 * Integrations domain state — tracks external service integrations
 * such as email, CMS, file storage, analytics, and custom webhooks.
 */

/** Integration health status. */
export type IntegrationStatus = 'unconfigured' | 'connecting' | 'healthy' | 'degraded' | 'error' | 'disabled';

/** Integration category for grouping in UI. */
export type IntegrationCategory =
  | 'communication'
  | 'storage'
  | 'analytics'
  | 'version_control'
  | 'ci_cd'
  | 'issue_tracker'
  | 'llm_gateway'
  | 'custom';

/** Record for a single integration. */
export interface IntegrationRecord {
  /** Unique integration identifier. */
  id: string;
  /** Display name. */
  displayName: string;
  /** Integration category. */
  category: IntegrationCategory;
  /** Current status. */
  status: IntegrationStatus;
  /** Whether the integration is enabled. */
  enabled: boolean;
  /** Number of successful operations this session. */
  successCount: number;
  /** Number of failed operations this session. */
  errorCount: number;
  /** Epoch ms of last successful operation. */
  lastSuccessAt?: number;
  /** Epoch ms of last error. */
  lastErrorAt?: number;
  /** Last error message. */
  lastError?: string;
  /** Integration-specific metadata. */
  meta: Record<string, unknown>;
}

/**
 * IntegrationDomainState — all external service integrations.
 */
export interface IntegrationDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Integration registry ────────────────────────────────────────────────────
  /** All integrations keyed by id. */
  integrations: Map<string, IntegrationRecord>;
  /** IDs of healthy integrations. */
  healthyIds: string[];
  /** IDs of integrations in error or degraded state. */
  problemIds: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total integration operations this session. */
  totalOperations: number;
  /** Total integration errors this session. */
  totalErrors: number;
}

/**
 * Returns the default initial state for the integrations domain.
 */
export function createInitialIntegrationsState(): IntegrationDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    integrations: new Map(),
    healthyIds: [],
    problemIds: [],
    totalOperations: 0,
    totalErrors: 0,
  };
}
