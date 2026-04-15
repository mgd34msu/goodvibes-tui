import { describe, test, expect } from 'bun:test';
import { safeEvaluate } from '@pellux/goodvibes-sdk/platform/hooks/chain-engine';

describe('safeEvaluate', () => {
  describe('string methods', () => {
    test('startsWith evaluates correctly', () => {
      expect(safeEvaluate("message.startsWith('pre-compact')", { message: 'pre-compact-context' })).toBe(true);
      expect(safeEvaluate("message.startsWith('pre-compact')", { message: 'post-compact' })).toBe(false);
    });

    test('endsWith evaluates correctly', () => {
      expect(safeEvaluate("message.endsWith('done')", { message: 'operation-done' })).toBe(true);
      expect(safeEvaluate("message.endsWith('done')", { message: 'operation-failed' })).toBe(false);
    });

    test('includes evaluates correctly', () => {
      expect(safeEvaluate("message.includes('error')", { message: 'unexpected error occurred' })).toBe(true);
      expect(safeEvaluate("message.includes('error')", { message: 'all good' })).toBe(false);
    });
  });

  describe('comparison operators', () => {
    test('> evaluates correctly', () => {
      expect(safeEvaluate('count > 5', { count: 10 })).toBe(true);
      expect(safeEvaluate('count > 5', { count: 3 })).toBe(false);
      expect(safeEvaluate('count > 5', { count: 5 })).toBe(false);
    });

    test('>= evaluates correctly', () => {
      expect(safeEvaluate('count >= 5', { count: 5 })).toBe(true);
      expect(safeEvaluate('count >= 5', { count: 4 })).toBe(false);
    });

    test('< evaluates correctly', () => {
      expect(safeEvaluate('count < 10', { count: 5 })).toBe(true);
      expect(safeEvaluate('count < 10', { count: 10 })).toBe(false);
    });

    test('<= evaluates correctly', () => {
      expect(safeEvaluate('count <= 10', { count: 10 })).toBe(true);
      expect(safeEvaluate('count <= 10', { count: 11 })).toBe(false);
    });

    test('=== evaluates correctly', () => {
      expect(safeEvaluate("status === 'done'", { status: 'done' })).toBe(true);
      expect(safeEvaluate("status === 'done'", { status: 'pending' })).toBe(false);
    });

    test('!== evaluates correctly', () => {
      expect(safeEvaluate("status !== 'done'", { status: 'pending' })).toBe(true);
      expect(safeEvaluate("status !== 'done'", { status: 'done' })).toBe(false);
    });
  });

  describe('logical operators', () => {
    test('&& evaluates correctly', () => {
      expect(safeEvaluate('count > 5 && count < 20', { count: 10 })).toBe(true);
      expect(safeEvaluate('count > 5 && count < 20', { count: 3 })).toBe(false);
    });

    test('|| evaluates correctly', () => {
      expect(safeEvaluate("status === 'done' || status === 'complete'", { status: 'complete' })).toBe(true);
      expect(safeEvaluate("status === 'done' || status === 'complete'", { status: 'pending' })).toBe(false);
    });

    test('! negation evaluates correctly', () => {
      // !false === true
      expect(safeEvaluate('!active', { active: false })).toBe(true);
      expect(safeEvaluate('!active', { active: true })).toBe(false);
    });
  });

  describe('literals', () => {
    test('boolean literals', () => {
      expect(safeEvaluate('true', {})).toBe(true);
      expect(safeEvaluate('false', {})).toBe(false);
    });

    test('null literal', () => {
      expect(safeEvaluate('null', {})).toBe(false);
    });

    test('undefined literal', () => {
      expect(safeEvaluate('undefined', {})).toBe(false);
    });
  });

  describe('context access', () => {
    test('resolves context properties', () => {
      expect(safeEvaluate('active', { active: true })).toBe(true);
      expect(safeEvaluate('active', { active: false })).toBe(false);
    });

    test('unknown identifiers resolve to undefined (falsy)', () => {
      // identifiers not in context resolve to undefined
      expect(safeEvaluate('process', {})).toBe(false);
      expect(safeEvaluate('require', {})).toBe(false);
      expect(safeEvaluate('globalThis', {})).toBe(false);
    });
  });

  describe('injection rejection', () => {
    test('process.exit(1) does not execute — process is not in context', () => {
      // process is not a key in the context, so it resolves to undefined;
      // the method call parsePostfix silently returns false
      const result = safeEvaluate('process.exit(1)', {});
      expect(result).toBe(false);
    });

    test('require expression is rejected — not in context', () => {
      const result = safeEvaluate("require('child_process')", {});
      // require is not in context; method call on undefined returns false
      expect(result).toBe(false);
    });

    test('import expression is rejected — not valid token', () => {
      // import is not a valid identifier our tokenizer produces
      const result = safeEvaluate("import('fs')", {});
      expect(result).toBe(false);
    });

    test('globalThis access is rejected — not in context', () => {
      const result = safeEvaluate('globalThis.process.exit', {});
      expect(result).toBe(false);
    });
  });

  describe('grouping', () => {
    test('parenthesized expressions evaluate correctly', () => {
      expect(safeEvaluate('(count > 0)', { count: 5 })).toBe(true);
      expect(safeEvaluate('(count > 5) && (count < 20)', { count: 10 })).toBe(true);
    });
  });
});
