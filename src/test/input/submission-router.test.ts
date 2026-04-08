import { describe, expect, test } from 'bun:test';
import { routeSubmissionIntent } from '../../input/submission-router.ts';

describe('submission router', () => {
  test('classifies plain text as prompt', () => {
    expect(routeSubmissionIntent({ text: 'hello world' })).toMatchObject({
      kind: 'prompt',
      label: 'prompt',
    });
  });

  test('classifies slash planning commands', () => {
    expect(routeSubmissionIntent({ text: '/plan draft roadmap' })).toMatchObject({
      kind: 'plan',
      commandName: 'plan',
    });
  });

  test('classifies orchestration commands', () => {
    expect(routeSubmissionIntent({ text: '/teamwork create-mode review bug bash' })).toMatchObject({
      kind: 'orchestration',
      commandName: 'teamwork',
    });
  });

  test('classifies shell shorthand and memory pin', () => {
    expect(routeSubmissionIntent({ text: '!git status' }).kind).toBe('shell');
    expect(routeSubmissionIntent({ text: '!# remember this' }).kind).toBe('memory-pin');
  });
});

