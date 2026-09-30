/**
 * hosted-session-view.test.ts, what a person actually sees while a
 * conversation runs in the daemon (the Agents modal's Hosted row and its
 * full-height view).
 *
 * Two things are protected here. The FEED's fold rules: history backfills,
 * streamed text grows one row rather than one row per delta, a tool call
 * settles into its outcome, and the buffer is bounded with an honest count of
 * what it dropped. And the VIEW's honesty: `effectiveDetachPolicy` is rendered
 * from the record, an absent stream says why rather than showing a still
 * conversation that reads as finished, and a terminated session shows the
 * reason it ended.
 */
import { describe, test, expect } from 'bun:test';
import {
  HostedSessionFeed,
  MAX_HOSTED_ROWS,
  getSharedHostedSessionFeed,
  resetSharedHostedSessionFeed,
} from '../../views/hosted-session-feed.ts';
import { hostedBody, hostedHeaderTexts } from '../../input/agents-modal-text.ts';
import type { HostedSessionRecord } from '@pellux/goodvibes-sdk/platform/hosted-sessions';
import type { HostedSessionStreamEvent } from '../../runtime/client/hosted-session-stream.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

function makeRecord(overrides: Partial<HostedSessionRecord> = {}): HostedSessionRecord {
  return {
    id: 'hosted-1',
    workspaceRoot: '/tmp/workspace',
    title: 'the hosted one',
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'kill',
    attachedClients: ['tui-host-1'],
    createdAt: 1,
    updatedAt: 2,
    turnCount: 1,
    messageCount: 2,
    restoredFromDisk: false,
    ...overrides,
  };
}

function turnEvent(type: string, payload: Record<string, unknown>): HostedSessionStreamEvent {
  return { domain: 'turn', type, sessionId: 'hosted-1', at: 100, payload };
}

function toolEvent(type: string, payload: Record<string, unknown>): HostedSessionStreamEvent {
  return { domain: 'tools', type, sessionId: 'hosted-1', at: 100, payload };
}

/** Flatten a rendered frame to plain text so assertions read like the screen. */
function frameText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell?.char ?? ' ').join('')).join('\n');
}

describe('hosted session feed', () => {
  test('attach backfills the transcript the daemon handed back', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), [
      { role: 'user', content: 'read the note', at: 1 },
      { role: 'assistant', content: 'the note says hello', at: 2 },
    ]);

    expect(feed.getState().rows.map((row) => row.kind)).toEqual(['user', 'assistant']);
    expect(feed.getState().rows[1]!.text).toBe('the note says hello');
    expect(feed.isAttached()).toBe(true);
  });

  test('streamed text grows ONE row, and the turn settles it', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);

    feed.apply(turnEvent('STREAM_DELTA', { content: 'he', accumulated: 'he' }));
    feed.apply(turnEvent('STREAM_DELTA', { content: 'llo', accumulated: 'hello' }));

    expect(feed.getState().rows).toHaveLength(1);
    expect(feed.getState().rows[0]!.text).toBe('hello');
    expect(feed.getState().rows[0]!.streaming).toBe(true);

    feed.apply(turnEvent('TURN_COMPLETED', { response: 'hello there' }));
    expect(feed.getState().rows).toHaveLength(1);
    expect(feed.getState().rows[0]!.text).toBe('hello there');
    expect(feed.getState().rows[0]!.streaming).toBe(false);
  });

  test('a tool call is a running row that settles into its own outcome', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);

    feed.apply(toolEvent('TOOL_EXECUTING', { callId: 'call-1', tool: 'read' }));
    expect(feed.getState().runningToolCalls).toEqual([{ callId: 'call-1', tool: 'read', startedAt: 100 }]);
    expect(feed.getState().rows[0]!.streaming).toBe(true);

    feed.apply(toolEvent('TOOL_FAILED', { callId: 'call-1', tool: 'read', error: 'no such file' }));
    expect(feed.getState().runningToolCalls).toEqual([]);
    expect(feed.getState().rows[0]!.text).toBe('read: failed: no such file');
    expect(feed.getState().rows[0]!.streaming).toBe(false);
  });

  test('a frame for another session is ignored rather than rendered as this one\'s', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);
    feed.apply({ ...turnEvent('STREAM_DELTA', { accumulated: 'not mine' }), sessionId: 'hosted-other' });
    expect(feed.getState().rows).toEqual([]);
  });

  test('the buffer is bounded and says how much it dropped', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);
    for (let index = 0; index < MAX_HOSTED_ROWS + 5; index += 1) {
      feed.apply(turnEvent('TURN_SUBMITTED', { prompt: `prompt ${index}` }));
    }
    expect(feed.getState().rows).toHaveLength(MAX_HOSTED_ROWS);
    expect(feed.getState().droppedRows).toBe(5);
  });

  test('a termination notice updates the record and states the reason', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);
    feed.applyLifecycle({
      event: 'hosted-session-terminated',
      session: makeRecord({ status: 'terminated', terminatedReason: 'detached' }),
    });
    expect(feed.getState().record!.status).toBe('terminated');
    expect(feed.isAttached()).toBe(false);
    expect(feed.getState().rows.at(-1)!.text).toContain('detached');
  });

  test('the shared feed is one instance, and resets between tests', () => {
    resetSharedHostedSessionFeed();
    const first = getSharedHostedSessionFeed();
    expect(getSharedHostedSessionFeed()).toBe(first);
    resetSharedHostedSessionFeed();
    expect(getSharedHostedSessionFeed()).not.toBe(first);
  });
});

describe('hosted session view (Agents modal)', () => {
  const headerText = (feed: HostedSessionFeed): string => hostedHeaderTexts(feed.getState()).map((l) => l.text).join('\n');

  test('unattached, the header claims nothing', () => {
    expect(hostedHeaderTexts(new HostedSessionFeed().getState())).toEqual([]);
  });

  test('the header renders the record\'s own detach policy and where it came from', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), [{ role: 'user', content: 'read the note' }]);
    expect(headerText(feed)).toContain('leaving ends it (kill)');
    expect(headerText(feed)).toContain('from the setting');
    expect(frameText(hostedBody(feed.getState().rows, 90, 24))).toContain('read the note');
  });

  test('a per-session survive override renders as an override, not as the setting', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord({ detachPolicy: 'survive', effectiveDetachPolicy: 'survive' }), []);
    expect(headerText(feed)).toContain('leaving keeps it running (survive)');
    expect(headerText(feed)).toContain('set for this session');
  });

  test('no live stream says WHY, so a still conversation never reads as a finished one', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);
    feed.setStreaming(false, 'the daemon would not open an event stream');
    expect(headerText(feed)).toContain('no live stream');
    expect(headerText(feed)).toContain('would not open an event stream');
  });

  test('a terminated session shows the reason it ended', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord({ status: 'terminated', terminatedReason: 'killed' }), []);
    expect(headerText(feed)).toContain('ended: killed');
  });

  test('the transcript body is bounded to the requested height and never wider than the width', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), Array.from({ length: 30 }, (_, index) => ({
      role: 'assistant' as const, content: `line ${index} of a long hosted transcript`,
    })));
    for (const [width, height] of [[40, 12], [120, 30]] as const) {
      const lines = hostedBody(feed.getState().rows, width, height);
      expect(lines.length).toBeLessThanOrEqual(height);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
    // Newest rows are kept.
    expect(frameText(hostedBody(feed.getState().rows, 120, 3))).toContain('line 29');
  });
});
