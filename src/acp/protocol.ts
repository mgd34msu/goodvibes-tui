/**
 * ACP Protocol Types
 *
 * Re-exports SDK types and defines local types for subagent management.
 * The TUI acts as the ACP client (host); subagents implement the Agent interface.
 */

// Re-export ACP SDK types
export type {
  Client,
  Agent,
  AgentSideConnection,
  ClientSideConnection,
  RequestError,
} from '@agentclientprotocol/sdk';

export type {
  SessionNotification,
  PromptRequest,
  PromptResponse,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

export { ndJsonStream } from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** Lifecycle status of a spawned subagent. */
export type SubagentStatus = 'running' | 'complete' | 'error' | 'cancelled';

/** Tracks a live subagent process. */
export interface SubagentInfo {
  id: string;
  task: string;
  status: SubagentStatus;
  startedAt: number;
  /** Latest progress text from session updates. */
  progress?: string;
}

/** Final result after a subagent completes. */
export interface SubagentResult {
  id: string;
  success: boolean;
  output: string;
  toolCallsMade: number;
  duration: number;
}

/** Parameters for spawning a subagent task. */
export interface SubagentTask {
  /** Human-readable task description / prompt. */
  description: string;
  /** Additional context to inject into the subagent's system prompt. */
  context: string;
  /** Tool names the subagent is allowed to use. */
  tools: string[];
  /** App-owned working directory for the spawned ACP session. */
  workingDirectory: string;
  /** Optional model override (e.g. "claude-sonnet-4-5"). */
  model?: string;
  /** Optional provider override (e.g. "anthropic"). */
  provider?: string;
}
