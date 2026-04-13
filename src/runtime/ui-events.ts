import type {
  AgentEvent,
  AnyRuntimeEvent,
  OpsEvent,
  PlannerEvent,
  ProviderEvent,
  RuntimeEventBus,
  RuntimeEventEnvelope,
  SessionEvent,
  ToolEvent,
  TurnEvent,
  WorkflowEvent,
} from './events/index.ts';

type EventForType<
  TEvent extends AnyRuntimeEvent,
  TType extends TEvent['type'],
> = Extract<TEvent, { type: TType }>;

type PayloadForType<
  TEvent extends AnyRuntimeEvent,
  TType extends TEvent['type'],
> = EventForType<TEvent, TType>;

export interface UiEventFeed<TEvent extends AnyRuntimeEvent> {
  on<TType extends TEvent['type']>(
    type: TType,
    listener: (payload: PayloadForType<TEvent, TType>) => void,
  ): () => void;
  onEnvelope<TType extends TEvent['type']>(
    type: TType,
    listener: (envelope: RuntimeEventEnvelope<TType, PayloadForType<TEvent, TType>>) => void,
  ): () => void;
}

export interface UiRuntimeEvents {
  readonly sessions: UiEventFeed<SessionEvent>;
  readonly turns: UiEventFeed<TurnEvent>;
  readonly tools: UiEventFeed<ToolEvent>;
  readonly providers: UiEventFeed<ProviderEvent>;
  readonly agents: UiEventFeed<AgentEvent>;
  readonly workflows: UiEventFeed<WorkflowEvent>;
  readonly planner: UiEventFeed<PlannerEvent>;
  readonly ops: UiEventFeed<OpsEvent>;
}

function createUiEventFeed<TEvent extends AnyRuntimeEvent>(runtimeBus: RuntimeEventBus): UiEventFeed<TEvent> {
  return {
    on<TType extends TEvent['type']>(
      type: TType,
      listener: (payload: PayloadForType<TEvent, TType>) => void,
    ): () => void {
      return runtimeBus.on(type as TEvent['type'], (envelope) => {
        listener(envelope.payload as PayloadForType<TEvent, TType>);
      });
    },
    onEnvelope<TType extends TEvent['type']>(
      type: TType,
      listener: (envelope: RuntimeEventEnvelope<TType, PayloadForType<TEvent, TType>>) => void,
    ): () => void {
      return runtimeBus.on(type as TEvent['type'], (envelope) => {
        listener(envelope as RuntimeEventEnvelope<TType, PayloadForType<TEvent, TType>>);
      });
    },
  };
}

export function createUiRuntimeEvents(runtimeBus: RuntimeEventBus): UiRuntimeEvents {
  return {
    sessions: createUiEventFeed<SessionEvent>(runtimeBus),
    turns: createUiEventFeed<TurnEvent>(runtimeBus),
    tools: createUiEventFeed<ToolEvent>(runtimeBus),
    providers: createUiEventFeed<ProviderEvent>(runtimeBus),
    agents: createUiEventFeed<AgentEvent>(runtimeBus),
    workflows: createUiEventFeed<WorkflowEvent>(runtimeBus),
    planner: createUiEventFeed<PlannerEvent>(runtimeBus),
    ops: createUiEventFeed<OpsEvent>(runtimeBus),
  };
}
