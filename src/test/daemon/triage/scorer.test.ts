import { describe, expect, test } from 'bun:test';
import { labelToTag, scoreInboundItem } from '../../../daemon/triage/scorer.ts';
import type { InboundChannelItem } from '../../../daemon/operator/index.ts';

function item(partial: Partial<InboundChannelItem>): InboundChannelItem {
  return {
    id: partial.id ?? 'i-1',
    surface: partial.surface ?? 'email',
    fromDigest: partial.fromDigest ?? 'abc',
    messageDigest: partial.messageDigest ?? 'def',
    receivedAt: partial.receivedAt ?? '2026-06-20T00:00:00.000Z',
    unread: partial.unread ?? true,
    ...partial,
  };
}

describe('scoreInboundItem', () => {
  test('flags an obvious spam message with high confidence', () => {
    const result = scoreInboundItem(
      item({
        subject: 'CONGRATULATIONS!! You are a WINNER of our LOTTERY',
        snippet:
          'Claim your FREE prize money now! Guaranteed cash, risk-free bitcoin investment. Click http://x.example http://y.example',
      }),
    );
    expect(result.label).toBe('spam');
    expect(result.score).toBeGreaterThanOrEqual(0.65);
    expect(result.signals.spam).toBeGreaterThan(result.signals.priority);
  });

  test('flags an urgent direct message as priority', () => {
    const result = scoreInboundItem(
      item({
        surface: 'slack',
        conversationKind: 'direct',
        subject: 'URGENT: action required before deadline',
        snippet: 'This is critical and overdue, please respond ASAP today.',
      }),
    );
    expect(result.label).toBe('priority');
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  test('treats a plain conversational message as normal', () => {
    const result = scoreInboundItem(
      item({
        subject: 'Lunch tomorrow?',
        snippet: 'Hey, want to grab lunch sometime next week? No rush.',
        conversationKind: 'group',
      }),
    );
    expect(result.label).toBe('normal');
    expect(result.signals.spam).toBeLessThan(0.65);
    expect(result.signals.priority).toBeLessThan(0.6);
  });

  test('empty text is normal, not spam', () => {
    const result = scoreInboundItem(item({ subject: '', snippet: '' }));
    expect(result.label).toBe('normal');
    expect(result.signals.spam).toBeLessThan(0.5);
  });

  test('is deterministic across repeated calls', () => {
    const probe = item({ subject: 'Invoice payment due', snippet: 'Please approve the invoice.' });
    const a = scoreInboundItem(probe);
    const b = scoreInboundItem(probe);
    expect(a).toEqual(b);
  });

  test('score is always within 0..1 and rounded to 2 decimals', () => {
    const samples = [
      item({ subject: 'free crypto casino', snippet: 'win cash now!!!' }),
      item({ subject: 'meeting notes', snippet: 'attached are the notes' }),
      item({ subject: 'URGENT URGENT URGENT', snippet: 'EMERGENCY ESCALATION' }),
    ];
    for (const s of samples) {
      const r = scoreInboundItem(s);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(Math.round(r.score * 100) / 100).toBe(r.score);
    }
  });

  test('custom thresholds override defaults', () => {
    const borderline = item({ subject: 'special offer discount', snippet: 'limited time' });
    const strict = scoreInboundItem(borderline, { spamThreshold: 0.99 });
    expect(strict.label).not.toBe('spam');
    const loose = scoreInboundItem(borderline, { spamThreshold: 0.01 });
    expect(loose.label).toBe('spam');
  });

  test('extra spam terms push toward spam', () => {
    const probe = item({ subject: 'zorptastic deal', snippet: 'zorptastic zorptastic zorptastic' });
    const baseline = scoreInboundItem(probe);
    const withTerm = scoreInboundItem(probe, { extraSpamTerms: ['zorptastic'], spamThreshold: 0.5 });
    expect(withTerm.signals.spam).toBeGreaterThan(baseline.signals.spam);
  });

  test('labelToTag maps every label', () => {
    expect(labelToTag('spam')).toBe('GoodVibes/Spam');
    expect(labelToTag('priority')).toBe('GoodVibes/Priority');
    expect(labelToTag('normal')).toBe('GoodVibes/Normal');
  });
});
