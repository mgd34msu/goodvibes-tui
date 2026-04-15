import type { TaskEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/tasks';
import type { TransportEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/transport';
import { endTaskSpan, recordTaskPhase, startTaskSpan } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/task';
import { endTransportSpan, recordTransportPhase, startTransportSpan } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/transport';
import type { DomainBridgeAttachmentInput, Env, SpanMap } from './domain-bridge-shared.ts';

export function attachTransportDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  transportSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('TRANSPORT_INITIALIZING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_INITIALIZING' }>>) => {
      helpers.safe(() => {
        const span = startTransportSpan(helpers.tracer, {
          transportId: env.payload.transportId,
          protocol: env.payload.protocol,
          traceId: env.traceId,
        });
        transportSpans.set(env.payload.transportId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_AUTHENTICATING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_AUTHENTICATING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(transportSpans, env.payload.transportId, (span) => recordTransportPhase(span, 'authenticating'));
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_CONNECTED', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_CONNECTED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(transportSpans, env.payload.transportId, (span) => {
          recordTransportPhase(span, 'connected', {
            'transport.endpoint': env.payload.endpoint,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_SYNCING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_SYNCING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(transportSpans, env.payload.transportId, (span) => recordTransportPhase(span, 'syncing'));
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_DEGRADED', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_DEGRADED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(transportSpans, env.payload.transportId, (span) => {
          recordTransportPhase(span, 'degraded', {
            'transport.degraded_reason': env.payload.reason,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_RECONNECTING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_RECONNECTING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(transportSpans, env.payload.transportId, (span) => {
          recordTransportPhase(span, 'reconnecting', {
            'transport.reconnect_attempt': env.payload.attempt,
            'transport.reconnect_max_attempts': env.payload.maxAttempts,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_DISCONNECTED', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_DISCONNECTED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(transportSpans, env.payload.transportId, (span) => {
          endTransportSpan(span, {
            outcome: 'disconnected',
            reason: env.payload.reason,
            willRetry: env.payload.willRetry,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TRANSPORT_TERMINAL_FAILURE', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_TERMINAL_FAILURE' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(transportSpans, env.payload.transportId, (span) => {
          endTransportSpan(span, {
            outcome: 'terminal_failure',
            reason: env.payload.error,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}

export function attachTaskDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  taskSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('TASK_CREATED', (env: Env<Extract<TaskEvent, { type: 'TASK_CREATED' }>>) => {
      helpers.safe(() => {
        const span = startTaskSpan(helpers.tracer, {
          taskId: env.payload.taskId,
          agentId: env.payload.agentId,
          description: env.payload.description,
          priority: env.payload.priority,
          traceId: env.traceId,
        });
        taskSpans.set(env.payload.taskId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('TASK_STARTED', (env: Env<Extract<TaskEvent, { type: 'TASK_STARTED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(taskSpans, env.payload.taskId, (span) => recordTaskPhase(span, 'started'));
      });
    }),
  );

  unsubs.push(
    bus.on('TASK_BLOCKED', (env: Env<Extract<TaskEvent, { type: 'TASK_BLOCKED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(taskSpans, env.payload.taskId, (span) => {
          recordTaskPhase(span, 'blocked', {
            'task.blocked_reason': env.payload.reason,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TASK_PROGRESS', (env: Env<Extract<TaskEvent, { type: 'TASK_PROGRESS' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(taskSpans, env.payload.taskId, (span) => {
          recordTaskPhase(span, 'progress', {
            'task.progress': env.payload.progress,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TASK_COMPLETED', (env: Env<Extract<TaskEvent, { type: 'TASK_COMPLETED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(taskSpans, env.payload.taskId, (span) => {
          endTaskSpan(span, {
            outcome: 'completed',
            durationMs: env.payload.durationMs,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TASK_FAILED', (env: Env<Extract<TaskEvent, { type: 'TASK_FAILED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(taskSpans, env.payload.taskId, (span) => {
          endTaskSpan(span, {
            outcome: 'failed',
            durationMs: env.payload.durationMs,
            error: env.payload.error,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('TASK_CANCELLED', (env: Env<Extract<TaskEvent, { type: 'TASK_CANCELLED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(taskSpans, env.payload.taskId, (span) => {
          endTaskSpan(span, {
            outcome: 'cancelled',
            durationMs: 0,
            reason: env.payload.reason,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}
