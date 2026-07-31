/**
 * daemon-attach-handshake.test.ts — what one `/status` read decides.
 *
 * build-floors.test.ts pins the two verdicts and client-build-floor-gate.test.ts
 * pins what the forward one costs a stale terminal. This is the seam between
 * them: the attach that reads the daemon once and then adopts it, refuses it, or
 * leaves it alone — plus the receipts, whose delivery is destructive, so a read
 * that consumed them and then failed to render them would lose them.
 */
import { describe, expect, test } from 'bun:test';
import { createDaemonAttachHandshake } from '../../runtime/client/daemon-attach-handshake.ts';
import { ClientBuildGuard } from '../../runtime/client/build-floors.ts';
import type { ExternalDaemonAttachRead } from '../../runtime/daemon-attach-notices.ts';
import type { HostServiceStatus } from '@/runtime/index.ts';

const ADOPTED: HostServiceStatus = {
  mode: 'external',
  host: '127.0.0.1',
  port: 3421,
  baseUrl: 'http://127.0.0.1:3421',
};

function unanswered(): ExternalDaemonAttachRead {
  return { answered: false, notices: [], clientFloor: undefined, statusPayload: null };
}

function answered(options: {
  readonly version?: string;
  readonly clientFloor?: string;
  readonly notices?: string[];
}): ExternalDaemonAttachRead {
  return {
    answered: true,
    notices: options.notices ?? [],
    clientFloor: options.clientFloor,
    statusPayload: { status: 'running', version: options.version ?? '1.28.0' },
  };
}

function makeHarness(options: {
  readonly status?: HostServiceStatus;
  readonly answer?: ExternalDaemonAttachRead;
  readonly clientVersion?: string;
  readonly daemonFloor?: string;
}) {
  const adopted: Array<{ mode: string; reason?: string | undefined; token: string }> = [];
  const refusals: HostServiceStatus[] = [];
  const notices: string[] = [];
  const reads: Array<{ baseUrl: string; consumeReceipts: boolean }> = [];
  let status = options.status ?? ADOPTED;
  const clientBuildGuard = new ClientBuildGuard({ clientVersion: options.clientVersion ?? '1.28.0' });

  const handshake = createDaemonAttachHandshake({
    clientBuildGuard,
    readDaemonStatus: () => status,
    recordRefusal: (refused) => { refusals.push(refused); status = refused; },
    adopt: (adoptedStatus, token) => {
      adopted.push({ mode: adoptedStatus.mode, reason: adoptedStatus.reason, token });
    },
    notify: (text) => { notices.push(text); },
    ...(options.daemonFloor === undefined ? {} : { daemonFloor: options.daemonFloor }),
    read: async (deps) => {
      reads.push({ baseUrl: deps.baseUrl, consumeReceipts: deps.consumeReceipts === true });
      return options.answer ?? unanswered();
    },
  });

  return { handshake, clientBuildGuard, adopted, refusals, notices, reads };
}

describe('a daemon this build can work with', () => {
  test('is adopted, and its receipts are rendered by the read that consumed them', async () => {
    const h = makeHarness({
      answer: answered({ version: '1.28.4', notices: ['updated to 1.28.4', 'restarted after a crash at 14:32'] }),
    });

    await h.handshake.attach('shared-bearer');

    expect(h.reads).toEqual([{ baseUrl: 'http://127.0.0.1:3421', consumeReceipts: true }]);
    expect(h.adopted).toEqual([{ mode: 'external', reason: undefined, token: 'shared-bearer' }]);
    expect(h.refusals).toEqual([]);
    expect(h.notices).toEqual(['updated to 1.28.4', 'restarted after a crash at 14:32']);
  });

  test('feeds the guard the client floor it announced', async () => {
    const h = makeHarness({ answer: answered({ clientFloor: '1.20.0' }), clientVersion: '1.28.0' });

    await h.handshake.attach('shared-bearer');

    expect(h.clientBuildGuard.current().floor).toBe('1.20.0');
    expect(h.clientBuildGuard.maySharedSessionWork()).toBe(true);
  });

  test('a client floor above this build stops the work and tells the owner, once', async () => {
    const h = makeHarness({ answer: answered({ clientFloor: '2.0.0' }), clientVersion: '1.28.0' });

    await h.handshake.attach('shared-bearer');
    await h.handshake.attach('shared-bearer');

    expect(h.clientBuildGuard.maySharedSessionWork()).toBe(false);
    const floorNotices = h.notices.filter((line) => line.includes('2.0.0'));
    expect(floorNotices).toHaveLength(1);
    expect(floorNotices[0]).toContain('1.28.0');
    // Still adopted: the mirror stays up so the owner can see the session and
    // read the notice. What stops is taking shared-session WORK.
    expect(h.adopted.every((call) => call.mode === 'external')).toBe(true);
  });
});

describe('a daemon below this build\'s floor', () => {
  test('is refused, with the refusal recorded on the status every reader consults', async () => {
    const h = makeHarness({ answer: answered({ version: '1.27.1' }), daemonFloor: '1.28.0' });

    await h.handshake.attach('shared-bearer');

    expect(h.refusals).toHaveLength(1);
    expect(h.refusals[0]!.mode).toBe('incompatible');
    expect(h.refusals[0]!.reason).toContain('1.27.1');
    expect(h.refusals[0]!.reason).toContain('1.28.0');
    // The spine is driven with the REFUSED status, so it detaches rather than
    // mirroring session identity to a daemon that cannot serve this build.
    expect(h.adopted).toEqual([{ mode: 'incompatible', reason: h.refusals[0]!.reason, token: 'shared-bearer' }]);
  });

  test('says so once, and says nothing about a client floor it has no business honoring', async () => {
    const h = makeHarness({
      answer: answered({ version: '1.27.1', clientFloor: '2.0.0', notices: ['a receipt'] }),
      daemonFloor: '1.28.0',
      clientVersion: '1.28.0',
    });

    await h.handshake.attach('shared-bearer');
    await h.handshake.attach('shared-bearer');

    expect(h.notices.filter((line) => line.includes('update the daemon'))).toHaveLength(1);
    // A daemon this terminal refused does not get to pause its work.
    expect(h.clientBuildGuard.maySharedSessionWork()).toBe(true);
    expect(h.notices).not.toContain('a receipt');
  });
});

describe('a daemon that says nothing usable', () => {
  test('a failed read adopts as before rather than turning one dropped request into a lost mirror', async () => {
    const h = makeHarness({ answer: unanswered() });

    await h.handshake.attach('shared-bearer');

    expect(h.adopted).toEqual([{ mode: 'external', reason: undefined, token: 'shared-bearer' }]);
    expect(h.refusals).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test('a status body with no version is named, and adopted rather than refused', async () => {
    const h = makeHarness({
      answer: { answered: true, notices: [], clientFloor: undefined, statusPayload: { status: 'running' } },
      daemonFloor: '1.28.0',
    });

    await h.handshake.attach('shared-bearer');

    expect(h.notices.join('\n')).toContain('did not report a version');
    expect(h.adopted).toEqual([{ mode: 'external', reason: undefined, token: 'shared-bearer' }]);
  });

  test('no adopted daemon at all is not read from — there is nothing to ask', async () => {
    const h = makeHarness({
      status: { mode: 'unavailable', host: '127.0.0.1', port: 3421, baseUrl: '', reason: 'no daemon' },
      answer: answered({}),
    });

    await h.handshake.attach('shared-bearer');

    expect(h.reads).toEqual([]);
    // The spine is still driven, which is how it detaches into local-only.
    expect(h.adopted).toEqual([{ mode: 'unavailable', reason: 'no daemon', token: 'shared-bearer' }]);
  });
});

describe('a daemon that went away and came back', () => {
  test('is handshaken again on the liveness flip, with the bearer the last attach used', async () => {
    const h = makeHarness({ answer: answered({ notices: ['restarted after a crash at 03:10'] }) });
    await h.handshake.attach('shared-bearer');
    expect(h.reads).toHaveLength(1);

    h.handshake.onLivenessTransition(false);
    expect(h.reads).toHaveLength(1);

    h.handshake.onLivenessTransition(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]!.consumeReceipts).toBe(true);
  });

  test('a flip before anything was ever attached reads nothing', async () => {
    const h = makeHarness({ answer: answered({}) });

    h.handshake.onLivenessTransition(true);
    await Promise.resolve();

    expect(h.reads).toEqual([]);
    expect(h.adopted).toEqual([]);
  });
});
