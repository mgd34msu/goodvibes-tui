/**
 * hosted-sessions-client.test.ts, the terminal's half of the hosted-session
 * contract: what it sends, what it does with what comes back, and what it does
 * when the daemon will not answer.
 *
 * Everything here is asserted against a recorded verb caller rather than a live
 * daemon, the live proof is the adopt e2e, which drives the real binary. What
 * this file protects is the wire shape (verb ids, required fields, the clientId
 * this terminal attaches under) and the honesty rules: a refused stream is a
 * value, an unread roster is not an empty one, and the detach sentence comes
 * from the record rather than from a local guess.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createHostedSessionsClient,
  describeDetachEffect,
  hostedSessionLabel,
  terminalHostedClientId,
  type HostedSessionRecord,
} from '../../runtime/client/hosted-sessions.ts';
import {
  HostedSessionRoster,
  resetSharedHostedSessionRoster,
  getSharedHostedSessionRoster,
} from '../../runtime/client/hosted-roster.ts';
import {
  hostedSessionStreamUrl,
  readHostedLifecycleNotice,
  readHostedStreamEnvelope,
  watchHostedSession,
} from '../../runtime/client/hosted-session-stream.ts';
import type { DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

function makeRecord(overrides: Partial<HostedSessionRecord> = {}): HostedSessionRecord {
  return {
    id: 'hosted-1',
    workspaceRoot: '/tmp/workspace',
    title: 'a hosted conversation',
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'kill',
    attachedClients: [],
    createdAt: 1,
    updatedAt: 2,
    turnCount: 0,
    messageCount: 0,
    restoredFromDisk: false,
    ...overrides,
  };
}

interface RecordedCall { readonly methodId: string; readonly input: unknown }

function recordingVerbs(answers: Record<string, unknown>, calls: RecordedCall[]): DaemonVerbCaller {
  return {
    probe: () => ({ available: true, sdk: {} as never }),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      calls.push({ methodId, input });
      if (!(methodId in answers)) throw new Error(`no recorded answer for ${methodId}`);
      return answers[methodId] as T;
    },
  };
}

describe('hosted sessions client', () => {
  test('create sends the workspace root, this terminal\'s client id, and nothing it was not given', async () => {
    const calls: RecordedCall[] = [];
    const client = createHostedSessionsClient(recordingVerbs({
      'sessions.hosted.create': { session: makeRecord() },
    }, calls));

    await client.create({ workspaceRoot: '/tmp/workspace' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.methodId).toBe('sessions.hosted.create');
    const input = calls[0]!.input as Record<string, unknown>;
    expect(input['workspaceRoot']).toBe('/tmp/workspace');
    expect(input['clientId']).toBe(terminalHostedClientId());
    // A present-but-undefined key is not the same as an absent one on the wire:
    // the gateway validates against the declared schema and would refuse it.
    expect(Object.keys(input).sort()).toEqual(['clientId', 'workspaceRoot']);
  });

  test('a per-session detach override is sent verbatim when one was asked for', async () => {
    const calls: RecordedCall[] = [];
    const client = createHostedSessionsClient(recordingVerbs({
      'sessions.hosted.create': { session: makeRecord({ detachPolicy: 'survive', effectiveDetachPolicy: 'survive' }) },
    }, calls));

    const record = await client.create({ workspaceRoot: '/w', detachPolicy: 'survive', title: 'kept' });

    const input = calls[0]!.input as Record<string, unknown>;
    expect(input['detachPolicy']).toBe('survive');
    expect(input['title']).toBe('kept');
    expect(record.effectiveDetachPolicy).toBe('survive');
  });

  test('steer, follow-up and tool-cancel use the ORDINARY session verbs, not a hosted spelling', async () => {
    const calls: RecordedCall[] = [];
    const client = createHostedSessionsClient(recordingVerbs({
      'sessions.steer': {},
      'sessions.followUp': {},
      'sessions.toolCalls.cancel': { cancelled: true },
    }, calls));

    await client.steer('hosted-1', 'go');
    await client.followUp('hosted-1', 'later');
    const cancelled = await client.cancelToolCall('hosted-1', 'call-7');

    expect(calls.map((call) => call.methodId)).toEqual([
      'sessions.steer', 'sessions.followUp', 'sessions.toolCalls.cancel',
    ]);
    expect(calls[0]!.input).toMatchObject({ sessionId: 'hosted-1', body: 'go' });
    expect(calls[2]!.input).toMatchObject({ sessionId: 'hosted-1', callId: 'call-7' });
    expect(cancelled).toBe(true);
  });

  test('attach returns the backfilled transcript, and an absent history is an empty one, never a throw', async () => {
    const calls: RecordedCall[] = [];
    const client = createHostedSessionsClient(recordingVerbs({
      'sessions.hosted.attach': { session: makeRecord() },
    }, calls));

    const attachment = await client.attach('hosted-1');

    expect(attachment.history).toEqual([]);
    expect(calls[0]!.input).toMatchObject({ sessionId: 'hosted-1', clientId: terminalHostedClientId() });
  });

  test('the detach sentence names the record\'s policy AND where the policy came from', () => {
    expect(describeDetachEffect(makeRecord())).toBe(
      'leaving ends it (kill, from the hostedSessions.detachPolicy setting)',
    );
    expect(describeDetachEffect(makeRecord({ detachPolicy: 'survive', effectiveDetachPolicy: 'survive' }))).toBe(
      "leaving keeps it running (survive, from this session's own override)",
    );
  });

  test('a record with no title falls back to its id rather than inventing one', () => {
    expect(hostedSessionLabel(makeRecord({ title: '   ' }))).toBe('hosted-1');
  });
});

describe('hosted session roster', () => {
  beforeEach(() => { resetSharedHostedSessionRoster(); });

  test('never-read and hosting-nothing are different facts', async () => {
    const roster = new HostedSessionRoster();
    expect(roster.snapshot().capturedAt).toBeNull();
    expect(roster.snapshot().note).toBeNull();

    const calls: RecordedCall[] = [];
    roster.bindClient(createHostedSessionsClient(recordingVerbs({ 'sessions.hosted.list': { sessions: [] } }, calls)));
    await roster.refresh();

    expect(roster.snapshot().capturedAt).not.toBeNull();
    expect(roster.snapshot().sessions).toEqual([]);
    expect(roster.snapshot().note).toBeNull();
  });

  test('a refused refresh keeps the last known rows and records the reason', async () => {
    const roster = new HostedSessionRoster();
    roster.accept([makeRecord()]);
    roster.bindClient({
      clientId: 'x',
      list: async () => { throw new Error('daemon is down'); },
    } as never);

    await roster.refresh();

    expect(roster.snapshot().sessions).toHaveLength(1);
    expect(roster.snapshot().note).toContain('daemon is down');
  });

  test('with no client bound it says so instead of claiming an empty daemon', async () => {
    const roster = new HostedSessionRoster();
    await roster.refresh();
    expect(roster.snapshot().capturedAt).toBeNull();
    expect(roster.snapshot().note).toContain('no daemon client is wired');
  });

  test('the shared roster is one instance so the picker and the command agree', () => {
    expect(getSharedHostedSessionRoster()).toBe(getSharedHostedSessionRoster());
  });
});

describe('hosted session stream', () => {
  test('the subscription narrows to the three domains a hosted session speaks on', () => {
    const url = new URL(hostedSessionStreamUrl('http://127.0.0.1:3421'));
    expect(url.pathname).toBe('/api/control-plane/events');
    expect(url.searchParams.get('domains')).toBe('turn,tools,session');
  });

  test('a serialized runtime envelope is read with its session stamp; anything else is discarded', () => {
    expect(readHostedStreamEnvelope('turn', {
      type: 'STREAM_DELTA', ts: 5, sessionId: 'hosted-1', payload: { accumulated: 'hi' },
    })).toEqual({ domain: 'turn', type: 'STREAM_DELTA', sessionId: 'hosted-1', at: 5, payload: { accumulated: 'hi' } });
    // No session stamp means nothing can be filtered on it, dropping it is the
    // only honest answer, since rendering it would attribute another
    // conversation's tokens to this one.
    expect(readHostedStreamEnvelope('turn', { type: 'STREAM_DELTA', payload: {} })).toBeNull();
    expect(readHostedStreamEnvelope('tools', 'not an object')).toBeNull();
  });

  test('a lifecycle notice is recognised only with an event name and a session record', () => {
    expect(readHostedLifecycleNotice({
      event: 'hosted-session-terminated', session: { id: 'hosted-1' }, createdAt: 1,
    })).not.toBeNull();
    expect(readHostedLifecycleNotice({ event: 'hosted-session-terminated' })).toBeNull();
    expect(readHostedLifecycleNotice(null)).toBeNull();
  });

  test('frames for another session never reach the subscriber', async () => {
    const seen: string[] = [];
    // Drive the reader + the same id guard `watchHostedSession` applies, rather
    // than standing up an HTTP server for what is a pure predicate.
    const deliver = (payload: unknown): void => {
      const event = readHostedStreamEnvelope('turn', payload);
      if (event && event.sessionId === 'hosted-1') seen.push(event.type);
    };
    deliver({ type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: {} });
    deliver({ type: 'STREAM_DELTA', sessionId: 'hosted-other', payload: {} });
    expect(seen).toEqual(['STREAM_DELTA']);

    const fetchImpl = (async () => {
      throw new Error('nothing is listening on this port');
    }) as unknown as typeof fetch;

    // And a stream that cannot be opened is null, not a throw: an approval or a
    // steer must still reach the session over its verbs.
    const subscription = await watchHostedSession({
      baseUrl: 'http://127.0.0.1:1',
      sessionId: 'hosted-1',
      onEvent: () => {},
      fetchImpl,
    });
    expect(subscription).toBeNull();
  });
});
