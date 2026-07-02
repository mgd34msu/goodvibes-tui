import { describe, test, expect } from 'bun:test';
import { buildFooterTip, isAgentActive } from '../../renderer/footer-tips.ts';

describe('footer-tips', () => {
  test('default tip leads with panels, keeps quit discoverable', () => {
    expect(buildFooterTip({ agentActive: false }))
      .toBe('Ctrl+P panels · F2 processes · ? help · Ctrl+C quit');
  });

  test('agent-active tip promotes the process monitor to the front', () => {
    expect(buildFooterTip({ agentActive: true }))
      .toBe('F2 processes · Ctrl+P panels · ? help · Ctrl+C quit');
  });

  test('isAgentActive recognizes in-flight turn statuses', () => {
    for (const s of ['preflight', 'streaming', 'tools', 'post-hooks']) {
      expect(isAgentActive(s)).toBe(true);
    }
  });

  test('isAgentActive is false for idle/terminal statuses and undefined', () => {
    for (const s of ['idle', 'completed', 'failed', 'cancelled']) {
      expect(isAgentActive(s)).toBe(false);
    }
    expect(isAgentActive(undefined)).toBe(false);
  });
});
