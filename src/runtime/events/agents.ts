/**
 * AgentEvent — discriminated union covering all subagent/agent lifecycle events.
 *
 * Covers agent lifecycle events for the runtime event bus.
 */

export type AgentEvent =
  /** Agent is being initialised and configured. */
  | { type: 'AGENT_SPAWNING'; agentId: string; taskId?: string; task: string }
  /** Agent is actively running and processing. */
  | { type: 'AGENT_RUNNING'; agentId: string; taskId?: string }
  /** Agent emitted a textual progress update. */
  | { type: 'AGENT_PROGRESS'; agentId: string; taskId?: string; progress: string }
  /** Agent streamed a chunk of output. */
  | { type: 'AGENT_STREAM_DELTA'; agentId: string; taskId?: string; content: string; accumulated: string }
  /** Agent is waiting to send a message to the LLM. */
  | { type: 'AGENT_AWAITING_MESSAGE'; agentId: string; taskId?: string }
  /** Agent is waiting for a tool call to complete. */
  | { type: 'AGENT_AWAITING_TOOL'; agentId: string; taskId?: string; callId: string; tool: string }
  /** Agent is performing final output assembly. */
  | { type: 'AGENT_FINALIZING'; agentId: string; taskId?: string }
  /** Agent completed successfully. */
  | { type: 'AGENT_COMPLETED'; agentId: string; taskId?: string; durationMs: number; output?: string; toolCallsMade?: number }
  /** Agent failed with an error. */
  | { type: 'AGENT_FAILED'; agentId: string; taskId?: string; error: string; durationMs: number }
  /** Agent was cancelled before completion. */
  | { type: 'AGENT_CANCELLED'; agentId: string; taskId?: string; reason?: string };

/** All agent event type literals as a union. */
export type AgentEventType = AgentEvent['type'];
