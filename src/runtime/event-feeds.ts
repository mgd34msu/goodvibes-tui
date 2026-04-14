import type { EventEnvelope } from './event-envelope.ts';

type EventLike = { readonly type: string };

type EventForType<
  TEvent extends EventLike,
  TType extends TEvent['type'],
> = Extract<TEvent, { type: TType }>;

export interface RuntimeEventFeed<TEvent extends EventLike = EventLike> {
  on<TType extends TEvent['type']>(
    type: TType,
    listener: (payload: EventForType<TEvent, TType>) => void,
  ): () => void;
  onEnvelope<TType extends TEvent['type']>(
    type: TType,
    listener: (envelope: EventEnvelope<TType, EventForType<TEvent, TType>>) => void,
  ): () => void;
}

export type RuntimeEventFeeds<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = {
  readonly domains: readonly TDomain[];
  domain(domain: TDomain): RuntimeEventFeed<TEvent>;
} & {
  readonly [K in TDomain]: RuntimeEventFeed<TEvent>;
};

export type EnvelopeSubscriber<TEvent extends EventLike> = <TType extends TEvent['type']>(
  type: TType,
  listener: (envelope: EventEnvelope<TType, EventForType<TEvent, TType>>) => void,
) => () => void;

export function createRuntimeEventFeed<TEvent extends EventLike>(
  subscribe: EnvelopeSubscriber<TEvent>,
): RuntimeEventFeed<TEvent> {
  return {
    on<TType extends TEvent['type']>(
      type: TType,
      listener: (payload: EventForType<TEvent, TType>) => void,
    ): () => void {
      return subscribe(type, (envelope) => {
        listener(envelope.payload as EventForType<TEvent, TType>);
      });
    },
    onEnvelope<TType extends TEvent['type']>(
      type: TType,
      listener: (envelope: EventEnvelope<TType, EventForType<TEvent, TType>>) => void,
    ): () => void {
      return subscribe(type, listener);
    },
  };
}

export function createRuntimeEventFeeds<
  TDomain extends string,
  TEvent extends EventLike,
>(
  domains: readonly TDomain[],
  createFeed: (domain: TDomain) => RuntimeEventFeed<TEvent>,
): RuntimeEventFeeds<TDomain, TEvent> {
  const feeds = {} as Record<TDomain, RuntimeEventFeed<TEvent>>;
  for (const domain of domains) {
    feeds[domain] = createFeed(domain);
  }
  return Object.freeze({
    ...feeds,
    domains,
    domain(domain: TDomain): RuntimeEventFeed<TEvent> {
      return feeds[domain];
    },
  }) as RuntimeEventFeeds<TDomain, TEvent>;
}
