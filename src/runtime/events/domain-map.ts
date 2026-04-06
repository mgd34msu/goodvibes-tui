/**
 * RuntimeEventMap — master mapping of all typed runtime event types to their payloads.
 *
 * Used by RuntimeEventBus for type-safe subscriptions. Combine all domain
 * discriminated union members into a single flat map keyed by the type string.
 */
import type { SessionEvent } from './session.ts';
import type { TurnEvent } from './turn.ts';
import type { ProviderEvent } from './providers.ts';
import type { ToolEvent } from './tools.ts';
import type { TaskEvent } from './tasks.ts';
import type { AgentEvent } from './agents.ts';
import type { WorkflowEvent } from './workflows.ts';
import type { OrchestrationEvent } from './orchestration.ts';
import type { CommunicationEvent } from './communication.ts';
import type { PlannerEvent } from './planner.ts';
import type { PermissionEvent } from './permissions.ts';
import type { PluginEvent } from './plugins.ts';
import type { McpEvent } from './mcp.ts';
import type { TransportEvent } from './transport.ts';
import type { CompactionEvent } from './compaction.ts';
import type { UIEvent } from './ui.ts';
import type { OpsEvent } from './ops.ts';
import type { ForensicsEvent } from './forensics.ts';
import type { SecurityEvent } from './security.ts';

/** Union of all runtime domain events. */
export type AnyRuntimeEvent =
  | SessionEvent
  | TurnEvent
  | ProviderEvent
  | ToolEvent
  | TaskEvent
  | AgentEvent
  | WorkflowEvent
  | OrchestrationEvent
  | CommunicationEvent
  | PlannerEvent
  | PermissionEvent
  | PluginEvent
  | McpEvent
  | TransportEvent
  | CompactionEvent
  | UIEvent
  | OpsEvent
  | ForensicsEvent
  | SecurityEvent;

/**
 * Utility type that maps an event type discriminant to its full event shape.
 *
 * Example:
 * ```ts
 * type Payload = RuntimeEventPayload<'TURN_SUBMITTED'>;
 * // => { type: 'TURN_SUBMITTED'; turnId: string; prompt: string }
 * ```
 */
export type RuntimeEventPayload<T extends AnyRuntimeEvent['type']> = Extract<
  AnyRuntimeEvent,
  { type: T }
>;

/**
 * Domain label type for use with domain-scoped subscriptions.
 */
export type RuntimeEventDomain =
  | 'session'
  | 'turn'
  | 'providers'
  | 'tools'
  | 'tasks'
  | 'agents'
  | 'workflows'
  | 'orchestration'
  | 'communication'
  | 'planner'
  | 'permissions'
  | 'plugins'
  | 'mcp'
  | 'transport'
  | 'compaction'
  | 'ui'
  | 'ops'
  | 'forensics'
  | 'security';

/** Map from domain label to its event union type. */
export type DomainEventMap = {
  session: SessionEvent;
  turn: TurnEvent;
  providers: ProviderEvent;
  tools: ToolEvent;
  tasks: TaskEvent;
  agents: AgentEvent;
  workflows: WorkflowEvent;
  orchestration: OrchestrationEvent;
  communication: CommunicationEvent;
  planner: PlannerEvent;
  permissions: PermissionEvent;
  plugins: PluginEvent;
  mcp: McpEvent;
  transport: TransportEvent;
  compaction: CompactionEvent;
  ui: UIEvent;
  ops: OpsEvent;
  forensics: ForensicsEvent;
  security: SecurityEvent;
};
