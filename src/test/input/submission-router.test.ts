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
    // The free-form project-planning command (renamed from /plan to
    // /project-plan when /plan became the plan-mode toggle) keeps the 'plan'
    // composer intent for its free-form goal text.
    expect(routeSubmissionIntent({ text: '/project-plan draft roadmap' })).toMatchObject({
      kind: 'plan',
      commandName: 'project-plan',
    });
    expect(routeSubmissionIntent({ text: '/planning draft roadmap' })).toMatchObject({
      kind: 'plan',
      commandName: 'planning',
    });
    // /plan is now a plain slash-command (the plan-mode toggle), not the
    // free-form 'plan' intent.
    expect(routeSubmissionIntent({ text: '/plan' })).toMatchObject({
      kind: 'slash-command',
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

