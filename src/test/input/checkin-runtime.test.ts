import { describe, expect, test } from 'bun:test';
import { renderConfig, renderReceipt } from '@/input/commands/checkin-runtime.ts';

describe('renderConfig', () => {
  test('renders an enabled config', () => {
    const text = renderConfig({
      enabled: true,
      cadence: '0 */4 * * *',
      deliveryChannel: 'slack:C123',
      quietHours: '22:00-07:00',
    });
    expect(text).toContain('enabled:         yes');
    expect(text).toContain('0 */4 * * *');
    expect(text).toContain('slack:C123');
    expect(text).toContain('22:00-07:00');
  });

  test('renders the off-by-default config honestly', () => {
    const text = renderConfig({ enabled: false, cadence: '', deliveryChannel: '', quietHours: '' });
    expect(text).toContain('enabled:         no');
    expect(text).toContain('(not set)');
    expect(text).toContain('(none)');
  });
});

describe('renderReceipt', () => {
  test('renders a delivered receipt with all optional fields', () => {
    const text = renderReceipt({
      id: 'r1',
      ranAt: 0,
      trigger: 'scheduled',
      outcome: 'delivered',
      briefingSummary: 'nothing urgent, one PR needs review',
      decisionReason: 'a PR has been waiting 2 days',
      deliveredMessage: 'Heads up: PR #42 needs review',
      deliveryChannel: 'slack:C123',
      deliveryId: 'd1',
    });
    expect(text).toContain('[scheduled]');
    expect(text).toContain('delivered');
    expect(text).toContain('nothing urgent, one PR needs review');
    expect(text).toContain('reason: a PR has been waiting 2 days');
    expect(text).toContain('delivered: Heads up: PR #42 needs review');
    expect(text).toContain('channel: slack:C123');
  });

  test('renders a quiet receipt with only required fields', () => {
    const text = renderReceipt({
      id: 'r2',
      ranAt: 0,
      trigger: 'manual',
      outcome: 'quiet',
      briefingSummary: 'nothing worth mentioning',
    });
    expect(text).toContain('[manual]');
    expect(text).toContain('quiet');
    expect(text).not.toContain('reason:');
    expect(text).not.toContain('delivered:');
  });

  test('renders an error receipt', () => {
    const text = renderReceipt({
      id: 'r3',
      ranAt: 0,
      trigger: 'scheduled',
      outcome: 'error',
      briefingSummary: 'briefing assembly failed',
      error: 'timed out contacting the provider',
    });
    expect(text).toContain('error: timed out contacting the provider');
  });
});
