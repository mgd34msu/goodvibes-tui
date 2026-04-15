import type { RuntimeEventBus, RuntimeEventEnvelope, AnyRuntimeEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type {
  ChannelRenderEvent,
  ChannelRenderPhase,
  ChannelRenderPolicy,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelReasoningVisibility,
  ChannelSurface,
} from '@pellux/goodvibes-sdk/platform/channels/types';
import type { ChannelPluginRegistry } from '@pellux/goodvibes-sdk/platform/channels/plugin-registry';
import type { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels/route-manager';

const MAX_BUFFERED_EVENTS = 64;
const DEFAULT_PROGRESS_INTERVAL_MS = 7_500;

export interface TrackedChannelReply {
  readonly agentId: string;
  readonly surfaceKind: ChannelSurface;
  readonly task: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly [key: string]: unknown;
}

interface ReplyPipelineDeps {
  readonly channelPlugins: ChannelPluginRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly runtimeBus?: RuntimeEventBus | null;
  readonly now?: () => number;
}

interface ReplyBufferState {
  readonly pending: TrackedChannelReply;
  readonly events: ChannelRenderEvent[];
  lastDeliveredText?: string;
  lastDeliveredAt?: number;
}

const DEFAULT_POLICY: Record<ChannelSurface, ChannelRenderPolicy> = {
  tui: {
    surface: 'tui',
    reasoningVisibility: 'public',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  web: {
    surface: 'web',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  slack: {
    surface: 'slack',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 2_500,
    maxEventsPerUpdate: 12,
    metadata: {},
  },
  discord: {
    surface: 'discord',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 2_500,
    maxEventsPerUpdate: 12,
    metadata: {},
  },
  ntfy: {
    surface: 'ntfy',
    reasoningVisibility: 'suppress',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 1_600,
    maxEventsPerUpdate: 6,
    metadata: {},
  },
  webhook: {
    surface: 'webhook',
    reasoningVisibility: 'private',
    format: 'json',
    supportsThreads: false,
    maxChunkChars: 12_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  telegram: {
    surface: 'telegram',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  'google-chat': {
    surface: 'google-chat',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  signal: {
    surface: 'signal',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  whatsapp: {
    surface: 'whatsapp',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  imessage: {
    surface: 'imessage',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  msteams: {
    surface: 'msteams',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  bluebubbles: {
    surface: 'bluebubbles',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  mattermost: {
    surface: 'mattermost',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  matrix: {
    surface: 'matrix',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
};

function trimText(value: string, limit: number): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function baseMetadata(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    runtimeType: envelope.type,
    traceId: envelope.traceId,
    source: envelope.source,
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
  };
}

function eventLine(event: ChannelRenderEvent, reasoningVisibility: ChannelReasoningVisibility): string | null {
  switch (event.kind) {
    case 'assistant_text':
      return event.text?.trim() ? event.text.trim() : null;
    case 'reasoning':
      if (reasoningVisibility === 'suppress') return null;
      if (!event.text?.trim()) return null;
      return reasoningVisibility === 'summary'
        ? `Reasoning: ${trimText(event.text, 220)}`
        : `Reasoning: ${event.text.trim()}`;
    case 'tool_start':
      return event.toolName ? `Tool started: ${event.toolName}` : event.text ?? null;
    case 'tool_result':
      return event.toolName
        ? `${event.text?.startsWith('Failed') ? 'Tool failed' : 'Tool finished'}: ${event.toolName}${event.summary ? ` (${event.summary})` : ''}`
        : event.text ?? null;
    case 'plan':
      return event.text ? `Plan: ${event.text}` : null;
    case 'approval':
      return event.text ? `Approval: ${event.text}` : null;
    case 'command_output':
      return event.text ? `Command output: ${event.text}` : null;
    case 'patch':
      return event.text ? `Patch: ${event.text}` : null;
    case 'compaction':
      return event.text ? `Compaction: ${event.text}` : null;
    case 'model':
      return event.provider || event.model
        ? `Model: ${[event.provider, event.model].filter(Boolean).join(' / ')}`
        : event.text ?? null;
    case 'status':
      return event.text ?? null;
    case 'error':
      return event.text ? `Error: ${event.text}` : null;
  }
}

function buildRenderedText(
  explicitText: string,
  events: readonly ChannelRenderEvent[],
  policy: ChannelRenderPolicy,
  phase: ChannelRenderPhase,
): string {
  if (phase === 'final' && explicitText.trim().length > 0) {
    return trimText(explicitText, policy.maxChunkChars);
  }
  const lines = events
    .slice(-policy.maxEventsPerUpdate)
    .map((event) => eventLine(event, policy.reasoningVisibility))
    .filter((line): line is string => Boolean(line && line.trim().length > 0));
  const deduped = lines.filter((line, index) => lines.indexOf(line) === index);
  return trimText(deduped.join('\n'), policy.maxChunkChars);
}

function renderEvent(
  kind: ChannelRenderEvent['kind'],
  phase: ChannelRenderPhase,
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  extras: Partial<ChannelRenderEvent> = {},
): ChannelRenderEvent {
  return {
    id: `${envelope.traceId}:${kind}:${envelope.ts}`,
    kind,
    phase,
    ts: envelope.ts,
    metadata: baseMetadata(envelope),
    ...extras,
  };
}

export function normalizeChannelRenderEventFromRuntime(
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
): ChannelRenderEvent[] {
  const payload = envelope.payload;
  switch (payload.type) {
    case 'AGENT_STREAM_DELTA':
      return payload.content.trim().length > 0
        ? [renderEvent('assistant_text', 'progress', envelope, { text: payload.content })]
        : [];
    case 'AGENT_PROGRESS':
      return payload.progress.trim().length > 0
        ? [renderEvent('status', 'progress', envelope, { text: payload.progress })]
        : [];
    case 'AGENT_COMPLETED':
      return [
        ...(payload.output?.trim()
          ? [renderEvent('assistant_text', 'final', envelope, { text: payload.output })]
          : []),
        renderEvent('status', 'final', envelope, { text: `Agent completed in ${payload.durationMs}ms` }),
      ];
    case 'AGENT_FAILED':
      return [renderEvent('error', 'final', envelope, { text: payload.error })];
    case 'AGENT_CANCELLED':
      return [renderEvent('status', 'final', envelope, { text: payload.reason ? `Cancelled: ${payload.reason}` : 'Cancelled' })];
    case 'STREAM_DELTA': {
      const events: ChannelRenderEvent[] = [];
      if (payload.content.trim().length > 0) {
        events.push(renderEvent('assistant_text', 'progress', envelope, { text: payload.content }));
      }
      if (payload.reasoning?.trim()) {
        events.push(renderEvent('reasoning', 'progress', envelope, { text: payload.reasoning }));
      }
      return events;
    }
    case 'TOOL_EXECUTING':
      return [renderEvent('tool_start', 'progress', envelope, { toolName: payload.tool, text: payload.tool })];
    case 'TOOL_SUCCEEDED':
      return [renderEvent('tool_result', 'progress', envelope, {
        toolName: payload.tool,
        text: 'Succeeded',
        summary: `${payload.durationMs}ms`,
      })];
    case 'TOOL_FAILED':
      return [renderEvent('tool_result', 'progress', envelope, {
        toolName: payload.tool,
        text: 'Failed',
        summary: payload.error,
      })];
    case 'PLAN_STRATEGY_SELECTED':
      return [renderEvent('plan', 'progress', envelope, {
        text: `Selected ${payload.selected} (${payload.reasonCode})${payload.inputs.taskDescription ? ` for ${payload.inputs.taskDescription}` : ''}`,
      })];
    case 'PLAN_STRATEGY_OVERRIDDEN':
      return [renderEvent('plan', 'progress', envelope, {
        text: payload.strategy ? `Overridden to ${payload.strategy}` : 'Planner override cleared',
      })];
    case 'PERMISSION_REQUESTED':
      return [renderEvent('approval', 'progress', envelope, {
        text: payload.summary ?? `Permission requested for ${payload.tool}`,
      })];
    case 'DECISION_EMITTED':
      return [renderEvent('approval', 'progress', envelope, {
        text: `${payload.approved ? 'Approved' : 'Denied'} ${payload.tool}`,
      })];
    case 'MODEL_FALLBACK':
      return [renderEvent('model', 'progress', envelope, {
        provider: payload.provider,
        model: `${payload.from} -> ${payload.to}`,
      })];
    case 'COMPACTION_CHECK':
    case 'COMPACTION_MICROCOMPACT':
    case 'COMPACTION_COLLAPSE':
    case 'COMPACTION_AUTOCOMPACT':
    case 'COMPACTION_REACTIVE':
    case 'COMPACTION_DONE':
    case 'COMPACTION_FAILED':
    case 'COMPACTION_RESUME_REPAIR':
    case 'COMPACTION_QUALITY_SCORE':
    case 'COMPACTION_STRATEGY_SWITCH':
      return [renderEvent(payload.type === 'COMPACTION_FAILED' ? 'error' : 'compaction', 'progress', envelope, {
        text: payload.type.replace(/^COMPACTION_/, '').toLowerCase().replace(/_/g, ' '),
      })];
    case 'TURN_COMPLETED':
      return payload.response.trim().length > 0
        ? [renderEvent('assistant_text', 'final', envelope, { text: payload.response })]
        : [];
    case 'TURN_ERROR':
      return [renderEvent('error', 'final', envelope, { text: payload.error })];
    default:
      return [];
  }
}

export class ChannelReplyPipeline {
  private readonly channelPlugins: ChannelPluginRegistry;
  private readonly routeBindings: RouteBindingManager;
  private readonly now: () => number;
  private readonly buffers = new Map<string, ReplyBufferState>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(deps: ReplyPipelineDeps) {
    this.channelPlugins = deps.channelPlugins;
    this.routeBindings = deps.routeBindings;
    this.now = deps.now ?? (() => Date.now());
    this.attachRuntimeBus(deps.runtimeBus ?? null);
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.disposeSubscriptions();
    if (!runtimeBus) return;
    const domains: Array<Parameters<RuntimeEventBus['onDomain']>[0]> = [
      'agents',
      'turn',
      'tools',
      'planner',
      'permissions',
      'providers',
      'compaction',
    ];
    for (const domain of domains) {
      this.unsubscribers.push(runtimeBus.onDomain(domain, (envelope) => {
        void this.handleEnvelope(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }));
    }
  }

  dispose(): void {
    this.disposeSubscriptions();
    this.buffers.clear();
  }

  trackPending(pending: TrackedChannelReply): void {
    this.buffers.set(pending.agentId, {
      pending,
      events: [],
    });
  }

  untrack(agentId: string): void {
    this.buffers.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.buffers.has(agentId);
  }

  getPending(agentId: string): TrackedChannelReply | null {
    return this.buffers.get(agentId)?.pending ?? null;
  }

  async deliverProgress(agentId: string, explicitText?: string, force = false): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    const text = buildRenderedText(explicitText ?? '', state.events, policy, 'progress');
    if (!text) return null;
    if (!force && state.lastDeliveredText === text && (this.now() - (state.lastDeliveredAt ?? 0)) < DEFAULT_PROGRESS_INTERVAL_MS) {
      return null;
    }
    const result = await this.dispatch(state, policy, 'progress', text, state.events.slice(-policy.maxEventsPerUpdate));
    state.lastDeliveredText = text;
    state.lastDeliveredAt = this.now();
    return result;
  }

  async deliverFinal(agentId: string, explicitText: string): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    const finalEvents = state.events.filter((event) => event.phase === 'final');
    const statusEvent: ChannelRenderEvent = {
      id: `final:${agentId}:${this.now()}`,
      kind: 'status',
      phase: 'final',
      ts: this.now(),
      text: 'Completed',
      metadata: {},
    };
    const result = await this.dispatch(
      state,
      policy,
      'final',
      buildRenderedText(explicitText, finalEvents.length > 0 ? finalEvents : [...state.events, statusEvent], policy, 'final'),
      finalEvents.length > 0 ? finalEvents : [...state.events.slice(-policy.maxEventsPerUpdate + 1), statusEvent],
    );
    this.untrack(agentId);
    return result;
  }

  private async handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): Promise<void> {
    const agentId = envelope.agentId;
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) return;
    const events = normalizeChannelRenderEventFromRuntime(envelope);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      const text = events
        .filter((event) => event.kind === 'assistant_text' || event.kind === 'error' || event.kind === 'status')
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text);
      return;
    }
    await this.deliverProgress(agentId);
  }

  private async resolvePolicy(surface: ChannelSurface): Promise<ChannelRenderPolicy> {
    return await this.channelPlugins.getRenderPolicy(surface) ?? DEFAULT_POLICY[surface];
  }

  private async dispatch(
    state: ReplyBufferState,
    policy: ChannelRenderPolicy,
    phase: ChannelRenderPhase,
    text: string,
    events: readonly ChannelRenderEvent[],
  ): Promise<ChannelRenderResult | null> {
    const request: ChannelRenderRequest = {
      surface: state.pending.surfaceKind,
      phase,
      agentId: state.pending.agentId,
      sessionId: state.pending.sessionId,
      routeId: state.pending.routeId,
      title: state.pending.task,
      text,
      events,
      pending: state.pending,
      metadata: {
        policy,
      },
    };
    const result = await this.channelPlugins.render(state.pending.surfaceKind, request);
    if (result?.responseId && state.pending.routeId) {
      await this.routeBindings.captureReplyTarget(
        state.pending.routeId,
        result.responseId,
        typeof result.threadId === 'string' && result.threadId.length > 0 ? result.threadId : undefined,
      );
    }
    return result;
  }

  private disposeSubscriptions(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }
}
