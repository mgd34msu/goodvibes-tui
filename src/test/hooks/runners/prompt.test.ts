import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { HookDefinition, HookEvent } from '../../../hooks/types.ts';

// --------------------------------------------------------------------------
// Mock ToolLLM module — must be declared before importing the runner so that
// the module under test picks up the mocked version.
// --------------------------------------------------------------------------
const mockChat = mock(async (_prompt: string): Promise<string> => '');

await mock.module('../../../config/tool-llm.ts', () => ({
  toolLLM: { chat: mockChat },
  ToolLLM: {
    getInstance: () => ({ chat: mockChat }),
    _reset: () => {},
  },
  resolveToolLLM: () => null,
}));

// Import the runner AFTER the module mock is registered
const { run } = await import('../../../hooks/runners/prompt.ts');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test',
    timestamp: Date.now(),
    payload: { tool: 'file_read' },
    ...overrides,
  };
}

beforeEach(() => {
  mockChat.mockReset();
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe('prompt runner', () => {
  describe('validation', () => {
    test('returns error when prompt field is missing', async () => {
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('prompt');
    });
  });

  describe('LLM response handling', () => {
    test('empty LLM response returns ok:true (fire-and-forget)', async () => {
      mockChat.mockImplementation(async () => '');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
    });

    test('non-JSON LLM response returns ok:true (fire-and-forget)', async () => {
      mockChat.mockImplementation(async () => 'Sure, I will allow that.');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
    });

    test('parses JSON allow decision from LLM response', async () => {
      mockChat.mockImplementation(async () => JSON.stringify({ ok: true, decision: 'allow' }));
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
      expect(result.decision).toBe('allow');
    });

    test('parses JSON deny decision from LLM response', async () => {
      mockChat.mockImplementation(async () =>
        JSON.stringify({ ok: true, decision: 'deny', reason: 'not allowed' })
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('not allowed');
    });

    test('parses updatedInput from LLM response', async () => {
      mockChat.mockImplementation(async () =>
        JSON.stringify({ ok: true, updatedInput: { safePath: '/tmp/safe' } })
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.updatedInput).toEqual({ safePath: '/tmp/safe' });
    });

    test('parses additionalContext from LLM response', async () => {
      mockChat.mockImplementation(async () =>
        JSON.stringify({ ok: true, additionalContext: 'extra info' })
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.additionalContext).toBe('extra info');
    });

    test('ok field defaults to true when absent in JSON response', async () => {
      mockChat.mockImplementation(async () => JSON.stringify({ decision: 'allow' }));
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
    });
  });

  describe('$ARGUMENTS substitution', () => {
    test('passes event JSON in the prompt via $ARGUMENTS', async () => {
      let capturedPrompt = '';
      mockChat.mockImplementation(async (p: string) => {
        capturedPrompt = p;
        return '';
      });
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'prompt',
        prompt: 'Evaluate: $ARGUMENTS',
      };
      const event = makeEvent({ sessionId: 'sentinel-123' });
      await run(hook, event);
      expect(capturedPrompt).toContain('sentinel-123');
      expect(capturedPrompt).toContain('"path":"Pre:tool:read"');
    });
  });

  describe('error handling', () => {
    test('returns error when LLM chat rejects', async () => {
      mockChat.mockImplementation(async () => { throw new Error('API rate limit'); });
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'prompt', prompt: 'Check $ARGUMENTS' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('API rate limit');
    });
  });

  describe('timeout', () => {
    test('returns error when LLM call exceeds timeout', async () => {
      mockChat.mockImplementation(
        () => new Promise<string>(resolve => setTimeout(() => resolve(''), 5000))
      );
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'prompt',
        prompt: 'Check $ARGUMENTS',
        timeout: 1,  // 1 second
      };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('timed out');
    }, 5000);
  });
});
