import { describe, test, expect } from 'bun:test';
import { classifySystemMessage } from '../../renderer/system-message.ts';

describe('classifySystemMessage', () => {
  describe('[WRFC] messages', () => {
    test('chain started with "error" in description → info', () => {
      expect(classifySystemMessage('[WRFC] Chain wrfc-abc started: Fix the error handling')).toBe('info');
    });

    test('chain FAILED → error', () => {
      expect(classifySystemMessage('[WRFC] × Chain wrfc-abc FAILED: timeout')).toBe('error');
    });

    test('Gate: review FAILED → error', () => {
      expect(classifySystemMessage('[WRFC] Gate: review FAILED')).toBe('error');
    });

    test('chain started without keywords → info', () => {
      expect(classifySystemMessage('[WRFC] Chain wrfc-abc started: Create server')).toBe('info');
    });

    test('spawning a fix agent → warning', () => {
      expect(classifySystemMessage('[WRFC] Score 6/10, spawning a fix agent')).toBe('warning');
    });

    test('cascade abort → error', () => {
      expect(classifySystemMessage('[WRFC] cascade abort: dependency failed')).toBe('error');
    });
  });

  describe('[Agents] messages', () => {
    test('✗ agent failed → error', () => {
      expect(classifySystemMessage('[Agents] \u2717 agent-abc failed')).toBe('error');
    });

    test('Cohort complete: 1 failed → warning', () => {
      expect(classifySystemMessage('[Agents] Cohort complete: 1 failed, 3 succeeded')).toBe('warning');
    });

    test('Cohort complete: 0 failed → info', () => {
      expect(classifySystemMessage('[Agents] Cohort complete: 0 failed, 4 succeeded')).toBe('info');
    });

    test('Cohort complete: multiple failed → warning', () => {
      expect(classifySystemMessage('[Agents] Cohort complete: 3 failed, 1 succeeded')).toBe('warning');
    });

    test('agent running → info', () => {
      expect(classifySystemMessage('[Agents] agent-abc running')).toBe('info');
    });

    test('agent ✓ completed → info', () => {
      expect(classifySystemMessage('[Agents] \u2713 agent-abc completed')).toBe('info');
    });
  });

  describe('[Plan] messages', () => {
    test('progress update → info', () => {
      expect(classifySystemMessage('[Plan] progress update: step 2 of 5')).toBe('info');
    });

    test('plan with error keyword → info (prefix takes precedence)', () => {
      expect(classifySystemMessage('[Plan] failed to parse: retrying')).toBe('info');
    });
  });

  describe('[Model] messages', () => {
    test('Unknown model xyz → warning', () => {
      expect(classifySystemMessage('[Model] Unknown model xyz')).toBe('warning');
    });

    test('Switched to gpt-5 → info', () => {
      expect(classifySystemMessage('[Model] Switched to gpt-5')).toBe('info');
    });
  });

  describe('[Routing] messages', () => {
    test('a routing chip is informational even though it says "changed"', () => {
      expect(classifySystemMessage('[Routing] model changed: a → b (reason unknown)')).toBe('info');
    });
  });

  describe('[Local] messages', () => {
    test('Server found → info', () => {
      expect(classifySystemMessage('[Local] Server found at localhost:3000')).toBe('info');
    });

    test('local message with error keyword → info (prefix takes precedence)', () => {
      expect(classifySystemMessage('[Local] error connecting to socket')).toBe('info');
    });
  });

  describe('[Recovery] messages', () => {
    test('Failed to restore session → error', () => {
      expect(classifySystemMessage('[Recovery] Failed to restore session')).toBe('error');
    });

    test('Session restored → info', () => {
      expect(classifySystemMessage('[Recovery] Session restored successfully')).toBe('info');
    });
  });

  describe('generic messages', () => {
    test('non-WRFC message with "error" keyword → error', () => {
      expect(classifySystemMessage('An unexpected error occurred')).toBe('error');
    });

    test('non-WRFC message without error keywords → info', () => {
      expect(classifySystemMessage('Operation completed successfully')).toBe('info');
    });

    test('quote-stripping prevents false positive from double-quoted task description → info', () => {
      expect(classifySystemMessage('Task: "Fix the error in auth.ts"')).toBe('info');
    });

    test('quote-stripping prevents false positive from single-quoted task description → info', () => {
      expect(classifySystemMessage("Task: 'Fix the error in auth.ts'")).toBe('info');
    });

    test('quote-stripping prevents false positive from backtick-quoted task description → info', () => {
      expect(classifySystemMessage('Task: `Fix the error in auth.ts`')).toBe('info');
    });

    test('warning: context usage high → warning', () => {
      expect(classifySystemMessage('warning: context usage high')).toBe('warning');
    });

    test('Something crashed → error', () => {
      expect(classifySystemMessage('Something crashed unexpectedly')).toBe('error');
    });

    test('failed keyword → error', () => {
      expect(classifySystemMessage('Build failed after 3 retries')).toBe('error');
    });

    test('deprecated keyword → warning', () => {
      expect(classifySystemMessage('This API is deprecated')).toBe('warning');
    });
  });
});
