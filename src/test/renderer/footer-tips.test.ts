import { describe, test, expect } from 'bun:test';
import { buildFooterTip, isAgentActive } from '../../renderer/footer-tips.ts';

describe('footer-tips', () => {
  test('default tip leads with panels; F2 names the Fleet panel and quit advertises the double-press honestly', () => {
    // W6.2 e: F2 opens Fleet (not the retired process modal). W6.2 f: an empty
    // composer needs Ctrl+C TWICE within ~1s to exit, so the tip says "x2".
    expect(buildFooterTip({ agentActive: false }))
      .toBe('Ctrl+P panels · F2 fleet · ? help · Ctrl+C x2 quit');
  });

  test('agent-active tip promotes the Fleet panel jump to the front', () => {
    expect(buildFooterTip({ agentActive: true }))
      .toBe('F2 fleet · Ctrl+P panels · ? help · Ctrl+C x2 quit');
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
