import type {
  AgentEvent,
  OpsEvent,
  PlannerEvent,
  ProviderEvent,
  RuntimeEventDomain,
  SessionEvent,
  ToolEvent,
  TurnEvent,
  WorkflowEvent,
} from '../events/index.ts';
import type { UiEventFeed, UiRuntimeEvents } from '../ui-events.ts';
import type { DomainEventConnector } from './domain-events.ts';
import { createRemoteRuntimeEvents, type RemoteRuntimeEvents } from './runtime-events-client.ts';

type RuntimeEventRecord = { readonly type: string };

function asUiEvents(runtimeEvents: RemoteRuntimeEvents<RuntimeEventRecord>): UiRuntimeEvents {
  return {
    sessions: runtimeEvents.session as UiEventFeed<SessionEvent>,
    turns: runtimeEvents.turn as UiEventFeed<TurnEvent>,
    tools: runtimeEvents.tools as UiEventFeed<ToolEvent>,
    providers: runtimeEvents.providers as UiEventFeed<ProviderEvent>,
    agents: runtimeEvents.agents as UiEventFeed<AgentEvent>,
    workflows: runtimeEvents.workflows as UiEventFeed<WorkflowEvent>,
    planner: runtimeEvents.planner as UiEventFeed<PlannerEvent>,
    ops: runtimeEvents.ops as UiEventFeed<OpsEvent>,
  };
}

export function createRemoteUiRuntimeEvents(
  connect: DomainEventConnector<RuntimeEventDomain, RuntimeEventRecord>,
): UiRuntimeEvents {
  return asUiEvents(createRemoteRuntimeEvents(connect));
}
