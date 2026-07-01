import { describe, expect, it } from 'bun:test';
import {
  ImapStoreError,
  imapStoreFlagOverTls,
  makeRetryingImapStoreFlag,
} from '../../../daemon/handlers/triage/tagger/imap.ts';
import type {
  ImapConnect,
  ImapSocketLike,
} from '../../../daemon/handlers/triage/tagger/imap.ts';

const BASE = {
  host: 'imap.example.test',
  port: 993,
  user: 'mailbot',
  password: 'imap-EXAMPLE-fakepass',
  mailbox: 'INBOX',
  uid: '1',
  flag: 'GoodVibes_Spam',
};

describe('imapStoreFlagOverTls CRLF-injection guard', () => {
  it('rejects a CRLF-bearing mailbox before opening a socket (non-transient)', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, mailbox: 'INBOX\r\nA1 DELETE everything' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  it('rejects a control char in the username (non-transient)', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, user: 'bad\x00user' }),
    ).rejects.toMatchObject({ transient: false });
  });

  it('rejects a CRLF-bearing uid before opening a socket (non-transient)', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, uid: '1)\r\nA99 DELETE everything' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  // uid is interpolated UNQUOTED into `UID STORE <uid> +FLAGS (...)`. A wildcard
  // sequence-set like `1:*` carries no control chars, so the CRLF guard alone
  // would let it through and the flag would be applied to the ENTIRE mailbox.
  it('rejects a wildcard uid sequence-set `1:*` (would tag whole mailbox)', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, uid: '1:*' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  it('rejects a bare `*` wildcard uid', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, uid: '*' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  it('rejects a non-numeric uid', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, uid: '1abc' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  // flag is interpolated UNQUOTED into the `+FLAGS (...)` list. A flag with a
  // space carries no control chars but would inject a SECOND flag atom — the
  // grammar check at the client boundary rejects it independent of any upstream
  // normalizer.
  it('rejects a flag containing a space (second-atom injection)', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, flag: 'GoodVibes_Spam \\Deleted' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  it('rejects a flag closing the FLAGS list early with a paren', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, flag: 'Junk) other' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });

  it('rejects an empty flag', async () => {
    await expect(
      imapStoreFlagOverTls({ ...BASE, flag: '' }),
    ).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
  });
});

// ---------------------------------------------------------------------------
// Mock-socket data-pump harness.
//
// FakeImapSocket implements the exact ImapSocketLike seam imapStoreFlagOverTls
// drives. It records every command written by the client (so a scripted server
// can react per-tag), exposes feed() to push server lines into the registered
// data handler (CRLF-terminated, split exactly as the real newline buffer
// would), and emit() to drive 'close'/'error'. This exercises the async
// protocol state machine end-to-end with no real network socket: greeting
// validation, untagged-line skipping, tagged OK/NO/BAD parsing, the `* BYE`
// clean-close path, the completed/close interplay, and the timeout branch.
// ---------------------------------------------------------------------------
class FakeImapSocket implements ImapSocketLike {
  readonly writes: string[] = [];
  destroyed = false;
  timeoutMs: number | null = null;
  private timeoutCb: (() => void) | null = null;
  private dataCb: ((chunk: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;

  setEncoding(_encoding: string): void {
    /* no-op for the in-memory transport */
  }

  setTimeout(ms: number, callback: () => void): void {
    this.timeoutMs = ms;
    this.timeoutCb = callback;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: string, listener: (...a: never[]) => void): void {
    if (event === 'data') this.dataCb = listener as (chunk: string) => void;
    else if (event === 'error') this.errorCb = listener as (err: Error) => void;
    else if (event === 'close') this.closeCb = listener as () => void;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Push one server line (CRLF appended, as a real IMAP server sends). */
  feed(line: string): void {
    this.dataCb?.(`${line}\r\n`);
  }

  /** The bare tag (`A1`, `A2`, ...) of the Nth command the client wrote. */
  tagFor(index: number): string {
    const cmd = this.writes[index] ?? '';
    return cmd.slice(0, cmd.indexOf(' '));
  }

  fireTimeout(): void {
    this.timeoutCb?.();
  }

  fireClose(): void {
    this.closeCb?.();
  }

  fireError(err: Error): void {
    this.errorCb?.(err);
  }
}

/**
 * Build a connector that hands out a FakeImapSocket and runs `script` against
 * it once the client has registered its handlers. The script may feed lines
 * synchronously; client command writes happen inside the awaited send() chain,
 * so we re-enter the script via microtask scheduling driven by feed().
 */
function scriptedConnect(
  drive: (socket: FakeImapSocket) => void,
): { connect: ImapConnect; socket: FakeImapSocket } {
  const socket = new FakeImapSocket();
  const connect: ImapConnect = () => {
    // Defer until the client has attached its data/close/error handlers and
    // set its timeout (all synchronous after connect returns).
    queueMicrotask(() => drive(socket));
    return socket;
  };
  return { connect, socket };
}

/**
 * Drive a full, well-behaved IMAP exchange: greeting, then a tagged OK for each
 * of LOGIN/SELECT/UID STORE, then `respondLogout` decides how LOGOUT ends.
 * Each step waits a microtask turn so the client's awaited send() resolves and
 * writes the next command before the server responds to it.
 */
async function runHappyPath(
  socket: FakeImapSocket,
  greeting: string,
  respondLogout: (s: FakeImapSocket) => void,
): Promise<void> {
  socket.feed(greeting); // greeting -> client writes A1 LOGIN
  await Promise.resolve();
  socket.feed(`${socket.tagFor(0)} OK LOGIN completed`);
  await Promise.resolve();
  socket.feed(`${socket.tagFor(1)} OK SELECT completed`);
  await Promise.resolve();
  socket.feed(`${socket.tagFor(2)} OK STORE completed`);
  await Promise.resolve();
  respondLogout(socket);
}

describe('imapStoreFlagOverTls data pump (mock socket)', () => {
  it('resolves on a clean LOGIN/SELECT/STORE/LOGOUT exchange (tagged OK logout)', async () => {
    const { connect, socket } = scriptedConnect((s) => {
      void runHappyPath(s, '* OK IMAP4rev1 ready', (sock) => {
        sock.feed(`${sock.tagFor(3)} OK LOGOUT completed`);
      });
    });
    await imapStoreFlagOverTls(BASE, connect);
    // Exactly the four protocol commands were issued, in order.
    expect(socket.writes).toHaveLength(4);
    expect(socket.writes[0]).toContain('LOGIN');
    expect(socket.writes[1]).toContain('SELECT "INBOX"');
    expect(socket.writes[2]).toBe('A3 UID STORE 1 +FLAGS (GoodVibes_Spam)\r\n');
    expect(socket.writes[3]).toBe('A4 LOGOUT\r\n');
    expect(socket.destroyed).toBe(true);
  });

  it('resolves when LOGOUT is announced by an untagged `* BYE` then a close', async () => {
    const { connect, socket } = scriptedConnect((s) => {
      void runHappyPath(s, '* OK ready', (sock) => {
        // Server sends BYE (no tagged OK for LOGOUT) then drops the connection.
        sock.feed('* BYE logging out');
        sock.fireClose();
      });
    });
    await imapStoreFlagOverTls(BASE, connect);
    expect(socket.destroyed).toBe(true);
  });

  it('rejects non-transient when UID STORE returns a tagged NO', async () => {
    const { connect } = scriptedConnect((s) => {
      void (async () => {
        s.feed('* OK ready');
        await Promise.resolve();
        s.feed(`${s.tagFor(0)} OK LOGIN ok`);
        await Promise.resolve();
        s.feed(`${s.tagFor(1)} OK SELECT ok`);
        await Promise.resolve();
        s.feed(`${s.tagFor(2)} NO [CANNOT] keyword not permitted`);
      })();
    });
    await expect(imapStoreFlagOverTls(BASE, connect)).rejects.toMatchObject({
      name: 'ImapStoreError',
      transient: false,
    });
  });

  it('rejects non-transient when a command returns a tagged BAD', async () => {
    const { connect } = scriptedConnect((s) => {
      void (async () => {
        s.feed('* OK ready');
        await Promise.resolve();
        s.feed(`${s.tagFor(0)} BAD syntax error`);
      })();
    });
    await expect(imapStoreFlagOverTls(BASE, connect)).rejects.toMatchObject({
      name: 'ImapStoreError',
      transient: false,
    });
  });

  it('skips untagged data lines and still resolves on the tagged OK', async () => {
    const { connect, socket } = scriptedConnect((s) => {
      void (async () => {
        s.feed('* OK ready');
        await Promise.resolve();
        // Untagged informational lines interleaved before the tagged result.
        s.feed('* CAPABILITY IMAP4rev1');
        s.feed(`${s.tagFor(0)} OK LOGIN ok`);
        await Promise.resolve();
        s.feed('* 5 EXISTS');
        s.feed(`${s.tagFor(1)} OK SELECT ok`);
        await Promise.resolve();
        s.feed(`${s.tagFor(2)} OK STORE ok`);
        await Promise.resolve();
        s.feed(`${s.tagFor(3)} OK LOGOUT ok`);
      })();
    });
    await imapStoreFlagOverTls(BASE, connect);
    expect(socket.writes).toHaveLength(4);
  });

  it('rejects transient when the server greeting is not OK/PREAUTH', async () => {
    const { connect } = scriptedConnect((s) => {
      s.feed('* NO service unavailable');
    });
    await expect(imapStoreFlagOverTls(BASE, connect)).rejects.toMatchObject({
      name: 'ImapStoreError',
      transient: true,
    });
  });

  it('rejects transient when the connection closes unexpectedly mid-exchange', async () => {
    const { connect } = scriptedConnect((s) => {
      void (async () => {
        s.feed('* OK ready');
        await Promise.resolve();
        s.feed(`${s.tagFor(0)} OK LOGIN ok`);
        await Promise.resolve();
        // Server vanishes before SELECT completes — no `completed` flag set.
        s.fireClose();
      })();
    });
    await expect(imapStoreFlagOverTls(BASE, connect)).rejects.toMatchObject({
      name: 'ImapStoreError',
      transient: true,
    });
  });

  it('rejects transient when a socket error is emitted', async () => {
    const { connect } = scriptedConnect((s) => {
      s.fireError(new Error('ECONNRESET-ish socket failure'));
    });
    await expect(imapStoreFlagOverTls(BASE, connect)).rejects.toMatchObject({
      name: 'ImapStoreError',
      transient: true,
    });
  });

  it('rejects transient when the inactivity timeout fires', async () => {
    const { connect } = scriptedConnect((s) => {
      // Greeting arrives, but the server then stalls; the client's timeout trips.
      s.feed('* OK ready');
      s.fireTimeout();
    });
    await expect(imapStoreFlagOverTls(BASE, connect)).rejects.toMatchObject({
      name: 'ImapStoreError',
      transient: true,
    });
  });
});

describe('makeRetryingImapStoreFlag', () => {
  it('does not retry a non-transient protocol error', async () => {
    let attempts = 0;
    const retrying = makeRetryingImapStoreFlag(
      async () => {
        attempts += 1;
        throw new ImapStoreError('IMAP command failed: NO permission denied', false);
      },
      { maxAttempts: 5, baseDelayMs: 0, sleep: async () => {} },
    );
    await expect(retrying(BASE)).rejects.toMatchObject({ transient: false });
    expect(attempts).toBe(1);
  });

  it('retries transient errors up to the attempt cap then rethrows', async () => {
    let attempts = 0;
    const retrying = makeRetryingImapStoreFlag(
      async () => {
        attempts += 1;
        throw new ImapStoreError('IMAP connection timed out', true);
      },
      { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
    );
    await expect(retrying(BASE)).rejects.toMatchObject({ transient: true });
    expect(attempts).toBe(3);
  });

  it('succeeds on the first try without retrying', async () => {
    let attempts = 0;
    const retrying = makeRetryingImapStoreFlag(async () => {
      attempts += 1;
    });
    await retrying(BASE);
    expect(attempts).toBe(1);
  });
});
