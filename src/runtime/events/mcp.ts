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
  | { type: 'MCP_DISCONNECTED'; serverId: string; reason?: string; willRetry: boolean };

/** All MCP event type literals as a union. */
export type McpEventType = McpEvent['type'];
