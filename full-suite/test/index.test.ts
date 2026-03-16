import { greet, add } from '../src/index.ts';

describe('greet', () => {
  it('returns greeting', () => {
    expect(greet('World')).toBe('Hello, World!');
  });
});

describe('add', () => {
  it('adds numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
});
