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
  });

  describe('generic messages', () => {
    test('non-WRFC message with "error" keyword → error', () => {
      expect(classifySystemMessage('An unexpected error occurred')).toBe('error');
    });

    test('non-WRFC message without error keywords → info', () => {
      expect(classifySystemMessage('Operation completed successfully')).toBe('info');
    });
  });
});
