/**
 * Integration test for the stall-indicator false positive during tool
 * execution.
 *
 * Mechanism under test (see stream-event-wiring.ts and main.ts):
 *   - metrics.lastDeltaAtMs is set only on STREAM_START/STREAM_DELTA. It is
 *     NOT touched while a tool executes, so "ms since last byte" keeps
 *     growing for the whole duration of a tool call even though the model
 *     isn't producing tokens then, a tool call in progress is not a stall.
 *   - The render call site in main.ts gates UIFactory.computeStallInfo on
 *     `metrics.activeToolName === undefined`, so no stall info is computed at
 *     all while a tool is actively executing, no matter how long
 *     lastDeltaAtMs has sat unrefreshed.
 *   - On tool completion (TOOL_SUCCEEDED/TOOL_FAILED/TOOL_CANCELLED),
 *     lastDeltaAtMs is reset to "now" so the post-tool silence window starts
 *     fresh instead of instantly reading as a multi-second stall the moment
 *     a long-running tool finishes.
 *
 * Unlike the hand-fed-synthetic-values coverage in ui-factory tests (which
 * calls UIFactory.computeStallInfo directly with literal numbers), this test
 * wires the REAL wireStreamEventMetrics against real event buses, so
 * metrics.lastDeltaAtMs / activeToolName are produced by the real event
 * handlers, and then calls the REAL, exported UIFactory.computeRenderStallInfo,
 * the exact same function main.ts's render loop calls at its call site. It
 * exercises the full metrics-production -> gating -> stall-computation path
 * together, which is the path the false positive actually lived in, and a
 * regression to the gate itself (not just to the underlying metrics) will
 * fail this test since it calls the production gate directly rather than a
 * re-implementation of it.
 */

import { describe, test, expect } from 'bun:test';
import { wireStreamEventMetrics } from '../../core/stream-event-wiring.ts';
import type { WireStreamEventMetricsOptions, StreamMetrics } from '../../core/stream-event-wiring.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';

// Mirrors ui-factory.ts's private THINKING_STALL_FREEZE_MS constant.
const THINKING_STALL_FREEZE_MS = 2_500;

// --- Minimal real-shaped event bus: any event name, emit-able, unsubscribable ---

type Listener = (payload?: unknown) => void;

function makeBus() {
  const listeners: Record<string, Listener[]> = {};
  return {
    on(event: string, handler: Listener) {
      (listeners[event] ??= []).push(handler);
      return () => {
        const bucket = listeners[event];
        if (!bucket) return;
        const idx = bucket.indexOf(handler);
        if (idx !== -1) bucket.splice(idx, 1);
      };
    },
    // Real RuntimeEventFeed shape also exposes onEnvelope (raw envelope
    // subscription); wireStreamEventMetrics never uses it, so this is an
    // honest no-op rather than a modeled behavior.
    onEnvelope(_event: string, _handler: Listener) {
      return () => {};
    },
    emit(event: string, payload?: unknown) {
      for (const h of (listeners[event] ?? []).slice()) h(payload);
    },
  };
}

/** An inert RuntimeEventFeed for domains wireStreamEventMetrics never subscribes to (sessions, providers, agents, workflows, planner, ops). */
function makeInertFeed() {
  return {
    on: () => () => {},
    onEnvelope: () => () => {},
  };
}

function makeMetrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0,
    ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}

function makeOptions(turns: ReturnType<typeof makeBus>, tools: ReturnType<typeof makeBus>, metrics: StreamMetrics): WireStreamEventMetricsOptions {
  return {
    events: {
      sessions: makeInertFeed(),
      turns,
      tools,
      providers: makeInertFeed(),
      agents: makeInertFeed(),
      workflows: makeInertFeed(),
      planner: makeInertFeed(),
      ops: makeInertFeed(),
    } as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: {
      getCurrentModel: () => ({ provider: 'anthropic', registryKey: 'anthropic:claude-3-5-sonnet' }),
      setCurrentModel: () => {},
    },
    systemMessageRouter: { high: () => {}, low: () => {} },
    render: () => {},
    metrics,
  };
}

// computeRenderStallInfo below is the REAL production function (defined in
// ui-factory.ts) that main.ts's render loop calls at its stallInfo call
// site, not a re-implementation. Calling it directly here means a
// regression to the gate itself is caught, not just a regression to the
// metrics it consumes.
const computeRenderStallInfo = UIFactory.computeRenderStallInfo.bind(UIFactory);

describe('stall indicator vs. tool execution (integration path)', () => {
  test('tool executing past the stall-freeze threshold does NOT produce stall info', () => {
    const turns = makeBus();
    const tools = makeBus();
    const metrics = makeMetrics();
    wireStreamEventMetrics(makeOptions(turns, tools, metrics));

    let mockNow = 1_000_000;
    const origDateNow = Date.now;
    Date.now = () => mockNow;
    try {
      // Turn starts, a little streaming happens, then the model calls a tool.
      turns.emit('STREAM_START');
      mockNow += 50;
      turns.emit('STREAM_DELTA');

      mockNow += 10;
      tools.emit('TOOL_EXECUTING', { tool: 'Bash', startedAt: mockNow });
      expect(metrics.activeToolName).toBe('Bash');

      // Advance well past the stall-freeze threshold while the tool is STILL
      // running (e.g. a slow shell command). Without the fix, this is exactly
      // the false-positive window: lastDeltaAtMs hasn't moved since the last
      // delta, so naively computing stall info here would report a multi
      // -second stall directly above the ticking "executing (Ns)" tool row.
      mockNow += THINKING_STALL_FREEZE_MS + 5_000; // 7.55s since last delta, tool still active
      const stallInfoDuringTool = computeRenderStallInfo(metrics, mockNow);
      expect(stallInfoDuringTool).toBeUndefined();

      // Tool completes, lastDeltaAtMs must reset to "now" so the post-tool
      // silence window starts fresh instead of instantly reading as a
      // multi-second stall the moment the tool finishes.
      tools.emit('TOOL_SUCCEEDED');
      expect(metrics.activeToolName).toBeUndefined();
      const stallInfoRightAfterTool = computeRenderStallInfo(metrics, mockNow);
      expect(stallInfoRightAfterTool).toBeDefined();
      expect(stallInfoRightAfterTool!.msSinceLastDelta).toBeLessThan(THINKING_STALL_FREEZE_MS);
    } finally {
      Date.now = origDateNow;
    }
  });

  test('tool executing past the stall-freeze threshold via TOOL_FAILED / TOOL_CANCELLED also resets the clock', () => {
    for (const completionEvent of ['TOOL_FAILED', 'TOOL_CANCELLED']) {
      const turns = makeBus();
      const tools = makeBus();
      const metrics = makeMetrics();
      wireStreamEventMetrics(makeOptions(turns, tools, metrics));

      let mockNow = 5_000_000;
      const origDateNow = Date.now;
      Date.now = () => mockNow;
      try {
        turns.emit('STREAM_START');
        mockNow += THINKING_STALL_FREEZE_MS + 3_000;
        tools.emit('TOOL_EXECUTING', { tool: 'Grep', startedAt: mockNow });

        mockNow += THINKING_STALL_FREEZE_MS + 3_000;
        expect(computeRenderStallInfo(metrics, mockNow)).toBeUndefined();

        tools.emit(completionEvent);
        const stallInfoAfter = computeRenderStallInfo(metrics, mockNow);
        expect(stallInfoAfter).toBeDefined();
        expect(stallInfoAfter!.msSinceLastDelta).toBeLessThan(THINKING_STALL_FREEZE_MS);
      } finally {
        Date.now = origDateNow;
      }
    }
  });

  test('genuine no-delta stream stall with no tool active still stall-detects (pre-first-token case included)', () => {
    const turns = makeBus();
    const tools = makeBus();
    const metrics = makeMetrics();
    wireStreamEventMetrics(makeOptions(turns, tools, metrics));

    let mockNow = 2_000_000;
    const origDateNow = Date.now;
    Date.now = () => mockNow;
    try {
      // Turn starts; the provider goes silent before the first token and no
      // tool ever runs (the honest stall case the wave added, must NOT be
      // suppressed).
      turns.emit('STREAM_START');
      mockNow += THINKING_STALL_FREEZE_MS + 1_000; // 3.5s of silence, no delta, no tool

      const stallInfo = computeRenderStallInfo(metrics, mockNow);
      expect(stallInfo).toBeDefined();
      expect(stallInfo!.msSinceLastDelta).toBeGreaterThanOrEqual(THINKING_STALL_FREEZE_MS);
    } finally {
      Date.now = origDateNow;
    }
  });

  test('genuine no-delta stream stall mid-stream (after some deltas, then silence) with no tool active still stall-detects', () => {
    const turns = makeBus();
    const tools = makeBus();
    const metrics = makeMetrics();
    wireStreamEventMetrics(makeOptions(turns, tools, metrics));

    let mockNow = 3_000_000;
    const origDateNow = Date.now;
    Date.now = () => mockNow;
    try {
      turns.emit('STREAM_START');
      mockNow += 100;
      turns.emit('STREAM_DELTA');

      // Provider goes silent mid-stream, no tool call involved.
      mockNow += THINKING_STALL_FREEZE_MS + 200;
      const stallInfo = computeRenderStallInfo(metrics, mockNow);
      expect(stallInfo).toBeDefined();
      expect(stallInfo!.msSinceLastDelta).toBeGreaterThanOrEqual(THINKING_STALL_FREEZE_MS);
    } finally {
      Date.now = origDateNow;
    }
  });
});
