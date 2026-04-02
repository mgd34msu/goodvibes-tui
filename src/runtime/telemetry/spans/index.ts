/**
 * Barrel export for span helpers.
 */
export type { TurnSpanContext, TurnSpanEndContext } from './turn.ts';
export { startTurnSpan, endTurnSpan } from './turn.ts';

export type { ToolSpanContext, ToolSpanEndContext, ToolPhase } from './tool.ts';
export { startToolSpan, recordToolPhase, endToolSpan } from './tool.ts';

export type {
  LlmSpanContext,
  LlmSpanEndContext,
  LlmTokenUsage,
} from './llm.ts';
export { startLlmSpan, recordLlmStreamStart, endLlmSpan } from './llm.ts';

export type { PluginSpanContext, PluginSpanEndContext, PluginPhase } from './plugin.ts';
export { startPluginSpan, recordPluginPhase, endPluginSpan } from './plugin.ts';

export type { McpSpanContext, McpSpanEndContext, McpPhase } from './mcp.ts';
export { startMcpSpan, recordMcpPhase, endMcpSpan } from './mcp.ts';

export type { TransportSpanContext, TransportSpanEndContext, TransportPhase } from './transport.ts';
export { startTransportSpan, recordTransportPhase, endTransportSpan } from './transport.ts';

export type { TaskSpanContext, TaskSpanEndContext, TaskPhase } from './task.ts';
export { startTaskSpan, recordTaskPhase, endTaskSpan } from './task.ts';

export type { AgentSpanContext, AgentSpanEndContext, AgentPhase } from './agent.ts';
export { startAgentSpan, recordAgentPhase, endAgentSpan } from './agent.ts';

export type { PermissionSpanContext, PermissionSpanEndContext, PermissionPhase } from './permission.ts';
export { startPermissionSpan, recordPermissionPhase, endPermissionSpan } from './permission.ts';

export type { SessionSpanContext, SessionSpanEndContext, SessionPhase } from './session.ts';
export { startSessionSpan, recordSessionPhase, endSessionSpan } from './session.ts';

export type { CompactionSpanContext, CompactionSpanEndContext, CompactionPhase } from './compaction.ts';
export { startCompactionSpan, recordCompactionPhase, endCompactionSpan } from './compaction.ts';

export type { HealthCascadeSpanContext } from './health.ts';
export { recordHealthCascadeSpan } from './health.ts';
