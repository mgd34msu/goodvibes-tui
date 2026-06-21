import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import {
  ImapConnector,
  ImapError,
  collapseWhitespace,
  decodeMimeWords,
  decodeQuotedPrintable,
  decodeTransferEncoding,
  parseAddressList,
  parseAppendUid,
  parseEnvelope,
  parseFetchSummaries,
  parseFullMessage,
  parseMimeMessage,
  parseSearchUids,
  quoteImapString,
  splitHeadersBody,
  stripHtml,
  toImapSearchDate,
  tokenizeParen,
  unescapeImapString,
} from '../../../daemon/email/imap-connector.ts';

// ===========================================================================
// Pure parser unit tests
// ===========================================================================

describe('toImapSearchDate', () => {
  it('formats an ISO date as DD-Mon-YYYY (UTC)', () => {
    expect(toImapSearchDate('2026-03-05T12:00:00.000Z')).toBe('05-Mar-2026');
    expect(toImapSearchDate('2026-12-31T23:59:00.000Z')).toBe('31-Dec-2026');
  });

  it('throws ImapError on an invalid date', () => {
    expect(() => toImapSearchDate('not-a-date')).toThrow(ImapError);
  });
});

describe('quoteImapString / unescapeImapString', () => {
  it('quotes and escapes special characters', () => {
    expect(quoteImapString('he"llo')).toBe('"he\\"llo"');
    expect(quoteImapString('back\\slash')).toBe('"back\\\\slash"');
  });
  it('round-trips through unescape', () => {
    expect(unescapeImapString('he\\"llo')).toBe('he"llo');
  });
});

describe('parseSearchUids', () => {
  it('parses a search response into UIDs', () => {
    expect(parseSearchUids(['* SEARCH 3 7 12 99'])).toEqual([3, 7, 12, 99]);
  });
  it('returns empty for an empty search', () => {
    expect(parseSearchUids(['* SEARCH'])).toEqual([]);
    expect(parseSearchUids(['* OK done'])).toEqual([]);
  });
});

describe('parseAppendUid', () => {
  it('extracts the UID from an APPENDUID response code', () => {
    expect(parseAppendUid(['A0003 OK [APPENDUID 1234567 42] APPEND completed'])).toBe(42);
  });
  it('returns 0 when no APPENDUID present', () => {
    expect(parseAppendUid(['A0003 OK APPEND completed'])).toBe(0);
  });
});

describe('tokenizeParen', () => {
  it('respects nested parens and quoted strings', () => {
    const tokens = tokenizeParen('("a b" (c d) NIL "e\\"f")');
    expect(tokens).toEqual(['"a b"', '(c d)', 'NIL', '"e\\"f"']);
  });
});

describe('parseAddressList', () => {
  it('builds a display-named address from an IMAP address structure', () => {
    const addr = '(("Jane Doe" NIL "jane" "example.com"))';
    expect(parseAddressList(addr)).toBe('Jane Doe <jane@example.com>');
  });
  it('returns a bare address when no display name', () => {
    const addr = '((NIL NIL "bob" "example.com"))';
    expect(parseAddressList(addr)).toBe('bob@example.com');
  });
  it('returns empty for NIL', () => {
    expect(parseAddressList('NIL')).toBe('');
  });
});

describe('parseEnvelope', () => {
  it('extracts date, subject, from, message-id in envelope order', () => {
    const env = '("Wed, 04 Mar 2026 10:00:00 +0000" "Hello World" (("Jane" NIL "jane" "x.com")) (("Jane" NIL "jane" "x.com")) (("Jane" NIL "jane" "x.com")) ((NIL NIL "bob" "y.com")) NIL NIL NIL "<msg-1@x.com>")';
    const parsed = parseEnvelope(env);
    expect(parsed.subject).toBe('Hello World');
    expect(parsed.from).toBe('Jane <jane@x.com>');
    expect(parsed.messageId).toBe('<msg-1@x.com>');
    expect(parsed.date).toContain('2026');
  });

  it('decodes RFC 2047 encoded subjects', () => {
    const env = '("date" "=?UTF-8?B?w6lsw6lnYW50?=" ((NIL NIL "a" "b.com")) NIL NIL NIL NIL NIL NIL "<id>")';
    expect(parseEnvelope(env).subject).toBe('élégant');
  });
});

describe('MIME parsing', () => {
  it('splits headers and body, unfolding continuation lines', () => {
    const raw = 'Subject: a\r\n long subject\r\nFrom: x@y.com\r\n\r\nBody here';
    const { headers, body } = splitHeadersBody(raw);
    expect(headers.subject).toBe('a long subject');
    expect(headers.from).toBe('x@y.com');
    expect(body).toBe('Body here');
  });

  it('parses a plain-text message', () => {
    const raw = 'Content-Type: text/plain\r\n\r\nHello plain';
    const mime = parseMimeMessage(raw);
    expect(mime.text).toBe('Hello plain');
    expect(mime.html).toBeUndefined();
  });

  it('parses an HTML message and derives a text preview', () => {
    const raw = 'Content-Type: text/html\r\n\r\n<p>Hello <b>bold</b></p>';
    const mime = parseMimeMessage(raw);
    expect(mime.html).toContain('<p>Hello');
    expect(mime.text).toBe('Hello bold');
  });

  it('parses multipart/alternative with attachment', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain',
      '',
      'Plain part',
      '--BOUND',
      'Content-Type: text/html',
      '',
      '<p>HTML part</p>',
      '--BOUND',
      'Content-Type: application/pdf; name="doc.pdf"',
      'Content-Disposition: attachment; filename="doc.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('PDFDATA').toString('base64'),
      '--BOUND--',
    ].join('\r\n');
    const mime = parseMimeMessage(raw);
    expect(mime.text).toBe('Plain part');
    expect(mime.html).toBe('<p>HTML part</p>');
    expect(mime.attachments.length).toBe(1);
    expect(mime.attachments[0].filename).toBe('doc.pdf');
    expect(mime.attachments[0].contentType).toBe('application/pdf');
    expect(mime.attachments[0].sizeBytes).toBe(Buffer.byteLength('PDFDATA'));
  });

  it('decodes base64 and quoted-printable transfer encodings', () => {
    expect(decodeTransferEncoding(Buffer.from('café').toString('base64'), 'base64')).toBe('café');
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
  });

  it('decodes encoded words (B and Q)', () => {
    expect(decodeMimeWords('=?UTF-8?B?aGVsbG8=?=')).toBe('hello');
    expect(decodeMimeWords('=?UTF-8?Q?a=20b?=')).toBe('a b');
  });
});

describe('stripHtml / collapseWhitespace', () => {
  it('strips tags and decodes entities', () => {
    expect(collapseWhitespace(stripHtml('<div>a&amp;b&nbsp;c</div>'))).toBe('a&b c');
  });
});

describe('parseFetchSummaries', () => {
  it('parses FETCH lines into envelope summaries with unread flag', () => {
    const lines = [
      '* 1 FETCH (UID 10 FLAGS (\\Seen) ENVELOPE ("date" "Subject A" (("A" NIL "a" "x.com")) NIL NIL NIL NIL NIL NIL "<a@x.com>"))',
      '* 2 FETCH (UID 11 FLAGS () ENVELOPE ("date" "Subject B" (("B" NIL "b" "x.com")) NIL NIL NIL NIL NIL NIL "<b@x.com>"))',
    ];
    const summaries = parseFetchSummaries(lines);
    expect(summaries.length).toBe(2);
    expect(summaries[0].uid).toBe(10);
    expect(summaries[0].unread).toBe(false); // \\Seen present
    expect(summaries[0].subject).toBe('Subject A');
    expect(summaries[1].unread).toBe(true); // no \\Seen
    expect(summaries[1].messageId).toBe('<b@x.com>');
  });
});

describe('parseFullMessage', () => {
  it('parses a full BODY[] literal into a structured message', () => {
    const body = 'From: jane@x.com\r\nSubject: Hi\r\nMessage-ID: <m@x.com>\r\nContent-Type: text/plain\r\n\r\nFull body text';
    const block = `* 1 FETCH (UID 5 BODY[] {${body.length}}\n${body})`;
    const msg = parseFullMessage(5, [block]);
    expect(msg).not.toBeNull();
    expect(msg!.uid).toBe(5);
    expect(msg!.bodyText).toBe('Full body text');
    expect(msg!.from).toBe('jane@x.com');
    expect(msg!.messageId).toBe('<m@x.com>');
  });

  it('returns null when the UID does not match', () => {
    const body = 'Subject: x\r\n\r\nbody';
    const block = `* 1 FETCH (UID 9 BODY[] {${body.length}}\n${body})`;
    expect(parseFullMessage(5, [block])).toBeNull();
  });
});

// ===========================================================================
// Live protocol tests against an in-process mock IMAP server
// ===========================================================================

interface MockImapServer {
  server: Server;
  port: number;
  /** Commands received (tag stripped), in order. */
  commands: string[];
}

/**
 * A minimal scripted IMAP server. It understands LOGIN, EXAMINE, SELECT, CREATE,
 * UID SEARCH, UID FETCH, APPEND, and LOGOUT well enough to exercise the
 * connector. It records every command line so tests can assert (e.g.) that
 * EXAMINE + BODY.PEEK were used (no implicit \\Seen).
 */
function startMockImapServer(): Promise<MockImapServer> {
  const commands: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf-8');
    socket.write('* OK IMAP4rev1 mock ready\r\n');
    let buffer = '';
    let appendPending: { tag: string; remaining: number } | null = null;

    socket.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (;;) {
        if (appendPending) {
          if (buffer.length < appendPending.remaining) return;
          buffer = buffer.slice(appendPending.remaining);
          // Trailing CRLF after the literal.
          buffer = buffer.replace(/^\r\n/, '');
          socket.write(`${appendPending.tag} OK [APPENDUID 1 77] APPEND completed\r\n`);
          appendPending = null;
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const spaceIdx = line.indexOf(' ');
        const tag = line.slice(0, spaceIdx);
        const rest = line.slice(spaceIdx + 1);
        commands.push(rest);
        const upper = rest.toUpperCase();

        if (upper.startsWith('LOGIN')) {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else if (upper.startsWith('EXAMINE')) {
          socket.write('* 3 EXISTS\r\n');
          socket.write(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        } else if (upper.startsWith('SELECT')) {
          socket.write('* 3 EXISTS\r\n');
          socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (upper.startsWith('CREATE')) {
          socket.write(`${tag} NO mailbox already exists\r\n`);
        } else if (upper.startsWith('UID SEARCH')) {
          socket.write('* SEARCH 10 11\r\n');
          socket.write(`${tag} OK SEARCH completed\r\n`);
        } else if (upper.startsWith('UID FETCH')) {
          if (upper.includes('BODY.PEEK[]')) {
            const body = 'From: jane@x.com\r\nSubject: Full\r\nMessage-ID: <full@x.com>\r\nContent-Type: text/plain\r\n\r\nFull message body';
            socket.write(`* 1 FETCH (UID 10 ENVELOPE ("date" "Full" (("Jane" NIL "jane" "x.com")) NIL NIL NIL NIL NIL NIL "<full@x.com>") BODY[] {${body.length}}\r\n${body})\r\n`);
          } else {
            const preview = 'Preview text';
            socket.write(`* 1 FETCH (UID 10 FLAGS () ENVELOPE ("date" "Subject A" (("A" NIL "a" "x.com")) NIL NIL NIL NIL NIL NIL "<a@x.com>") BODY[TEXT]<0> {${preview.length}}\r\n${preview})\r\n`);
            const preview2 = 'Second preview';
            socket.write(`* 2 FETCH (UID 11 FLAGS (\\Seen) ENVELOPE ("date" "Subject B" (("B" NIL "b" "x.com")) NIL NIL NIL NIL NIL NIL "<b@x.com>") BODY[TEXT]<0> {${preview2.length}}\r\n${preview2})\r\n`);
          }
          socket.write(`${tag} OK FETCH completed\r\n`);
        } else if (upper.startsWith('APPEND')) {
          const literalMatch = /\{(\d+)\}$/.exec(rest);
          const octets = literalMatch ? Number(literalMatch[1]) : 0;
          appendPending = { tag, remaining: octets };
          socket.write('+ Ready for literal data\r\n');
        } else if (upper.startsWith('LOGOUT')) {
          socket.write('* BYE logging out\r\n');
          socket.write(`${tag} OK LOGOUT completed\r\n`);
        } else {
          socket.write(`${tag} BAD unknown command\r\n`);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, commands });
    });
  });
}

let activeServer: MockImapServer | null = null;

afterEach(() => {
  if (activeServer) {
    activeServer.server.close();
    activeServer = null;
  }
});

function makeConnector(port: number): ImapConnector {
  return new ImapConnector({
    host: '127.0.0.1',
    port,
    user: 'user@x.com',
    password: 'secret-pass',
    secure: false,
    mailbox: 'INBOX',
    draftsMailbox: 'Drafts',
    timeoutMs: 5000,
  });
}

describe('ImapConnector live protocol', () => {
  it('connects, logs in, and lists messages via EXAMINE (read-only, no \\Seen)', async () => {
    activeServer = await startMockImapServer();
    const imap = makeConnector(activeServer.port);
    await imap.connect();
    const messages = await imap.listMessages({ limit: 10, unreadOnly: true });
    await imap.close();

    expect(messages.length).toBe(2);
    // Most-recent-first ordering (UID 11 then 10).
    expect(messages[0].uid).toBe(11);
    expect(messages[1].uid).toBe(10);
    expect(messages.find((m) => m.uid === 11)!.unread).toBe(false); // \\Seen
    expect(messages.find((m) => m.uid === 10)!.unread).toBe(true);
    expect(messages[1].bodyPreview).toBe('Preview text');

    // Read posture assertions: EXAMINE (not SELECT) + BODY.PEEK (never BODY[ without PEEK on list).
    const cmds = activeServer.commands.join('\n');
    expect(cmds).toContain('EXAMINE');
    expect(cmds.toUpperCase()).toContain('BODY.PEEK');
    expect(activeServer.commands.some((c) => /^SELECT/i.test(c))).toBe(false);
  });

  it('reads a full message body with BODY.PEEK[] (does not mark read)', async () => {
    activeServer = await startMockImapServer();
    const imap = makeConnector(activeServer.port);
    await imap.connect();
    const message = await imap.readMessage(10);
    await imap.close();

    expect(message.uid).toBe(10);
    expect(message.bodyText).toBe('Full message body');
    expect(message.from).toBe('Jane <jane@x.com>');
    expect(message.messageId).toBe('<full@x.com>');
    const fetchCmd = activeServer.commands.find((c) => /UID FETCH/i.test(c))!;
    expect(fetchCmd.toUpperCase()).toContain('BODY.PEEK[]');
  });

  it('appends a draft and returns the APPENDUID', async () => {
    activeServer = await startMockImapServer();
    const imap = makeConnector(activeServer.port);
    await imap.connect();
    const result = await imap.appendDraft('From: a@x.com\r\nSubject: Draft\r\n\r\nDraft body');
    await imap.close();

    expect(result.uid).toBe(77);
    expect(result.mailbox).toBe('Drafts');
    // CREATE attempted, SELECT used for the Drafts mailbox.
    expect(activeServer.commands.some((c) => /^SELECT/i.test(c))).toBe(true);
    expect(activeServer.commands.some((c) => /^APPEND/i.test(c))).toBe(true);
  });

  it('throws IMAP_NOT_FOUND when the requested UID is not returned', async () => {
    activeServer = await startMockImapServer();
    const imap = makeConnector(activeServer.port);
    await imap.connect();
    // The mock only ever returns UID 10 for BODY.PEEK[]; request a different UID.
    await expect(imap.readMessage(99)).rejects.toMatchObject({ code: 'IMAP_NOT_FOUND' });
    await imap.close();
  });
});

describe('ImapConnector validation', () => {
  it('throws on missing required settings', () => {
    expect(() => new ImapConnector({ host: '', port: 1, user: 'u', password: 'p', secure: false })).toThrow(ImapError);
    expect(() => new ImapConnector({ host: 'h', port: 1, user: '', password: 'p', secure: false })).toThrow(ImapError);
    expect(() => new ImapConnector({ host: 'h', port: 1, user: 'u', password: '', secure: false })).toThrow(ImapError);
  });

  it('rejects an invalid UID before any network call', async () => {
    const imap = makeConnector(1);
    await expect(imap.readMessage(0)).rejects.toMatchObject({ code: 'IMAP_BAD_UID' });
  });
});
