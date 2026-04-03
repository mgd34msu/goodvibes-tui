/**
 * McpEvent — discriminated union covering all MCP (Model Context Protocol) server events.
 *
 * Maps to state machine events from v3 Section 4 (MCP domain).
 */

export type McpEvent =
  /** MCP server configuration has been parsed and validated. */
  | { type: 'MCP_CONFIGURED'; serverId: string; transport: string; url?: string }
  /** Connection attempt to MCP server is in progress. */
  | { type: 'MCP_CONNECTING'; serverId: string }
  /** Connection to MCP server established successfully. */
  | { type: 'MCP_CONNECTED'; serverId: string; toolCount: number; resourceCount: number }
  /** MCP server is running in degraded mode (partial tool availability). */
  | { type: 'MCP_DEGRADED'; serverId: string; reason: string; availableTools: string[] }
  /** MCP server requires authentication before proceeding. */
  | { type: 'MCP_AUTH_REQUIRED'; serverId: string; authType: string }
  /** Attempting to re-establish a dropped MCP connection. */
  | { type: 'MCP_RECONNECTING'; serverId: string; attempt: number; maxAttempts: number }
  /** Connection to MCP server has been dropped or closed. */
  | { type: 'MCP_DISCONNECTED'; serverId: string; reason?: string; willRetry: boolean }
  /**
   * MCP schema has been quarantined.
   *
   * Tool execution on this server is blocked until the schema is refreshed or
   * an operator explicitly approves a temporary override.
   */
  | { type: 'MCP_SCHEMA_QUARANTINED'; serverId: string; reason: import('../mcp/types.ts').QuarantineReason; detail?: string }
  /**
   * An operator has acknowledged a quarantined schema and approved a temporary
   * execution override. Freshness transitions to `stale`; a refresh is still
   * recommended.
   */
  | { type: 'MCP_SCHEMA_QUARANTINE_APPROVED'; serverId: string; operatorId: string };

/** All MCP event type literals as a union. */
export type McpEventType = McpEvent['type'];
