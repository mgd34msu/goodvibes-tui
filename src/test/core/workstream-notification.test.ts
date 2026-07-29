/**
 * A workstream's desktop notification names the outcome, not the chain.
 *
 * These three notifications used to read `GoodVibes — WRFC chain failed` /
 * `chain 7f3a91c02b4e failed: review rejected`. A notification is a message to
 * a person, so it carries neither the internal name for the machinery nor a
 * register id — plain language only.
 */
import { describe, expect, test } from 'bun:test';
import { workstreamFailureNotification } from '@/core/workstream-notification.ts';

const CHAIN_ID = 'chain-abcdef123456';

describe('a workstream notification carries no identifier', () => {
  const cases = [
    { name: 'an ordinary failure', payload: { reason: 'review rejected', failureKind: 'other' as const } },
    { name: 'a transport failure', payload: { reason: 'ECONNRESET', failureKind: 'transport' as const } },
    { name: 'an operator cancellation', payload: { reason: 'operator cancellation — 2 files already modified on disk', failureKind: 'cancelled' as const } },
    { name: 'a spent turn budget', payload: { reason: 'agent reached the turn limit of 50', failureKind: 'max_turns' as const, turnLimit: 50, turnLimitSource: 'default' as const } },
    { name: 'an unclassified failure', payload: { reason: 'the gates never went green' } },
  ];

  for (const { name, payload } of cases) {
    test(`${name} names neither the machinery nor a chain id`, () => {
      const { title, body } = workstreamFailureNotification(payload);
      const text = `${title}\n${body}`;
      expect(text).not.toContain('WRFC');
      expect(text).not.toContain(CHAIN_ID);
      expect(text).not.toContain(CHAIN_ID.slice(0, 12));
      // "chain" as a word for the work is internal vocabulary too.
      expect(text.toLowerCase()).not.toContain('chain');
      expect(title).toContain('workstream');
      expect(body.trim().length).toBeGreaterThan(0);
    });
  }
});

describe('the notification still says what happened', () => {
  test('an operator cancellation is narrated as cancelled, not as a failure', () => {
    const { title, body } = workstreamFailureNotification({
      reason: 'operator cancellation — 2 files already modified on disk',
      failureKind: 'cancelled',
    });
    expect(title).toContain('cancelled');
    expect(title).not.toContain('failed');
    expect(body).toContain('2 files already modified on disk');
  });

  test('a spent turn budget reports the limit and where it came from', () => {
    const { title, body } = workstreamFailureNotification({
      reason: 'agent reached the turn limit of 50',
      failureKind: 'max_turns',
      turnLimit: 50,
      turnLimitSource: 'default',
    });
    expect(title).toContain('turn budget');
    expect(body).toContain('50');
  });

  test('a transport failure is named as transient rather than quoting the raw error', () => {
    const { body } = workstreamFailureNotification({ reason: 'ECONNRESET', failureKind: 'transport' });
    expect(body).toContain('transient transport error');
    expect(body).not.toContain('ECONNRESET');
  });

  test('an ordinary failure carries the reason the reader can act on', () => {
    const { title, body } = workstreamFailureNotification({ reason: 'review rejected', failureKind: 'other' });
    expect(title).toContain('failed');
    expect(body).toContain('review rejected');
  });

  test('two workstreams ending at once are told apart by their reasons', () => {
    const one = workstreamFailureNotification({ reason: 'the typecheck gate failed', failureKind: 'other' });
    const two = workstreamFailureNotification({ reason: 'review scored 4 out of 10', failureKind: 'other' });
    expect(one.body).not.toBe(two.body);
  });
});
