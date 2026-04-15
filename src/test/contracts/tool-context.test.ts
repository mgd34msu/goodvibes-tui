import { describe, test, expect } from 'bun:test';
import type {
  ToolRuntimeContext,
  TaskHooks,
  RuntimeStoreAccess,
} from '@pellux/goodvibes-sdk/platform/runtime/tools/context';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { PhaseResult, ToolExecutionPhase } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';

// ---------------------------------------------------------------------------
// Minimal stubs — test structural invariants without real implementations
// ---------------------------------------------------------------------------

function makeStoreAccess(): RuntimeStoreAccess {
  return {
    getState: () => ({}),
    subscribe: (_listener) => () => {},
  };
}

function makeContext(overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext {
  const abort = new AbortController();
  return {
    runtime: makeStoreAccess(),
    ids: {
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      traceId: 'trace-1',
    },
    tasks: {},
    resources: {
      fileCache: {} as never,
      projectIndex: {} as never,
    },
    provider: {
      providerId: 'anthropic',
      modelId: 'claude-3-opus',
      contextWindow: 200000,
    },
    cancellation: {
      signal: abort.signal,
    },
    executionMode: 'interactive',
    runtimeBus: new RuntimeEventBus(),
    permissionManager: {} as never,
    hookDispatcher: {} as never,
    ...overrides,
  };
}

describe('ToolRuntimeContext contract', () => {
  describe('required fields', () => {
    test('context has runtime store access', () => {
      const ctx = makeContext();

      expect(typeof ctx.runtime.getState).toBe('function');
      expect(typeof ctx.runtime.subscribe).toBe('function');
    });

    test('ids contains all five required correlation fields', () => {
      const ctx = makeContext();

      expect(typeof ctx.ids.sessionId).toBe('string');
      expect(typeof ctx.ids.conversationId).toBe('string');
      expect(typeof ctx.ids.turnId).toBe('string');
      expect(typeof ctx.ids.toolCallId).toBe('string');
      expect(typeof ctx.ids.traceId).toBe('string');
    });

    test('cancellation.signal is an AbortSignal', () => {
      const ctx = makeContext();

      expect(ctx.cancellation.signal).toBeInstanceOf(AbortSignal);
    });

    test('executionMode is one of the three valid values', () => {
      const valid = new Set(['interactive', 'background', 'remote']);

      for (const mode of valid) {
        const ctx = makeContext({ executionMode: mode as ToolRuntimeContext['executionMode'] });
        expect(valid.has(ctx.executionMode)).toBe(true);
      }
    });

    test('provider has all three required fields', () => {
      const ctx = makeContext();

      expect(typeof ctx.provider.providerId).toBe('string');
      expect(typeof ctx.provider.modelId).toBe('string');
      expect(typeof ctx.provider.contextWindow).toBe('number');
    });
  });

  describe('optional fields', () => {
    test('agent is absent by default', () => {
      const ctx = makeContext();
      expect(ctx.agent).toBeUndefined();
    });

    test('agent fields are present when agent context is set', () => {
      const ctx = makeContext({
        agent: { agentId: 'ag-1', isolationMode: 'full' },
      });

      expect(ctx.agent).toBeDefined();
      expect(ctx.agent!.agentId).toBe('ag-1');
      expect(ctx.agent!.isolationMode).toBe('full');
    });

    test('budget is absent by default', () => {
      const ctx = makeContext();
      expect(ctx.budget).toBeUndefined();
    });

    test('runtimeBus is present by default', () => {
      const ctx = makeContext();
      expect(ctx.runtimeBus).toBeInstanceOf(RuntimeEventBus);
    });

    test('cancellation.reason is absent by default', () => {
      const ctx = makeContext();
      expect(ctx.cancellation.reason).toBeUndefined();
    });
  });

  describe('TaskHooks contract', () => {
    test('all task hook fields are optional', () => {
      const empty: TaskHooks = {};
      expect(empty.onStart).toBeUndefined();
      expect(empty.onComplete).toBeUndefined();
      expect(empty.onError).toBeUndefined();
    });

    test('task hooks accept callable functions', () => {
      const calls: string[] = [];
      const hooks: TaskHooks = {
        onStart: (callId, toolName) => calls.push(`start:${callId}:${toolName}`),
        onComplete: (callId, durationMs) => calls.push(`complete:${callId}:${durationMs}`),
        onError: (callId, error) => calls.push(`error:${callId}:${error}`),
      };

      hooks.onStart!('c1', 'read');
      hooks.onComplete!('c1', 42);
      hooks.onError!('c1', 'boom');

      expect(calls).toEqual(['start:c1:read', 'complete:c1:42', 'error:c1:boom']);
    });
  });

  describe('PhaseResult contract', () => {
    test('PhaseResult has required phase, success, and durationMs fields', () => {
      const phases: ToolExecutionPhase[] = [
        'validated', 'prehooked', 'permissioned', 'executing', 'mapped', 'posthooked',
      ];

      for (const phase of phases) {
        const result: PhaseResult = {
          phase,
          success: true,
          durationMs: 10,
        };
        expect(result.phase).toBe(phase);
        expect(result.success).toBe(true);
        expect(result.durationMs).toBe(10);
        expect(result.abort).toBeUndefined();
        expect(result.error).toBeUndefined();
      }
    });

    test('PhaseResult abort field signals pipeline halt', () => {
      const result: PhaseResult = {
        phase: 'permissioned',
        success: false,
        durationMs: 1,
        abort: true,
        error: 'Permission denied',
      };

      expect(result.abort).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });

  describe('RuntimeStoreAccess contract', () => {
    test('getState returns a snapshot object', () => {
      const store = makeStoreAccess();
      const state = store.getState();

      expect(typeof state).toBe('object');
      expect(state).not.toBeNull();
    });

    test('subscribe returns an unsubscribe function', () => {
      const store = makeStoreAccess();
      const unsub = store.subscribe(() => {});

      expect(typeof unsub).toBe('function');
      expect(() => unsub()).not.toThrow();
    });
  });
});
