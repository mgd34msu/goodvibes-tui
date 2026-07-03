import { beforeEach, describe, expect, test } from 'bun:test';
import { createEventEnvelope, type RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { ThinkingPanel } from '../../../panels/thinking-panel.ts';
import { createRuntimeBusStub, flushMicrotasks, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('ThinkingPanel renders shared workspace empty state cleanly', async () => {
    const panel = new ThinkingPanel(createUiRuntimeEvents(runtimeBus).turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Thinking');
    expect(linesText(lines)).toContain('No reasoning content yet');
  });

  test('ThinkingPanel keeps ingesting stream events while deactivated', async () => {
    const panel = new ThinkingPanel(createUiRuntimeEvents(runtimeBus).turns);
    panel.onActivate();
    panel.onDeactivate();
    runtimeBus.emit(
      'turn',
      createEventEnvelope('STREAM_START', { type: 'STREAM_START', turnId: 'turn-1' }, {
        sessionId: 'sess-1',
        source: 'test',
        turnId: 'turn-1',
      }),
    );
    runtimeBus.emit(
      'turn',
      createEventEnvelope(
        'STREAM_DELTA',
        { type: 'STREAM_DELTA', turnId: 'turn-1', content: '', accumulated: '', reasoning: 'reasoning after blur' },
        {
          sessionId: 'sess-1',
          source: 'test',
          turnId: 'turn-1',
        },
      ),
    );
    await flushMicrotasks();
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('reasoning after blur');
  });

  // ---------------------------------------------------------------------------
  // WO-141: real turn/correlation ids from TURN_*/STREAM_* envelopes + block timestamps
  // ---------------------------------------------------------------------------

  test('block header/detail stamp the real turnId and traceId from the event envelope', async () => {
    const panel = new ThinkingPanel(createUiRuntimeEvents(runtimeBus).turns);
    panel.onActivate();
    runtimeBus.emit(
      'turn',
      createEventEnvelope('STREAM_START', { type: 'STREAM_START', turnId: 'turn-xyz' }, {
        sessionId: 'sess-1',
        source: 'test',
        turnId: 'turn-xyz',
        traceId: 'trace-abc',
      }),
    );
    runtimeBus.emit(
      'turn',
      createEventEnvelope(
        'STREAM_DELTA',
        { type: 'STREAM_DELTA', turnId: 'turn-xyz', content: '', accumulated: '', reasoning: 'stamped block' },
        { sessionId: 'sess-1', source: 'test', turnId: 'turn-xyz', traceId: 'trace-abc' },
      ),
    );
    await flushMicrotasks();
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('turn-xyz');
    expect(text).toContain('trace-abc');
    // Real timestamp stamped instead of a bare incrementing counter — an
    // HH:MM:SS clock string appears in the block header.
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
