/**
 * MCP lifecycle core type definitions.
 *
 * Referenced by: lifecycle.ts, permissions.ts, schema-freshness.ts, manager.ts
 * Spec: server state machine and MCP evolution.
 */
import type { McpServerConfig } from '../../mcp/config.ts';

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * All legal states in the MCP server lifecycle state machine.
 *
 * Transition diagram:
 *   configured → connecting → connected → degraded
 *   connected  → auth_required
 *   connected  → reconnecting → connected
 *   connected  → disconnected
 *   reconnecting → disconnected (max attempts exceeded)
 *   degraded   → reconnecting
 *   degraded   → disconnected
 *   auth_required → connecting (after credentials provided)
 *   auth_required → disconnected
 */
export type McpServerState =
  | 'configured'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'auth_required'
  | 'reconnecting'
  | 'disconnected';

// ── Schema freshness ──────────────────────────────────────────────────────────

/**
 * Freshness status of a server's tool/resource schema cache.
 *
 * - `fresh`        — fetched recently, within the TTL window
 * - `stale`        — fetched but TTL has elapsed; re-fetch recommended
 * - `unknown`      — never fetched or record cleared
 * - `fetch_failed` — last fetch attempt returned an error
 * - `quarantined`  — schema is incompatible or stale past threshold; execution
 *                    blocked until operator refreshes or explicitly acknowledges
 */
export type SchemaFreshness = 'fresh' | 'stale' | 'unknown' | 'fetch_failed' | 'quarantined';

/**
 * Reason a schema was placed into quarantine.
 *
 * - `stale_threshold`   — TTL expired and refresh failed repeatedly
 * - `incompatible`      — schema version is incompatible with the runtime
 * - `operator_flagged`  — manually flagged by an operator for review
 */
export type QuarantineReason = 'stale_threshold' | 'incompatible' | 'operator_flagged';

/** Quarantine record attached to a schema when it enters the quarantined state. */
export interface QuarantineRecord {
  /** Why the schema was quarantined. */
  reason: QuarantineReason;
  /** Epoch ms when quarantine was applied. */
  quarantinedAt: number;
  /** Human-readable detail for display in the MCP panel. */
  detail?: string;
  /** Operator identifier who acknowledged and approved override, if any. */
  overrideAcknowledgedBy?: string;
  /** Epoch ms when the operator acknowledged the quarantine override. */
  overrideAcknowledgedAt?: number;
}

/** Per-server schema record tracking freshness metadata. */
export interface McpSchemaRecord {
  /** Server name this record belongs to. */
  serverName: string;
  /** Current freshness state. */
  freshness: SchemaFreshness;
  /** Epoch ms when schemas were last successfully fetched. */
  fetchedAt?: number;
  /** Epoch ms when the next fetch is required (fetchedAt + ttl). */
  expiresAt?: number;
  /** Error message from the last failed fetch attempt. */
  lastFetchError?: string;
  /** Number of consecutive failed fetch attempts. */
  consecutiveFailures: number;
  /** Quarantine metadata, present only when freshness is 'quarantined'. */
  quarantine?: QuarantineRecord;
}

// ── Permissions ───────────────────────────────────────────────────────────────

/**
 * Trust level assigned to an MCP server.
 *
 * - `trusted`    — all tools allowed; schema auto-refreshed
 * - `standard`   — all tools allowed; subject to per-tool overrides
 * - `restricted` — only explicitly allow-listed tools may be called
 * - `blocked`    — no tool calls permitted regardless of allow-list
 */
export type McpTrustLevel = 'trusted' | 'standard' | 'restricted' | 'blocked';

/** Runtime trust mode used by the hardened MCP policy layer. */
export type McpTrustMode = 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';

/** High-level server role used for coherence evaluation. */
export type McpServerRole =
  | 'general'
  | 'docs'
  | 'filesystem'
  | 'git'
  | 'database'
  | 'browser'
  | 'automation'
  | 'ops'
  | 'remote';

/** Capability classes inferred for MCP tool calls. */
export type McpCapabilityClass =
  | 'metadata'
  | 'read_fs'
  | 'write_fs'
  | 'exec'
  | 'network_read'
  | 'network_write'
  | 'secret_read'
  | 'spawn_agent'
  | 'config_mutation'
  | 'system_mutation'
  | 'generic';

export type McpCoherenceVerdict = 'allow' | 'ask' | 'deny';
export type McpRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface McpTrustProfile {
  serverName: string;
  role: McpServerRole;
  mode: McpTrustMode;
  allowedPaths: string[];
  allowedHosts: string[];
  allowedCapabilities: McpCapabilityClass[];
  notes?: string;
  lastModifiedAt: number;
}

export interface McpCoherenceAssessment {
  verdict: McpCoherenceVerdict;
  riskLevel: McpRiskLevel;
  capability: McpCapabilityClass;
  incoherent: boolean;
  reason: string;
}

export interface McpDecisionRecord {
  serverName: string;
  toolName: string;
  verdict: McpCoherenceVerdict;
  riskLevel: McpRiskLevel;
  capability: McpCapabilityClass;
  incoherent: boolean;
  reason: string;
  profileMode: McpTrustMode;
  evaluatedAt: number;
}

/** Snapshot of a managed MCP server used for attack-path review. */
export interface McpSecuritySnapshot {
  /** Server name. */
  name: string;
  /** High-level role used for coherence evaluation. */
  role: McpServerRole;
  /** Runtime trust mode. */
  trustMode: McpTrustMode;
  /** Allowed filesystem scope. */
  allowedPaths: readonly string[];
  /** Allowed network host scope. */
  allowedHosts: readonly string[];
  /** Current schema freshness state. */
  schemaFreshness: SchemaFreshness;
  /** Active quarantine reason when schema execution is blocked. */
  quarantineReason?: QuarantineReason;
  /** Human-readable quarantine detail. */
  quarantineDetail?: string;
  /** Whether the server is currently connected. */
  connected?: boolean;
}

/** Type of attack-path finding surfaced by the security review. */
export type McpAttackPathFindingKind = 'server-posture' | 'recent-decision';

/** Single MCP attack-path finding. */
export interface McpAttackPathFinding {
  /** Finding classification. */
  kind: McpAttackPathFindingKind;
  /** Related server name. */
  serverName: string;
  /** Human-readable route summary. */
  route: string;
  /** Allow/ask/deny posture inferred from the review. */
  verdict: McpCoherenceVerdict;
  /** Risk level associated with the route. */
  severity: McpRiskLevel;
  /** Whether the finding indicates incoherent or suspicious behavior. */
  incoherent: boolean;
  /** Human-readable explanation. */
  reason: string;
  /** Evidence strings used to derive the finding. */
  evidence: readonly string[];
  /** Optional tool name for recent decision findings. */
  toolName?: string;
  /** Optional capability class for recent decision findings. */
  capability?: McpCapabilityClass;
  /** Optional timestamp for recent decision findings. */
  evaluatedAt?: number;
}

/** Aggregated attack-path review across all MCP servers and recent decisions. */
export interface McpAttackPathReview {
  /** Epoch ms when the review was generated. */
  reviewedAt: number;
  /** Total server count included in the review. */
  totalServers: number;
  /** Connected server count. */
  connectedServers: number;
  /** Servers operating in allow-all mode. */
  allowAllServers: number;
  /** Servers operating in ask-on-risk mode. */
  askOnRiskServers: number;
  /** Servers operating in constrained mode. */
  constrainedServers: number;
  /** Servers blocked entirely. */
  blockedServers: number;
  /** Servers with quarantined schemas. */
  quarantinedServers: number;
  /** Findings with incoherent posture or behavior. */
  incoherentFindings: number;
  /** Findings with high or critical severity. */
  criticalFindings: number;
  /** Ordered findings, most severe first. */
  findings: readonly McpAttackPathFinding[];
  /** Human-readable summary of the review. */
  summary: string;
}

/** Permission verdict for a single tool invocation. */
export interface McpPermission {
  /** Whether the tool call is permitted. */
  allowed: boolean;
  /** Human-readable explanation for the verdict. */
  reason: string;
  /** Richer verdict used by the hardened trust layer. */
  verdict?: McpCoherenceVerdict;
  /** Risk associated with the evaluated tool call. */
  riskLevel?: McpRiskLevel;
  /** Inferred capability class. */
  capability?: McpCapabilityClass;
  /** Whether the request was flagged as incoherent for its server role. */
  incoherent?: boolean;
  /** Effective trust mode when the decision was made. */
  profileMode?: McpTrustMode;
}

/** Per-tool permission override stored in a server's permission record. */
export interface McpToolPermission {
  /** Tool name on the server (not qualified). */
  toolName: string;
  /** Explicit allow or deny override. */
  verdict: 'allow' | 'deny';
  /** Optional note recorded when the override was set. */
  note?: string;
}

/** Complete permission configuration for a single MCP server. */
export interface McpServerPermissions {
  /** Server name. */
  serverName: string;
  /** Overall trust level governing default tool access. */
  trustLevel: McpTrustLevel;
  /** Runtime trust profile used by the coherence engine. */
  profile: McpTrustProfile;
  /** Explicit per-tool overrides applied after the trust-level default. */
  toolOverrides: Map<string, McpToolPermission>;
  /** Epoch ms when permissions were last modified. */
  lastModifiedAt: number;
}

// ── Server entry ──────────────────────────────────────────────────────────────

/**
 * Full runtime entry for a managed MCP server.
 *
 * Held by McpLifecycleManager; drives UI, store, and event emission.
 */
export interface McpServerEntry {
  /** Server name (matches McpServerConfig.name). */
  name: string;
  /** Original server configuration. */
  config: McpServerConfig;
  /** Current lifecycle state. */
  state: McpServerState;
  /** Number of reconnect attempts in the current reconnection cycle. */
  reconnectAttempts: number;
  /** Epoch ms of the most recent successful connection. */
  connectedAt?: number;
  /** Epoch ms of the most recent disconnection. */
  disconnectedAt?: number;
  /** Reason for the most recent disconnection or failure. */
  lastError?: string;
  /** Whether a reconnect timer is currently scheduled. */
  reconnectPending: boolean;
  /** Auth challenge type if state is auth_required. */
  authType?: string;
  /** Tools available from this server (populated on connect). */
  availableTools: string[];
  /** Resources available from this server (populated on connect). */
  availableResources: string[];
  /** Number of tool calls made to this server this session. */
  callCount: number;
  /** Number of tool call failures this session. */
  errorCount: number;
}

// ── Reconnect config ─────────────────────────────────────────────────────────

/** Configuration for the exponential back-off reconnect strategy. */
export interface McpReconnectConfig {
  /** Maximum number of reconnect attempts before moving to disconnected. */
  maxAttempts: number;
  /** Base delay in ms (doubled each attempt). */
  baseDelayMs: number;
  /** Hard ceiling for any single reconnect delay (ms). */
  maxDelayMs: number;
}

/** Default reconnect configuration. */
export const DEFAULT_RECONNECT_CONFIG: McpReconnectConfig = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};
