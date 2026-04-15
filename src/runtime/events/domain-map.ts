/**
 * RuntimeEventMap — master mapping of all typed runtime event types to their payloads.
 *
 * Used by RuntimeEventBus for type-safe subscriptions. Combine all domain
 * discriminated union members into a single flat map keyed by the type string.
 */
import type { SessionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/session';
import type { TurnEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/turn';
import type { ProviderEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/providers';
import type { ToolEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/tools';
import type { TaskEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/tasks';
import type { AgentEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/agents';
import type { WorkflowEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/workflows';
import type { OrchestrationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/orchestration';
import type { CommunicationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/communication';
import type { PlannerEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/planner';
import type { PermissionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/permissions';
import type { PluginEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/plugins';
import type { McpEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/mcp';
import type { TransportEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/transport';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/compaction';
import type { UIEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/ui';
import type { OpsEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/ops';
import type { ForensicsEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/forensics';
import type { SecurityEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/security';
import type { AutomationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/automation';
import type { RouteEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/routes';
import type { ControlPlaneEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/control-plane';
import type { DeliveryEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/deliveries';
import type { WatcherEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/watchers';
import type { SurfaceEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/surfaces';
import type { KnowledgeEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/knowledge';

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
  | SecurityEvent
  | AutomationEvent
  | RouteEvent
  | ControlPlaneEvent
  | DeliveryEvent
  | WatcherEvent
  | SurfaceEvent
  | KnowledgeEvent;

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
 * Domain labels for use with domain-scoped subscriptions.
 *
 * This is the source-of-truth vocabulary for runtime transport/event surfaces.
 */
export const RUNTIME_EVENT_DOMAINS = [
  'session',
  'turn',
  'providers',
  'tools',
  'tasks',
  'agents',
  'workflows',
  'orchestration',
  'communication',
  'planner',
  'permissions',
  'plugins',
  'mcp',
  'transport',
  'compaction',
  'ui',
  'ops',
  'forensics',
  'security',
  'automation',
  'routes',
  'control-plane',
  'deliveries',
  'watchers',
  'surfaces',
  'knowledge',
] as const;

/**
 * Domain label type for use with domain-scoped subscriptions.
 */
export type RuntimeEventDomain = typeof RUNTIME_EVENT_DOMAINS[number];

export function isRuntimeEventDomain(value: string): value is RuntimeEventDomain {
  return (RUNTIME_EVENT_DOMAINS as readonly string[]).includes(value);
}

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
  automation: AutomationEvent;
  routes: RouteEvent;
  'control-plane': ControlPlaneEvent;
  deliveries: DeliveryEvent;
  watchers: WatcherEvent;
  surfaces: SurfaceEvent;
  knowledge: KnowledgeEvent;
};
