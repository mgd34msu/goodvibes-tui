import { describe, test, expect } from 'bun:test';
import { createWidget } from './widget.ts';

describe('Widget', () => {
  test('creates a Widget object with id and input fields', () => {
    const result = createWidget({ name: 'test' });
    expect(result).toHaveProperty('id');
    expect(result.name).toBe('test');
  });
});
