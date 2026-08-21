import { describe, expect, test } from 'bun:test';
import {
  consumeDaemonAttachNotices,
  readExternalDaemonAttach,
  type DaemonReceiptLike,
} from '../../runtime/daemon-attach-notices.ts';

/** A drainable queue that yields its items once, then nothing (exactly-once). */
function drainOnce<T>(items: T[]): () => readonly T[] {
  let drained = false;
  return () => {
    if (drained) return [];
    drained = true;
    return items;
  };
}

const configManager = { getControlPlaneConfigDir: () => '/tmp/gv-does-not-matter' };

describe('consumeDaemonAttachNotices', () => {
  test('renders receipts first, then announcements, as one-line notices', () => {
    const receipts = drainOnce<DaemonReceiptLike>([
      { id: 'r1', text: 'restarted after a crash at 14:32', at: 1 },
      { id: 'r2', text: 'updated to 1.16.2', at: 2 },
    ]);
    const drainAnnouncements = drainOnce([
      { id: 'web-surface-url', text: 'Web surface reachable at http://127.0.0.1:8787', at: 3 },
      { id: 'sandbox-first-run', text: 'commands now run contained; escalations will ask', at: 4 },
    ]);

    const notices = consumeDaemonAttachNotices({
      configManager,
      collectReceipts: receipts,
      announcementStore: { drainPending: drainAnnouncements },
    });

    expect(notices).toEqual([
      'restarted after a crash at 14:32',
      'updated to 1.16.2',
      'Web surface reachable at http://127.0.0.1:8787',
      'commands now run contained; escalations will ask',
    ]);
  });

  test('exactly-once: a second attach with nothing new shows nothing', () => {
    const receipts = drainOnce<DaemonReceiptLike>([{ id: 'r1', text: 'restarted after a crash at 14:32', at: 1 }]);
    const drainAnnouncements = drainOnce([{ id: 'web-surface-url', text: 'Web surface reachable at http://127.0.0.1:8787', at: 2 }]);
    const store = { drainPending: drainAnnouncements };

    const first = consumeDaemonAttachNotices({ configManager, collectReceipts: receipts, announcementStore: store });
    expect(first).toHaveLength(2);

    const second = consumeDaemonAttachNotices({ configManager, collectReceipts: receipts, announcementStore: store });
    expect(second).toEqual([]);
  });

  test('blank receipt/announcement lines are skipped', () => {
    const notices = consumeDaemonAttachNotices({
      configManager,
      collectReceipts: drainOnce<DaemonReceiptLike>([{ id: 'r1', text: '   ', at: 1 }]),
      announcementStore: { drainPending: drainOnce([{ id: 'a1', text: '', at: 2 }]) },
    });
    expect(notices).toEqual([]);
  });
});

/**
 * A stub external daemon: its /status?receipts=consume endpoint serves the
 * daemon-side receipts shape ({ receipts: [{id,text,at}] }) once, then nothing,
 * exactly-once, mirroring the daemon's own consume-and-mark-delivered store. It
 * requires the shared bearer, so a request with the wrong/missing token 401s.
 */
function stubExternalDaemon(options: {
  readonly token: string;
  readonly receipts: DaemonReceiptLike[];
  readonly version?: string;
  readonly clientFloor?: string;
}): typeof fetch {
  let served = false;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth !== `Bearer ${options.token}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    const headers = options.clientFloor ? { 'X-Goodvibes-Client-Floor': options.clientFloor } : undefined;
    const version = options.version ?? '9.9.9';
    if (!url.includes('/status?receipts=consume')) {
      return new Response(JSON.stringify({ status: 'running', version }), { status: 200, ...(headers ? { headers } : {}) });
    }
    const receipts = served ? [] : options.receipts;
    served = true;
    return new Response(JSON.stringify({ status: 'running', version, receipts }), { status: 200, ...(headers ? { headers } : {}) });
  }) as typeof fetch;
}

describe('readExternalDaemonAttach', () => {
  test('reads the adopted daemon receipts over HTTP and renders their text lines', async () => {
    const fetchImpl = stubExternalDaemon({
      token: 'shared-bearer',
      receipts: [
        { id: 'r1', text: 'restarted after a crash at 14:32', at: 1 },
        { id: 'announcement-web', text: 'Web surface reachable at http://127.0.0.1:8787', at: 2 },
        { id: 'blank', text: '   ', at: 3 },
      ],
    });
    const read = await readExternalDaemonAttach({
      baseUrl: 'http://127.0.0.1:3421/',
      authToken: 'shared-bearer',
      consumeReceipts: true,
      fetchImpl,
    });
    expect(read.answered).toBe(true);
    expect(read.notices).toEqual([
      'restarted after a crash at 14:32',
      'Web surface reachable at http://127.0.0.1:8787',
    ]);
  });

  test('exactly-once: a second attach with nothing new renders nothing', async () => {
    const fetchImpl = stubExternalDaemon({
      token: 'shared-bearer',
      receipts: [{ id: 'r1', text: 'updated to 1.16.2', at: 1 }],
    });
    const source = { baseUrl: 'http://127.0.0.1:3421', authToken: 'shared-bearer', consumeReceipts: true, fetchImpl };
    expect((await readExternalDaemonAttach(source)).notices).toEqual(['updated to 1.16.2']);
    expect((await readExternalDaemonAttach(source)).notices).toEqual([]);
  });

  test('a read that does not ask for receipts leaves them for the read that renders them', async () => {
    const fetchImpl = stubExternalDaemon({
      token: 'shared-bearer',
      receipts: [{ id: 'r1', text: 'updated to 1.28.0', at: 1 }],
    });
    const source = { baseUrl: 'http://127.0.0.1:3421', authToken: 'shared-bearer', fetchImpl };
    const floorsOnly = await readExternalDaemonAttach(source);
    expect(floorsOnly.answered).toBe(true);
    expect(floorsOnly.notices).toEqual([]);
    // The daemon still holds it, so the consuming read is the one that sees it.
    expect((await readExternalDaemonAttach({ ...source, consumeReceipts: true })).notices)
      .toEqual(['updated to 1.28.0']);
  });

  test('carries the daemon build and the client floor it announced', async () => {
    const fetchImpl = stubExternalDaemon({
      token: 'shared-bearer',
      receipts: [],
      version: '1.28.3',
      clientFloor: '1.26.0',
    });
    const read = await readExternalDaemonAttach({
      baseUrl: 'http://127.0.0.1:3421',
      authToken: 'shared-bearer',
      consumeReceipts: true,
      fetchImpl,
    });
    expect(read.clientFloor).toBe('1.26.0');
    expect((read.statusPayload as { version?: string }).version).toBe('1.28.3');
  });

  test('a daemon announcing no floor reports none, rather than a guess', async () => {
    const fetchImpl = stubExternalDaemon({ token: 'shared-bearer', receipts: [], version: '1.28.0' });
    const read = await readExternalDaemonAttach({
      baseUrl: 'http://127.0.0.1:3421',
      authToken: 'shared-bearer',
      fetchImpl,
    });
    expect(read.answered).toBe(true);
    expect(read.clientFloor).toBeUndefined();
  });

  test('an unauthorized (wrong token) read reads as unanswered, never throws', async () => {
    const fetchImpl = stubExternalDaemon({
      token: 'right-bearer',
      receipts: [{ id: 'r1', text: 'should not be seen', at: 1 }],
    });
    const read = await readExternalDaemonAttach({
      baseUrl: 'http://127.0.0.1:3421',
      authToken: 'wrong-bearer',
      consumeReceipts: true,
      fetchImpl,
    });
    expect(read).toMatchObject({ answered: false, notices: [], clientFloor: undefined });
  });

  test('a transport failure reads as unanswered, never throws', async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () => { throw new Error('connection refused'); },
      { preconnect: () => {} },
    );
    const read = await readExternalDaemonAttach({
      baseUrl: 'http://127.0.0.1:3421',
      authToken: 'shared-bearer',
      consumeReceipts: true,
      fetchImpl,
    });
    expect(read).toMatchObject({ answered: false, notices: [], clientFloor: undefined });
  });
});
