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

/** Permission verdict for a single tool invocation. */
export interface McpPermission {
  /** Whether the tool call is permitted. */
  allowed: boolean;
  /** Human-readable explanation for the verdict. */
  reason: string;
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
