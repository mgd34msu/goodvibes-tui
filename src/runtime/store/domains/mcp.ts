/**
 * MCP domain state — tracks all MCP server connections, their lifecycle
 * state, and available tools per server.
 */

/** States for the MCP server lifecycle machine. */
export type McpServerLifecycleState =
  | 'configured'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'auth_required'
  | 'reconnecting'
  | 'disconnected';

/** A tool registered by an MCP server. */
export interface McpRegisteredTool {
  /** Fully qualified tool name ("<serverName>__<toolName>"). */
  qualifiedName: string;
  /** MCP server that provides this tool. */
  serverName: string;
  /** Tool name on the server. */
  toolName: string;
  /** Tool description. */
  description: string;
  /** Whether this tool is currently callable (server is connected). */
  available: boolean;
}

/** Health and connection record for a single MCP server. */
export interface McpServerRecord {
  /** Server name (from MCP config). */
  name: string;
  /** Server display name or label. */
  displayName: string;
  /** Current lifecycle state. */
  status: McpServerLifecycleState;
  /** Transport type used by this server. */
  transport: 'stdio' | 'sse' | 'http';
  /** Number of tools registered by this server. */
  toolCount: number;
  /** Qualified names of all tools from this server. */
  toolNames: string[];
  /** Number of successful tool calls to this server. */
  callCount: number;
  /** Number of failed tool calls to this server. */
  errorCount: number;
  /** Epoch ms of connection establishment. */
  connectedAt?: number;
  /** Epoch ms of last tool call. */
  lastCallAt?: number;
  /** Last error message. */
  lastError?: string;
  /** Number of reconnect attempts. */
  reconnectAttempts: number;
}

/**
 * McpDomainState — all MCP server connections and tool registry.
 */
export interface McpDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Server registry ───────────────────────────────────────────────────────
  /** All MCP servers keyed by server name. */
  servers: Map<string, McpServerRecord>;
  /** Names of servers currently in 'connected' state. */
  connectedServerNames: string[];

  // ── Tool registry ─────────────────────────────────────────────────────────
  /** All registered MCP tools keyed by qualifiedName. */
  tools: Map<string, McpRegisteredTool>;
  /** Total number of available (callable) tools. */
  availableToolCount: number;

  // ── Aggregate ──────────────────────────────────────────────────────────────
  /** Total MCP tool calls this session. */
  totalCalls: number;
  /** Total MCP tool call failures. */
  totalErrors: number;
}

/**
 * Returns the default initial state for the MCP domain.
 */
export function createInitialMcpState(): McpDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    servers: new Map(),
    connectedServerNames: [],
    tools: new Map(),
    availableToolCount: 0,
    totalCalls: 0,
    totalErrors: 0,
  };
}
