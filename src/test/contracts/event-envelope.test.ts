import { describe, test, expect } from 'bun:test';
import {
  createEventEnvelope,
  type RuntimeEventEnvelope,
  type EnvelopeContext,
} from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { TaskEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/tasks';

describe('event-envelope contract', () => {
  const baseContext: EnvelopeContext = {
    sessionId: 'session-001',
    source: 'test-module',
  };

  describe('required fields', () => {
    test('envelope has all required fields', () => {
      // Arrange
      const payload = { type: 'TASK_CREATED' as const, taskId: 't1', description: 'test', priority: 1 };

      // Act
      const envelope = createEventEnvelope('TASK_CREATED', payload, baseContext);

      // Assert
      expect(envelope.type).toBe('TASK_CREATED');
      expect(typeof envelope.ts).toBe('number');
      expect(envelope.ts).toBeGreaterThan(0);
      expect(typeof envelope.traceId).toBe('string');
      expect(envelope.traceId.length).toBeGreaterThan(0);
      expect(envelope.sessionId).toBe('session-001');
      expect(envelope.source).toBe('test-module');
      expect(envelope.payload).toBe(payload);
    });

    test('ts is a recent unix timestamp in milliseconds', () => {
      const before = Date.now();
      const envelope = createEventEnvelope('TASK_STARTED', { type: 'TASK_STARTED' as const, taskId: 't1' }, baseContext);
      const after = Date.now();

      expect(envelope.ts).toBeGreaterThanOrEqual(before);
      expect(envelope.ts).toBeLessThanOrEqual(after);
    });

    test('optional fields are undefined when not provided', () => {
      const envelope = createEventEnvelope('TASK_COMPLETED', { type: 'TASK_COMPLETED' as const, taskId: 't1', durationMs: 100 }, baseContext);

      expect(envelope.turnId).toBeUndefined();
      expect(envelope.agentId).toBeUndefined();
      expect(envelope.taskId).toBeUndefined();
    });

    test('optional fields are set when provided', () => {
      const ctx: EnvelopeContext = {
        ...baseContext,
        turnId: 'turn-42',
        agentId: 'agent-99',
        taskId: 'task-77',
        traceId: 'explicit-trace-id',
      };
      const envelope = createEventEnvelope('TASK_STARTED', { type: 'TASK_STARTED' as const, taskId: 't1' }, ctx);

      expect(envelope.turnId).toBe('turn-42');
      expect(envelope.agentId).toBe('agent-99');
      expect(envelope.taskId).toBe('task-77');
    });
  });

  describe('immutability', () => {
    test('envelope is frozen (immutable)', () => {
      const envelope = createEventEnvelope('TASK_CANCELLED', { type: 'TASK_CANCELLED' as const, taskId: 't1' }, baseContext);

      expect(Object.isFrozen(envelope)).toBe(true);
    });

    test('modifying a frozen envelope throws in strict mode or is silently ignored', () => {
      const envelope = createEventEnvelope('TASK_FAILED', { type: 'TASK_FAILED' as const, taskId: 't1', error: 'err', durationMs: 50 }, baseContext);

      // In strict mode this throws; in sloppy mode it is a no-op. Either way, value unchanged.
      try {
        (envelope as { type: string }).type = 'MUTATED';
      } catch (_e) {
        // expected in strict mode
      }
      expect(envelope.type).toBe('TASK_FAILED');
    });
  });

  describe('traceId generation', () => {
    test('traceId is auto-generated when not provided', () => {
      const e1 = createEventEnvelope('TASK_CREATED', { type: 'TASK_CREATED' as const, taskId: 't1', description: 'd', priority: 0 }, baseContext);
      const e2 = createEventEnvelope('TASK_CREATED', { type: 'TASK_CREATED' as const, taskId: 't2', description: 'd', priority: 0 }, baseContext);

      // Each envelope gets a unique trace ID
      expect(e1.traceId).not.toBe(e2.traceId);
    });

    test('traceId is UUID v4 format when auto-generated', () => {
      const envelope = createEventEnvelope('TASK_STARTED', { type: 'TASK_STARTED' as const, taskId: 't1' }, baseContext);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      expect(envelope.traceId).toMatch(uuidRegex);
    });

    test('provided traceId is preserved verbatim', () => {
      const ctx: EnvelopeContext = { ...baseContext, traceId: 'custom-trace-abc-123' };
      const envelope = createEventEnvelope('TASK_BLOCKED', { type: 'TASK_BLOCKED' as const, taskId: 't1', reason: 'dep' }, ctx);

      expect(envelope.traceId).toBe('custom-trace-abc-123');
    });
  });

  describe('discriminated union narrowing', () => {
    test('envelope.type matches payload.type for task events', () => {
      const taskEvents: TaskEvent[] = [
        { type: 'TASK_CREATED', taskId: 't1', description: 'd', priority: 1 },
        { type: 'TASK_STARTED', taskId: 't1' },
        { type: 'TASK_BLOCKED', taskId: 't1', reason: 'waiting' },
        { type: 'TASK_COMPLETED', taskId: 't1', durationMs: 100 },
        { type: 'TASK_FAILED', taskId: 't1', error: 'boom', durationMs: 50 },
        { type: 'TASK_CANCELLED', taskId: 't1' },
      ];

      for (const event of taskEvents) {
        const envelope = createEventEnvelope(event.type, event, baseContext);
        // envelope.type and payload.type are the same discriminant string
        expect(envelope.type).toBe(event.type);
        expect(envelope.payload.type).toBe(event.type);
      }
    });

    test('type-level: envelope generic narrows correctly via TypeScript', () => {
      // This is a compile-time test — if it compiles, the type is correct.
      const envelope: RuntimeEventEnvelope<'TASK_CREATED', TaskEvent & { type: 'TASK_CREATED' }> =
        createEventEnvelope('TASK_CREATED', { type: 'TASK_CREATED', taskId: 't1', description: 'd', priority: 0 }, baseContext);

      // Runtime assertion to satisfy the test runner
      expect(envelope.payload.taskId).toBe('t1');
    });
  });
});
