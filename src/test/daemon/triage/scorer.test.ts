import { describe, expect, it } from 'bun:test';
import {
  labelToTag,
  scoreInboundItem,
} from '../../../daemon/handlers/triage/scorer.ts';
import { item } from './helpers.ts';

describe('scoreInboundItem', () => {
  it('flags blatant spam with a high spam signal', () => {
    const result = scoreInboundItem(
      item({
        id: 'm1',
        surface: 'email',
        subject: 'CONGRATULATIONS you are a WINNER claim your free prize',
        snippet: 'Click now to claim your lottery cash prize. 100% free guaranteed!!!',
      }),
    );
    expect(result.label).toBe('spam');
    expect(result.signals.spam).toBeGreaterThan(0.65);
    expect(result.score).toBeGreaterThan(0.65);
  });

  it('flags an urgent direct message as priority', () => {
    const result = scoreInboundItem(
      item({
        id: 'm2',
        surface: 'slack',
        conversationKind: 'direct',
        subject: 'URGENT: action required before the deadline',
        snippet: 'Please respond ASAP, this is blocking the release.',
      }),
    );
    expect(result.label).toBe('priority');
    expect(result.signals.priority).toBeGreaterThan(0.6);
  });

  it('treats a plain friendly message as normal', () => {
    const result = scoreInboundItem(
      item({
        id: 'm3',
        surface: 'email',
        subject: 'lunch tomorrow',
        snippet: 'Want to grab a sandwich around noon?',
      }),
    );
    expect(result.label).toBe('normal');
    expect(result.signals.spam).toBeLessThan(0.65);
    expect(result.signals.priority).toBeLessThan(0.6);
  });

  it('is deterministic across repeated scoring', () => {
    const sample = item({
      id: 'm4',
      surface: 'discord',
      subject: 'reminder about the invoice payment due',
      snippet: 'Following up on the overdue invoice.',
    });
    const a = scoreInboundItem(sample);
    const b = scoreInboundItem(sample);
    expect(a).toEqual(b);
  });

  it('rounds all reported probabilities to two decimals', () => {
    const result = scoreInboundItem(
      item({ id: 'm5', surface: 'email', subject: 'hello', snippet: 'world' }),
    );
    for (const value of [result.score, result.signals.spam, result.signals.priority]) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
  });

  it('suppresses priority when an item is strongly spammy', () => {
    const result = scoreInboundItem(
      item({
        id: 'm6',
        surface: 'email',
        conversationKind: 'direct',
        subject: 'URGENT viagra casino lottery winner act now',
        snippet: 'guaranteed cash prize, wire transfer your inheritance now!!!',
      }),
    );
    expect(result.label).toBe('spam');
    expect(result.signals.priority).toBeLessThan(result.signals.spam);
  });

  it('honors custom thresholds and extra lexicon terms', () => {
    const result = scoreInboundItem(
      item({ id: 'm7', surface: 'email', subject: 'widgetcorp outage', snippet: 'the widgetcorp service is down' }),
      { priorityThreshold: 0.1, extraPriorityTerms: ['widgetcorp'] },
    );
    expect(result.label).toBe('priority');
  });

  it('maps labels to canonical provider tags', () => {
    expect(labelToTag('spam')).toBe('GoodVibes/Spam');
    expect(labelToTag('priority')).toBe('GoodVibes/Priority');
    expect(labelToTag('normal')).toBe('GoodVibes/Normal');
  });
});
