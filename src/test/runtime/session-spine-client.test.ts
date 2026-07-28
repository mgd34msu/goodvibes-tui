import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegisterSharedSessionInput, SharedSessionRecord, SharedSessionRegisterResult } from '@pellux/goodvibes-sdk/platform/control-plane';
import { foldLegacySpineStore, SessionSpineClient, TUI_SPINE_PARTICIPANT } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { createTuiSpineTransport, type SpineSessionsClient } from '../../runtime/session-spine-transport.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

/**
 * Poll until `predicate` holds, then return.
 *
 * Replaces "sleep a fixed 70 ms and then assert a keepalive beat has landed".
 * The keepalive's own cadence is 15 ms here, so on an idle machine 70 ms is
 * four beats of headroom — but the beat has to travel through the transport and
 * be recorded, and how long that takes on a machine running dozens of other
 * test processes is not something a fixed sleep can know. The poll returns on
 * the first beat, so a fast host is no slower than before, and the ceiling is
 * large enough that only a keepalive that never fires at all fails it.
 */
async function waitUntil(predicate: () => boolean, what: string, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: ${what} never became true — waited ${budgetMs}ms`);
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

interface CapturedCall {
  readonly kind: 'register' | 'close';
  readonly sessionId: string;
  readonly input?: RegisterSharedSessionInput;
}

function makeSessionRecord(id: string, overrides: Partial<SharedSessionRecord> = {}): SharedSessionRecord {
  return {
    id,
    kind: 'tui',
    project: '/p',
    title: '',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: [],
    participants: [],
    metadata: {},
    ...overrides,
  };
}

/** A controllable fake SpineSessionsClient — resolves/rejects on command. */
function makeFakeSessionsClient(): {
  readonly client: SpineSessionsClient;
  readonly calls: CapturedCall[];
  mode: 'succeed' | 'fail' | 'pending';
  pendingResolvers: Array<() => void>;
} {
  const calls: CapturedCall[] = [];
  const state: { mode: 'succeed' | 'fail' | 'pending'; pendingResolvers: Array<() => void> } = {
    mode: 'succeed',
    pendingResolvers: [],
  };
  const client: SpineSessionsClient = {
    register: (input) => {
      calls.push({ kind: 'register', sessionId: input.sessionId, input });
      if (state.mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      if (state.mode === 'pending') {
        return new Promise<SharedSessionRegisterResult>((resolve) => {
          state.pendingResolvers.push(() => resolve({ record: makeSessionRecord(input.sessionId), reopened: input.reopen === true }));
        });
      }
      return Promise.resolve({ record: makeSessionRecord(input.sessionId), reopened: input.reopen === true });
    },
    close: (sessionId) => {
      calls.push({ kind: 'close', sessionId });
      if (state.mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(makeSessionRecord(sessionId, { status: 'closed' }));
    },
  };
  return { client, calls, get mode() { return state.mode; }, set mode(v) { state.mode = v; }, pendingResolvers: state.pendingResolvers };
}

describe('SessionSpineClient dormant-until-activated', () => {
  test('register/reopen/heartbeat/close before activate() are all synchronous no-throw no-ops queued for later', () => {
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    expect(client.active).toBe(false);
    expect(() => client.register({ sessionId: 's1', project: '/p', title: 'T' })).not.toThrow();
    expect(() => client.reopen({ sessionId: 's2', project: '/p' })).not.toThrow();
    expect(() => client.heartbeat('s1')).not.toThrow();
    expect(() => client.close('s1')).not.toThrow();
    expect(client.status()).toBe('unknown');
    // register (s1), reopen (s2) queued; close(s1) removes s1's cached heartbeat
    // record but still enqueues its own close op — both survive as queued ops.
    expect(client.pendingOps).toBeGreaterThan(0);
    client.dispose();
  });

  test('activate() flushes everything queued while dormant, exactly once each', async () => {
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.register({ sessionId: 's1', project: '/p', title: 'T' });
    client.close('s1');
    expect(client.pendingOps).toBe(2);

    client.activate(createTuiSpineTransport(fake.client));
    await settle();

    expect(client.active).toBe(true);
    expect(client.pendingOps).toBe(0);
    expect(client.status()).toBe('online');
    expect(fake.calls.filter((c) => c.kind === 'register')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
    client.dispose();
  });
});

describe('SessionSpineClient fire-and-forget latency contract', () => {
  test('register/reopen/heartbeat/close return synchronously even with a slow-resolving backend (no interactive stall)', () => {
    const fake = makeFakeSessionsClient();
    fake.mode = 'pending'; // never resolves during this test — proves no await on the call site
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));

    const start = Date.now();
    client.register({ sessionId: 's1', project: '/p', title: 'T' });
    client.heartbeat('s1');
    client.reopen({ sessionId: 's2', project: '/p' });
    client.close('s3');
    const elapsedMs = Date.now() - start;

    // All four calls must return without waiting on the wire. The REAL proof is
    // the fixture: `fake.mode = 'pending'` never resolves, so a call site that
    // awaited would hang here and fail on the test budget, not merely be slow.
    // This bound is the secondary sanity check, and 20 ms was a number only an
    // idle machine can promise — four synchronous calls can straddle a
    // descheduling on a busy host. Widened to a value that still separates
    // "returned immediately" from any real wire round trip.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(client.status()).toBe('unknown'); // network has not settled — no premature 'online'
    client.dispose();
  });

  test('a rejecting backend never throws into the caller and degrades to offline, queued for reconnect', async () => {
    const fake = makeFakeSessionsClient();
    fake.mode = 'fail';
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    expect(() => client.register({ sessionId: 's1', project: '/p' })).not.toThrow();
    await settle();
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBe(1);
    client.dispose();
  });
});

describe('SessionSpineClient offline queue / reconnect', () => {
  test('offline register queues; recovering the backend flushes it exactly once (idempotent replay)', async () => {
    const fake = makeFakeSessionsClient();
    fake.mode = 'fail';
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.register({ sessionId: 's1', project: '/p', title: 'T' });
    await settle();
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBe(1);

    fake.mode = 'succeed';
    // Any further op triggers a flush attempt (this test exercises heartbeat as
    // the trigger — bootstrap.ts's render-tick heartbeat is the real trigger).
    // heartbeat() itself dispatches ITS OWN register call (fresh lastSeenAt)
    // AND, on success, flushes the queue — so the originally-queued register
    // replays once more alongside it. Net: 1 failed (queued) + 1 heartbeat +
    // 1 flushed replay of the queued op = 3, and critically the queue drains
    // to zero with no duplicate flood on subsequent flushes.
    client.heartbeat('s1');
    await settle();
    expect(client.status()).toBe('online');
    expect(client.pendingOps).toBe(0);
    expect(fake.calls.filter((c) => c.kind === 'register')).toHaveLength(3);
    client.dispose();
  });

  test('bounded ring drops the oldest op past the cap', () => {
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',queueLimit: 2, log: { debug: () => {}, info: () => {} } });
    for (const id of ['a', 'b', 'c']) client.register({ sessionId: id, project: '/p' });
    expect(client.pendingOps).toBe(2); // 'a' dropped
    client.dispose();
  });

  test('deactivate() stops attempting the wire but keeps queuing (bounded)', async () => {
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.register({ sessionId: 's1', project: '/p' });
    await settle();
    expect(fake.calls).toHaveLength(1);

    client.deactivate('daemon mode changed');
    expect(client.active).toBe(false);
    expect(client.status()).toBe('unknown');
    client.register({ sessionId: 's2', project: '/p' });
    await settle();
    expect(fake.calls).toHaveLength(1); // no new wire attempt while dormant
    expect(client.pendingOps).toBe(1); // s2 queued honestly instead
    client.dispose();
  });
});

describe('SessionSpineClient heartbeat debounce', () => {
  test('coalesces bursty turn activity to at most one leading wire call per window', async () => {
    let clock = 100_000;
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',now: () => clock, heartbeatMinIntervalMs: 1_000, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));

    client.register({ sessionId: 's1', project: '/p', title: 'T' });
    await settle();
    const afterCreate = fake.calls.filter((c) => c.kind === 'register').length;

    client.heartbeat('s1'); // first beat past the window -> immediate
    await settle();
    let beats = fake.calls.filter((c) => c.kind === 'register').length - afterCreate;
    expect(beats).toBe(1);

    clock = 100_200;
    client.heartbeat('s1');
    clock = 100_400;
    client.heartbeat('s1'); // bursty, within window -> coalesced
    await settle();
    beats = fake.calls.filter((c) => c.kind === 'register').length - afterCreate;
    expect(beats).toBe(1);

    clock = 101_500;
    client.heartbeat('s1'); // new window -> one more leading beat
    await settle();
    beats = fake.calls.filter((c) => c.kind === 'register').length - afterCreate;
    expect(beats).toBe(2);

    // Heartbeat bodies never carry a title (never renames a titled session).
    const heartbeatCalls = fake.calls.filter((c) => c.kind === 'register').slice(afterCreate);
    for (const call of heartbeatCalls) expect(call.input && 'title' in call.input).toBe(false);
    client.dispose();
  });

  test('heartbeat for an unknown session id is a no-op', async () => {
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.heartbeat('never-registered');
    await settle();
    expect(fake.calls.filter((c) => c.kind === 'register')).toHaveLength(0);
    client.dispose();
  });
});

describe('SessionSpineClient reopen semantics', () => {
  test('reopen sends reopen:true and omits title; register (create) includes title', async () => {
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.register({ sessionId: 's1', project: '/p', title: 'Created' });
    client.reopen({ sessionId: 's2', project: '/p', title: 'Should not be sent' });
    await settle();

    const create = fake.calls.find((c) => c.sessionId === 's1');
    const reopen = fake.calls.find((c) => c.sessionId === 's2');
    expect(create?.input?.title).toBe('Created');
    expect(create?.input?.reopen).toBeUndefined();
    expect(reopen?.input?.reopen).toBe(true);
    expect(reopen?.input && 'title' in reopen.input).toBe(false);
    client.dispose();
  });
});

describe('SessionSpineClient legacy fold', () => {
  test('registers each record and closes locally-closed records', async () => {
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.foldLegacyRecords(
      [
        { sessionId: 'open-1', project: '/p', title: 'Open one' },
        { sessionId: 'closed-1', project: '/p', title: 'Closed one' },
      ],
      new Set(['closed-1']),
    );
    await settle();

    const registers = fake.calls.filter((c) => c.kind === 'register');
    const closes = fake.calls.filter((c) => c.kind === 'close');
    expect(registers).toHaveLength(2);
    for (const r of registers) expect(r.input?.kind).toBe('tui');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.sessionId).toBe('closed-1');
    client.dispose();
  });
});

describe('foldLegacySpineStore', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectTempDir('goodvibes-tui-spine-fold');
  });

  afterEach(() => {
    // best-effort cleanup, not load-bearing for the assertions above
  });

  test('reads the project-scoped store, folds records, and writes a migration marker', () => {
    const storePath = join(root, 'sessions.json');
    const markerPath = join(root, 'sessions.json.spine-migrated');
    writeFileSync(storePath, JSON.stringify({
      sessions: {
        'sess-1': { id: 'sess-1', kind: 'tui', title: 'One', status: 'active' },
        'sess-2': { id: 'sess-2', kind: 'tui', title: 'Two', status: 'closed' },
      },
    }));

    const folded: Array<{ ids: string[]; closed: string[] }> = [];
    const stub = {
      foldLegacyRecords: (records: readonly { sessionId: string }[], closedIds: ReadonlySet<string>) => {
        folded.push({ ids: records.map((r) => r.sessionId), closed: [...closedIds] });
      },
    };

    const result = foldLegacySpineStore(stub, { storePath, markerPath, project: '/p', now: () => 42, log: { debug: () => {}, info: () => {} } });
    expect(result).toEqual({ folded: 2, skipped: false });
    expect(folded).toHaveLength(1);
    expect(folded[0]?.ids.sort()).toEqual(['sess-1', 'sess-2']);
    expect(folded[0]?.closed).toEqual(['sess-2']);
    expect(existsSync(markerPath)).toBe(true);
    expect((JSON.parse(readFileSync(markerPath, 'utf-8')) as { count: number }).count).toBe(2);
  });

  test('skips when the marker asserts a completed fold (idempotent, marked migrated)', () => {
    const storePath = join(root, 'sessions.json');
    const markerPath = join(root, 'sessions.json.spine-migrated');
    writeFileSync(storePath, JSON.stringify({ sessions: { 'sess-1': { id: 'sess-1', status: 'active' } } }));
    writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, completed: true, migratedAt: 1, count: 1 }));

    let called = 0;
    const result = foldLegacySpineStore(
      { foldLegacyRecords: () => { called += 1; } },
      { storePath, markerPath, project: '/p', log: { debug: () => {}, info: () => {} } },
    );
    expect(result.skipped).toBe(true);
    expect(called).toBe(0);
  });

  test('re-folds once when the marker cannot prove the fold completed', () => {
    // A marker's mere existence is no longer trusted: an interrupted write used
    // to strand the legacy store forever. Only a marker that asserts its own
    // completion short-circuits, so the pre-completion-flag shape below folds
    // again — a one-time, idempotent re-register (the legacy file never changes
    // again, and register is an upsert) that then writes a marker which does
    // assert completion.
    const storePath = join(root, 'sessions.json');
    const markerPath = join(root, 'sessions.json.spine-migrated');
    writeFileSync(storePath, JSON.stringify({ sessions: { 'sess-1': { id: 'sess-1', status: 'active' } } }));
    writeFileSync(markerPath, JSON.stringify({ migratedAt: 1, count: 1 }));

    let called = 0;
    const result = foldLegacySpineStore(
      { foldLegacyRecords: () => { called += 1; } },
      { storePath, markerPath, project: '/p', log: { debug: () => {}, info: () => {} } },
    );
    expect(result.skipped).toBe(false);
    expect(called).toBe(1);
    expect(readFileSync(markerPath, 'utf-8')).toContain('"completed": true');
  });

  test('a missing store folds nothing and writes no marker', () => {
    const markerPath = join(root, 'sessions.json.spine-migrated');
    let called = 0;
    const result = foldLegacySpineStore(
      { foldLegacyRecords: () => { called += 1; } },
      { storePath: join(root, 'does-not-exist.json'), markerPath, project: '/p', log: { debug: () => {}, info: () => {} } },
    );
    expect(result).toEqual({ folded: 0, skipped: false });
    expect(called).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('SessionSpineClient timer-driven keepalive (surface never goes stale mid-idle)', () => {
  test('keepalive re-heartbeats on its own cadence with NO render/turn activity', async () => {
    const fake = makeFakeSessionsClient();
    // Small window so the interval fires quickly in the test.
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',heartbeatMinIntervalMs: 15, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.register({ sessionId: 'keepalive-1', project: '/p', title: 'T' });
    await settle();
    expect(client.keepaliveSessionId).toBe('keepalive-1');
    const afterRegister = fake.calls.filter((c) => c.kind === 'register').length;

    // Without touching the client again (no renders, no activity), the keepalive
    // timer must produce further heartbeats.
    await waitUntil(
      () => fake.calls.filter((c) => c.kind === 'register').length > afterRegister,
      'the keepalive timer produces a further heartbeat with no activity',
    );
    await settle();
    const afterIdle = fake.calls.filter((c) => c.kind === 'register').length;
    expect(afterIdle).toBeGreaterThan(afterRegister);
    // Every keepalive beat targets the live session id.
    expect(fake.calls.every((c) => c.sessionId === 'keepalive-1')).toBe(true);
    client.dispose();
  });

  test('dispose() stops the keepalive (no beats after teardown)', async () => {
    const fake = makeFakeSessionsClient();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',heartbeatMinIntervalMs: 15, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(fake.client));
    client.register({ sessionId: 'keepalive-2', project: '/p', title: 'T' });
    await settle();
    client.dispose();
    // Settle first so a beat that was already in flight when dispose() ran is
    // recorded BEFORE the baseline is taken — otherwise the assertion below
    // could count a pre-dispose beat as a post-dispose one purely because the
    // machine was busy. What is being proven is that no NEW beat is produced.
    await settle();
    const afterDispose = fake.calls.length;
    // A genuine negative: there is no condition to poll for, so this waits out
    // several keepalive periods (15 ms cadence) and asserts nothing arrived.
    // Load only ever makes FEWER beats, so this direction is not load-fragile.
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.calls.length).toBe(afterDispose);
  });
});
