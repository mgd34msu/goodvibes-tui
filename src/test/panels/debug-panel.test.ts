import { describe, expect, test } from 'bun:test';
import { DebugPanel } from '../../panels/debug-panel.ts';
import type { ApiCallEntry } from '../../panels/debug-panel.ts';

const EMPTY_TURN_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as ConstructorParameters<typeof DebugPanel>[0];

function pushCall(panel: DebugPanel, entry: Partial<ApiCallEntry>): void {
  const full: ApiCallEntry = {
    ts: Date.now() - 1000,
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    inputTokens: 1200,
    outputTokens: 340,
    latencyMs: 850,
    statusCode: 200,
    status: 'ok',
    ...entry,
  };
  // Exercise the internal call buffer via the private push helper.
  (panel as unknown as { _pushCall(e: ApiCallEntry): void })._pushCall(full);
  if (full.status === 'error') {
    (panel as unknown as { _pushError(e: ApiCallEntry): void })._pushError(full);
  }
}

function textOf(panel: DebugPanel, w = 90, h = 24): string {
  return panel.render(w, h).flat().map((c) => c.char).join('');
}

describe('DebugPanel', () => {
  test('empty state guides the operator', () => {
    const panel = new DebugPanel(EMPTY_TURN_EVENT_FEED);
    const text = textOf(panel);
    expect(text).toContain('API Debug');
    expect(text).toContain('No calls yet');
  });

  test('summary surfaces live diagnostics: calls, avg latency, tokens, last call', () => {
    const panel = new DebugPanel(EMPTY_TURN_EVENT_FEED);
    pushCall(panel, { latencyMs: 800, model: 'claude-opus-4-8' });
    const text = textOf(panel);
    expect(text).toContain('Calls');
    expect(text).toContain('Avg latency');
    expect(text).toContain('Tokens');
    expect(text).toContain('Last');
    expect(text).toContain('claude-opus-4-8');
  });

  test('latest error is surfaced in the footer', () => {
    const panel = new DebugPanel(EMPTY_TURN_EVENT_FEED);
    pushCall(panel, { status: 'error', statusCode: 429, errorMessage: 'rate limit exceeded' });
    const text = textOf(panel);
    expect(text).toContain('latest error');
    expect(text).toContain('rate limit exceeded');
  });

  test('every rendered line matches the requested width', () => {
    const panel = new DebugPanel(EMPTY_TURN_EVENT_FEED);
    pushCall(panel, {});
    for (const line of panel.render(90, 24)) expect(line.length).toBe(90);
  });
});
