import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import {
  SmtpConnector,
  SmtpError,
  buildRfc5322Message,
  dotStuff,
  encodeHeaderValue,
  encodeQuotedPrintable,
  extractAddress,
  extractCompleteReply,
  formatRfc2822Date,
  generateMessageId,
  parseRecipients,
} from '../../../daemon/email/smtp-connector.ts';

// ===========================================================================
// Pure helper unit tests
// ===========================================================================

describe('extractCompleteReply', () => {
  it('returns null for an incomplete reply', () => {
    expect(extractCompleteReply('250-first\r\n')).toBeNull();
  });
  it('parses a single-line reply', () => {
    const r = extractCompleteReply('250 OK\r\n');
    expect(r).not.toBeNull();
    expect(r!.code).toBe(250);
    expect(r!.consumed).toBe('250 OK\r\n'.length);
  });
  it('parses a multi-line reply (continuation then terminal)', () => {
    const buf = '250-mail.example.com\r\n250-PIPELINING\r\n250 AUTH PLAIN LOGIN\r\n';
    const r = extractCompleteReply(buf);
    expect(r!.code).toBe(250);
    expect(r!.lines.length).toBe(3);
    expect(r!.consumed).toBe(buf.length);
  });
});

describe('extractAddress / parseRecipients', () => {
  it('extracts a bare address from a display-named header', () => {
    expect(extractAddress('Jane Doe <jane@x.com>')).toBe('jane@x.com');
    expect(extractAddress('bob@y.com')).toBe('bob@y.com');
  });
  it('parses a comma-separated recipient list', () => {
    expect(parseRecipients('a@x.com, Bob <b@y.com>, invalid')).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('dotStuff', () => {
  it('doubles a leading dot on each line', () => {
    expect(dotStuff('.hidden\r\nnormal\r\n.again')).toBe('..hidden\r\nnormal\r\n..again');
  });
  it('leaves non-dot lines untouched', () => {
    expect(dotStuff('hello\r\nworld')).toBe('hello\r\nworld');
  });
});

describe('encodeQuotedPrintable', () => {
  it('encodes non-ASCII bytes', () => {
    expect(encodeQuotedPrintable('café')).toBe('caf=C3=A9');
  });
  it('encodes the equals sign', () => {
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db');
  });
  it('preserves ASCII and normalizes newlines to CRLF', () => {
    expect(encodeQuotedPrintable('line1\nline2')).toBe('line1\r\nline2');
  });
  it('keeps interior whitespace literal', () => {
    // Spaces/tabs that are NOT before a line break or EOF stay literal.
    expect(encodeQuotedPrintable('a b\tc')).toBe('a b\tc');
  });
  it('encodes a trailing space before a hard line break as =20 (RFC 2045 §6.7 rule 3)', () => {
    // A literal trailing space before CRLF may be stripped by an MTA; it MUST
    // be encoded so the message round-trips intact.
    expect(encodeQuotedPrintable('hello \nworld')).toBe('hello=20\r\nworld');
  });
  it('encodes a trailing tab before a hard line break as =09', () => {
    expect(encodeQuotedPrintable('hello\t\nworld')).toBe('hello=09\r\nworld');
  });
  it('encodes whitespace at the very end of the body', () => {
    // No newline follows — the body simply ends with whitespace, which still
    // must be encoded so it is not silently dropped in transit.
    expect(encodeQuotedPrintable('trailing space ')).toBe('trailing space=20');
    expect(encodeQuotedPrintable('trailing tab\t')).toBe('trailing tab=09');
  });
  it('encodes only the whitespace immediately before the break, not interior runs', () => {
    // 'a  ' has two spaces: the first is interior (literal), the second abuts
    // the line break and must be encoded.
    expect(encodeQuotedPrintable('a  \nb')).toBe('a =20\r\nb');
  });
  it('soft-wraps long lines at 76 columns with a trailing = and never splits an escape', () => {
    // 200 ASCII characters with no newline must be broken into soft-wrapped
    // segments. Each emitted line (split on CRLF) must be <= 76 chars, and a
    // wrapped line must end with the '=' soft break.
    const body = 'x'.repeat(200);
    const encoded = encodeQuotedPrintable(body);
    const lines = encoded.split('\r\n');
    // The soft wrap actually fired: more than one physical line was produced.
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    // Every line except the last is a soft-wrapped continuation ending in '='.
    for (let i = 0; i < lines.length - 1; i += 1) {
      expect(lines[i].endsWith('=')).toBe(true);
      // 75 content chars + the '=' soft break == the 76-column maximum.
      expect(lines[i].length).toBe(76);
    }
    // Decoding (strip soft breaks) recovers the original payload exactly.
    expect(encoded.replace(/=\r\n/g, '')).toBe(body);
  });
  it('does not split an =XX escape across a soft-wrap boundary', () => {
    // Fill a line so the next escape sequence would straddle column 75, forcing
    // the wrap to occur BEFORE the '=' rather than inside the escape.
    const body = 'x'.repeat(74) + 'é'; // 'é' encodes to =C3=A9 (multi-byte)
    const encoded = encodeQuotedPrintable(body);
    // No physical line may contain a truncated escape (a '=' with fewer than
    // two hex digits before the soft break, other than the soft break itself).
    for (const line of encoded.split('\r\n')) {
      // Strip a legitimate trailing soft-break '=' before inspecting.
      const content = line.endsWith('=') ? line.slice(0, -1) : line;
      // Any remaining '=' must be followed by exactly two hex digits.
      expect(/=(?![0-9A-F]{2})/.test(content)).toBe(false);
    }
  });
});

describe('encodeHeaderValue', () => {
  it('passes ASCII through unchanged', () => {
    expect(encodeHeaderValue('Hello World')).toBe('Hello World');
  });
  it('RFC 2047 base64-encodes non-ASCII', () => {
    expect(encodeHeaderValue('café')).toBe('=?UTF-8?B?Y2Fmw6k=?=');
  });
});

describe('formatRfc2822Date', () => {
  it('formats a date with +0000 offset', () => {
    const d = new Date('2026-03-04T10:05:06.000Z');
    expect(formatRfc2822Date(d)).toBe('Wed, 04 Mar 2026 10:05:06 +0000');
  });
});

describe('generateMessageId', () => {
  it('uses the from domain and is angle-wrapped', () => {
    const id = generateMessageId('Jane <jane@example.com>');
    expect(id.startsWith('<')).toBe(true);
    expect(id.endsWith('>')).toBe(true);
    expect(id).toContain('@example.com');
  });
});

describe('buildRfc5322Message', () => {
  it('builds headers and a quoted-printable body', () => {
    const raw = buildRfc5322Message({
      from: 'jane@x.com',
      to: 'bob@y.com',
      subject: 'Hi café',
      body: 'Hello café',
      messageId: '<id@x.com>',
      date: new Date('2026-03-04T10:05:06.000Z'),
      inReplyTo: '<prev@x.com>',
      references: '<root@x.com>',
    });
    expect(raw).toContain('From: jane@x.com');
    expect(raw).toContain('To: bob@y.com');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('In-Reply-To: <prev@x.com>');
    expect(raw).toContain('References: <root@x.com>');
    expect(raw).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(raw).toContain('Hello caf=C3=A9');
  });
});

// ===========================================================================
// Live protocol tests against an in-process mock SMTP server
// ===========================================================================

interface MockSmtpServer {
  server: Server;
  port: number;
  commands: string[];
  dataPayload: string;
}

interface MockSmtpOptions {
  /** Which AUTH mechanism to advertise. 'NONE' omits the AUTH line entirely. */
  authMech?: 'PLAIN' | 'LOGIN' | 'NONE';
  /** Reject RCPT TO with a 550 (mailbox unavailable) to exercise error mapping. */
  failRcpt?: boolean;
  /** Reject AUTH with a 535 (bad credentials) to exercise error mapping. */
  failAuth?: boolean;
}

// The real STARTTLS upgrade happy-path is exercised by a sibling Node runner
// (starttls-upgrade.node-runner.ts) rather than this in-process mock: Bun 1.3.x
// cannot complete an in-place net.Socket->TLS upgrade, while Node can. See that
// file's header for detail. This in-process mock therefore never advertises
// STARTTLS, which is exactly what the SMTP_NO_STARTTLS default-deny test needs.

/**
 * A minimal scripted SMTP server supporting EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT,
 * DATA and QUIT. Records command lines and the DATA payload for assertions. It
 * never advertises STARTTLS; the real STARTTLS upgrade path is covered by the
 * sibling Node runner (see note above). `failAuth`/`failRcpt` exercise the
 * connector's protocol error mapping; `authMech: 'NONE'` exercises SMTP_NO_AUTH.
 */
function startMockSmtpServer(opts?: MockSmtpOptions): Promise<MockSmtpServer> {
  const authMech = opts?.authMech ?? 'PLAIN';
  const failRcpt = opts?.failRcpt ?? false;
  const failAuth = opts?.failAuth ?? false;
  const state = { commands: [] as string[], dataPayload: '' };

  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf-8');
    socket.write('220 mock.smtp ESMTP ready\r\n');
    let buffer = '';
    let inData = false;
    let loginStep = 0; // 0=none, 1=awaiting username, 2=awaiting password

    socket.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK queued as ABC123\r\n');
          } else {
            state.dataPayload += line + '\r\n';
          }
          continue;
        }

        state.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-mock.smtp\r\n');
          socket.write('250-PIPELINING\r\n');
          if (authMech === 'NONE') {
            socket.write('250 8BITMIME\r\n');
          } else {
            socket.write(`250 AUTH ${authMech}\r\n`);
          }
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write(failAuth ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 Authentication successful\r\n');
        } else if (upper === 'AUTH LOGIN') {
          loginStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n'); // 'Username:'
        } else if (loginStep === 1) {
          loginStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n'); // 'Password:'
        } else if (loginStep === 2) {
          loginStep = 0;
          socket.write(failAuth ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write(failRcpt ? '550 5.1.1 No such recipient\r\n' : '250 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CRLF>.<CRLF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('500 unrecognized\r\n');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        get commands() { return state.commands; },
        get dataPayload() { return state.dataPayload; },
      } as MockSmtpServer);
    });
  });
}

let activeServer: MockSmtpServer | null = null;

afterEach(() => {
  if (activeServer) {
    activeServer.server.close();
    activeServer = null;
  }
});

function makeConnector(port: number): SmtpConnector {
  return new SmtpConnector({
    host: '127.0.0.1',
    port,
    user: 'user@x.com',
    password: 'secret-pass',
    secure: false,
    from: 'Sender <sender@x.com>',
    timeoutMs: 5000,
    allowPlaintext: true,
  });
}

/**
 * A connector representing the secure default posture (port 587 style): plain
 * connect that MUST upgrade via STARTTLS, with allowPlaintext disabled so an
 * un-upgradable server is rejected rather than sending credentials in clear.
 */
function makeSecureConnector(port: number): SmtpConnector {
  return new SmtpConnector({
    host: '127.0.0.1',
    port,
    user: 'user@x.com',
    password: 'secret-pass',
    secure: false,
    from: 'Sender <sender@x.com>',
    timeoutMs: 5000,
    allowPlaintext: false,
  });
}

describe('SmtpConnector live protocol', () => {
  it('completes a full AUTH PLAIN send flow and returns a receipt', async () => {
    activeServer = await startMockSmtpServer({ authMech: 'PLAIN' });
    const smtp = makeConnector(activeServer.port);
    await smtp.connect();
    const result = await smtp.send({
      to: 'Bob <bob@y.com>, carol@z.com',
      subject: 'Test',
      body: 'Hello there',
    });
    await smtp.close();

    expect(result.messageId).toContain('@x.com');
    expect(typeof result.sentAt).toBe('string');
    expect(Number.isNaN(new Date(result.sentAt).getTime())).toBe(false);

    const cmds = activeServer.commands.join('\n');
    expect(cmds).toContain('EHLO');
    expect(cmds).toContain('AUTH PLAIN');
    expect(cmds).toContain('MAIL FROM:<sender@x.com>');
    expect(cmds).toContain('RCPT TO:<bob@y.com>');
    expect(cmds).toContain('RCPT TO:<carol@z.com>');
    expect(cmds).toContain('DATA');
    // The DATA payload carries the message, never the password.
    expect(activeServer.dataPayload).toContain('Subject: Test');
    expect(activeServer.dataPayload).toContain('Hello there');
    expect(activeServer.dataPayload.includes('secret-pass')).toBe(false);
  });

  it('dot-stuffs a body line that begins with "." end-to-end on the wire', async () => {
    // Real bug-class coverage: the unit test for dotStuff() proves the helper in
    // isolation, but this asserts the byte stream the mock server actually
    // receives after QP encoding + CRLF normalization + dot-stuffing in send().
    activeServer = await startMockSmtpServer({ authMech: 'PLAIN' });
    const smtp = makeConnector(activeServer.port);
    await smtp.connect();
    await smtp.send({
      to: 'bob@y.com',
      subject: 'Dot test',
      // A body whose FIRST line starts with '.', plus an interior line that also
      // starts with '.', both of which must be dot-stuffed ("." -> "..").
      body: '.leading dot\nplain line\n.another dotted line',
    });
    await smtp.close();

    const payload = activeServer.dataPayload;
    // The mock records DATA lines verbatim (only a bare '.' terminates), so a
    // correctly stuffed body line appears with a doubled leading dot.
    expect(payload).toContain('..leading dot\r\n');
    expect(payload).toContain('..another dotted line\r\n');
    // The interior non-dot line is untouched, and no real content was eaten by
    // the terminator (a single leading-dot line never collapses to a bare '.').
    expect(payload).toContain('plain line\r\n');
    expect(payload.includes('\r\n.leading dot')).toBe(false);
  });

  it('completes an AUTH LOGIN flow', async () => {
    activeServer = await startMockSmtpServer({ authMech: 'LOGIN' });
    const smtp = makeConnector(activeServer.port);
    await smtp.connect();
    const result = await smtp.send({ to: 'bob@y.com', subject: 'S', body: 'B' });
    await smtp.close();
    expect(result.messageId).toContain('@');
    expect(activeServer.commands).toContain('AUTH LOGIN');
  });

  it('rejects when no recipients are valid', async () => {
    activeServer = await startMockSmtpServer();
    const smtp = makeConnector(activeServer.port);
    await smtp.connect();
    await expect(smtp.send({ to: 'not-an-address', subject: 'S', body: 'B' })).rejects.toMatchObject({
      code: 'SMTP_NO_RCPT',
    });
    await smtp.close();
  });

  // The real STARTTLS upgrade happy-path (STARTTLS -> live TLS handshake ->
  // re-EHLO -> AUTH -> send) runs in a Node subprocess because Bun 1.3.x cannot
  // complete an in-place net.Socket->TLS upgrade. The runner drives the actual
  // SmtpConnector against a mock server that performs a genuine TLS handshake
  // and exits 0 only when every protocol assertion passes.
  const nodeBin = (globalThis as { Bun?: { which(c: string): string | null } }).Bun?.which('node') ?? null;
  const upgradeRunner = new URL('./starttls-upgrade.node-runner.ts', import.meta.url).pathname;
  const canRunUpgrade = nodeBin !== null && existsSync(upgradeRunner);

  it.skipIf(!canRunUpgrade)(
    'upgrades the connection via STARTTLS and re-EHLOs over the secure channel (Node runner)',
    async () => {
      const proc = Bun.spawn([nodeBin as string, upgradeRunner], {
        // The mock presents a self-signed cert the connector does not pin; relax
        // verification for the child only so the real handshake completes.
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`STARTTLS upgrade runner failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
      }
      expect(stdout).toContain('STARTTLS_UPGRADE_OK');
    },
  );

  it('rejects (default-deny) when STARTTLS is not advertised and plaintext is disallowed', async () => {
    // The mock never advertises STARTTLS; the secure-posture connector
    // (allowPlaintext:false) must refuse rather than send credentials in clear.
    activeServer = await startMockSmtpServer({ authMech: 'PLAIN' });
    const smtp = makeSecureConnector(activeServer.port);
    await expect(smtp.connect()).rejects.toMatchObject({ code: 'SMTP_NO_STARTTLS' });
    await smtp.close();
  });

  it('maps a server AUTH rejection (535) to SMTP_535', async () => {
    activeServer = await startMockSmtpServer({ authMech: 'PLAIN', failAuth: true });
    const smtp = makeConnector(activeServer.port);
    await expect(smtp.connect()).rejects.toMatchObject({ code: 'SMTP_535' });
    await smtp.close();
  });

  it('throws SMTP_NO_AUTH when the server advertises no supported mechanism', async () => {
    activeServer = await startMockSmtpServer({ authMech: 'NONE' });
    const smtp = makeConnector(activeServer.port);
    await expect(smtp.connect()).rejects.toMatchObject({ code: 'SMTP_NO_AUTH' });
    await smtp.close();
  });

  it('maps a server RCPT rejection (550) to SMTP_550', async () => {
    activeServer = await startMockSmtpServer({ authMech: 'PLAIN', failRcpt: true });
    const smtp = makeConnector(activeServer.port);
    await smtp.connect();
    await expect(smtp.send({ to: 'bob@y.com', subject: 'S', body: 'B' })).rejects.toMatchObject({
      code: 'SMTP_550',
    });
    await smtp.close();
  });
});

/**
 * A server that emits the 220 greeting then goes silent, never answering EHLO.
 * This forces a readReply() to block until the connector's armTimeout() fires,
 * exercising the mid-reply timeout path.
 */
function startStallingSmtpServer(): Promise<MockSmtpServer> {
  const state = { commands: [] as string[], dataPayload: '' };
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf-8');
    socket.write('220 mock.smtp ESMTP ready\r\n');
    // Deliberately never respond to any subsequent command (e.g. EHLO).
    socket.on('data', () => { /* swallow, stay silent */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        get commands() { return state.commands; },
        get dataPayload() { return state.dataPayload; },
      } as MockSmtpServer);
    });
  });
}

function makeFastTimeoutConnector(port: number): SmtpConnector {
  return new SmtpConnector({
    host: '127.0.0.1',
    port,
    user: 'user@x.com',
    password: 'secret-pass',
    secure: false,
    from: 'Sender <sender@x.com>',
    timeoutMs: 150,
    allowPlaintext: true,
  });
}

describe('SmtpConnector timeout', () => {
  it('surfaces SMTP_TIMEOUT (not SMTP_CLOSED) when a reply stalls mid-readReply', async () => {
    activeServer = await startStallingSmtpServer();
    const smtp = makeFastTimeoutConnector(activeServer.port);
    // connect() reads the 220 greeting, then sends EHLO and blocks in readReply
    // until armTimeout() destroys the socket. The destroy reason must propagate
    // as SMTP_TIMEOUT rather than being masked by the 'closed' SMTP_CLOSED branch.
    await expect(smtp.connect()).rejects.toMatchObject({ code: 'SMTP_TIMEOUT' });
    await smtp.close();
  });
});

describe('SmtpConnector validation', () => {
  it('throws on missing required settings', () => {
    const base = { host: 'h', port: 1, user: 'u', password: 'p', secure: false, from: 'f@x.com' };
    expect(() => new SmtpConnector({ ...base, host: '' })).toThrow(SmtpError);
    expect(() => new SmtpConnector({ ...base, user: '' })).toThrow(SmtpError);
    expect(() => new SmtpConnector({ ...base, password: '' })).toThrow(SmtpError);
    expect(() => new SmtpConnector({ ...base, from: '' })).toThrow(SmtpError);
  });
});
