// ---------------------------------------------------------------------------
// Daemon-owned SMTP connector.
//
// A dependency-free SMTP client built on node:tls / node:net (Bun-compatible).
// Supports implicit TLS (port 465), STARTTLS upgrade (port 587/25), and
// AUTH LOGIN / AUTH PLAIN. The daemon owns this connector outright — it does
// NOT import any agent code. Credentials are supplied by the caller (resolved
// from the daemon credential store) and are never logged.
// ---------------------------------------------------------------------------

import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

export interface SmtpConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** Implicit TLS (port 465). When false, STARTTLS is attempted on plain socket. */
  readonly secure: boolean;
  /** Envelope + From header address. */
  readonly from: string;
  /** EHLO domain. Defaults to the host portion of `from` or 'localhost'. */
  readonly ehloDomain?: string;
  /** Command timeout in ms. Defaults to 30000. */
  readonly timeoutMs?: number;
  /**
   * Permit sending over a plaintext channel when `secure` is false and the
   * server does not advertise STARTTLS (trusted local relays only). Defaults to
   * false: an un-upgradable plaintext connection is rejected to avoid sending
   * credentials in the clear.
   */
  readonly allowPlaintext?: boolean;
}

export interface SmtpMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  /** Optional explicit Message-ID; one is generated when omitted. */
  readonly messageId?: string;
  /** Optional explicit Date; current time used when omitted. */
  readonly date?: Date;
}

export interface SmtpSendResult {
  readonly messageId: string;
  readonly sentAt: string; // ISO-8601
}

export class SmtpError extends Error {
  readonly code: string;
  constructor(message: string, code = 'SMTP_ERROR') {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
  }
}

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 30_000;

type AnySocket = Socket | TLSSocket;

/**
 * Build the TLS SNI option for a host. Node forbids setting `servername` to an
 * IP literal (ERR_INVALID_ARG_VALUE), so SNI is omitted for IPv4/IPv6 hosts and
 * supplied only for DNS names — which is exactly the case where SNI matters.
 */
function sniOptions(host: string): { servername?: string } {
  return isIpLiteral(host) ? {} : { servername: host };
}

/** True when `host` is a bare IPv4 or IPv6 literal (not a DNS hostname). */
function isIpLiteral(host: string): boolean {
  // IPv6 contains a colon; IPv4 is four dot-separated decimal octets.
  if (host.includes(':')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export class SmtpConnector {
  private socket: AnySocket | null = null;
  private buffer = '';
  private dataWaiters: Array<() => void> = [];
  private closed = false;
  /**
   * When the connection is torn down by a timeout (or other socket error), the
   * triggering SmtpError is recorded here so that readers blocked in readReply()
   * surface the real cause (e.g. SMTP_TIMEOUT) instead of a generic SMTP_CLOSED.
   */
  private closeReason: SmtpError | null = null;
  private capabilities = new Set<string>();
  private readonly settings: SmtpConnectionSettings;
  private readonly timeoutMs: number;

  constructor(settings: SmtpConnectionSettings) {
    if (!settings.host) throw new SmtpError('SMTP host is required', 'SMTP_CONFIG');
    if (!settings.user) throw new SmtpError('SMTP user is required', 'SMTP_CONFIG');
    if (!settings.password) throw new SmtpError('SMTP password is required', 'SMTP_CONFIG');
    if (!settings.from) throw new SmtpError('SMTP from address is required', 'SMTP_CONFIG');
    this.settings = settings;
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    const { host, port, secure } = this.settings;
    const socket: AnySocket = secure
      ? (tlsConnect({ host, port, ...sniOptions(host) }) as TLSSocket)
      : new Socket();
    this.attach(socket);
    if (secure) {
      await this.waitForEvent(socket, 'secureConnect');
    } else {
      (socket as Socket).connect({ host, port });
      await this.waitForEvent(socket, 'connect');
    }
    // Greeting (220).
    await this.expect([220]);
    await this.ehlo();
    if (!secure) {
      await this.startTls();
    }
    await this.authenticate();
  }

  private attach(socket: AnySocket): void {
    socket.setEncoding('utf-8');
    socket.setTimeout(this.timeoutMs);
    this.socket = socket;
    this.buffer = '';
    socket.on('data', (chunk: string | Buffer) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.flushWaiters();
    });
    socket.on('timeout', () => {
      // Node's socket-level idle timeout fires no callback on its own; wiring
      // this handler turns the setTimeout() above into real behavior. Destroying
      // with an SmtpError routes through the 'error' handler, which records the
      // close reason so blocked readers see SMTP_TIMEOUT.
      socket.destroy(new SmtpError('SMTP socket timed out', 'SMTP_TIMEOUT'));
    });
    socket.on('close', () => { this.closed = true; this.flushWaiters(); });
    socket.on('error', (err: Error) => {
      this.closed = true;
      if (!this.closeReason && err instanceof SmtpError) this.closeReason = err;
      this.flushWaiters();
    });
  }

  private async waitForEvent(socket: AnySocket, eventName: string): Promise<void> {
    const timer = this.armTimeout(`Timed out waiting for ${eventName}`);
    try {
      await once(socket, eventName);
    } finally {
      clearTimeout(timer);
    }
  }

  private armTimeout(message: string): NodeJS.Timeout {
    return setTimeout(() => {
      this.closed = true;
      const reason = new SmtpError(message, 'SMTP_TIMEOUT');
      // Record the reason before destroy() so the synchronous 'error' handler and
      // any reader re-evaluating `this.closed` observe SMTP_TIMEOUT, not SMTP_CLOSED.
      if (!this.closeReason) this.closeReason = reason;
      if (this.socket) this.socket.destroy(reason);
      this.flushWaiters();
    }, this.timeoutMs);
  }

  async close(): Promise<void> {
    if (!this.closed && this.socket) {
      try {
        await this.command('QUIT', [221]);
      } catch {
        // best-effort
      }
    }
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.destroy();
    }
    this.socket = null;
    this.closed = true;
  }

  // -------------------------------------------------------------------------
  // Wire I/O
  // -------------------------------------------------------------------------

  private write(line: string): void {
    if (!this.socket || this.closed) {
      throw new SmtpError('SMTP socket is not connected', 'SMTP_CLOSED');
    }
    this.socket.write(line);
  }

  private flushWaiters(): void {
    const waiters = this.dataWaiters;
    this.dataWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForData(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => { this.dataWaiters.push(resolve); });
  }

  /** Read a complete multi-line SMTP reply (handles `250-` continuations). */
  private async readReply(): Promise<{ code: number; lines: string[] }> {
    const timer = this.armTimeout('Timed out waiting for SMTP reply');
    try {
      for (;;) {
        const complete = extractCompleteReply(this.buffer);
        if (complete) {
          this.buffer = this.buffer.slice(complete.consumed);
          return { code: complete.code, lines: complete.lines };
        }
        if (this.closed) {
          throw this.closeReason ?? new SmtpError('Connection closed during reply', 'SMTP_CLOSED');
        }
        await this.waitForData();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async expect(codes: number[]): Promise<{ code: number; lines: string[] }> {
    const reply = await this.readReply();
    if (!codes.includes(reply.code)) {
      throw new SmtpError(
        `Unexpected SMTP reply ${reply.code}: ${reply.lines.join(' ')}`,
        `SMTP_${reply.code}`,
      );
    }
    return reply;
  }

  private async command(line: string, expectCodes: number[]): Promise<{ code: number; lines: string[] }> {
    this.write(line + CRLF);
    return this.expect(expectCodes);
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  private ehloName(): string {
    if (this.settings.ehloDomain) return this.settings.ehloDomain;
    const at = this.settings.from.indexOf('@');
    if (at >= 0) {
      const domain = this.settings.from.slice(at + 1).replace(/>.*/, '').trim();
      if (domain) return domain;
    }
    return 'localhost';
  }

  private async ehlo(): Promise<void> {
    const reply = await this.command(`EHLO ${this.ehloName()}`, [250]);
    this.capabilities = new Set(
      reply.lines.map((l) => l.replace(/^\d{3}[ -]/, '').trim().toUpperCase()),
    );
  }

  private async startTls(): Promise<void> {
    if (!this.hasCapability('STARTTLS')) {
      if (this.settings.allowPlaintext) return; // Trusted local relay; stay plaintext.
      throw new SmtpError('SMTP server does not advertise STARTTLS', 'SMTP_NO_STARTTLS');
    }
    await this.command('STARTTLS', [220]);
    const plain = this.socket as Socket;
    // Remove ALL listeners attached by attach() (data, close, error) before the
    // upgrade. The plain socket becomes the underlying socket of the TLSSocket;
    // any stale 'close'/'error' handlers left here could fire post-upgrade and
    // erroneously set this.closed = true or double-flush waiters, corrupting
    // connection state mid-session.
    plain.removeAllListeners();
    const upgraded = tlsConnect({ socket: plain, ...sniOptions(this.settings.host) }) as TLSSocket;
    this.attach(upgraded);
    await this.waitForEvent(upgraded, 'secureConnect');
    // Re-issue EHLO over the secure channel.
    await this.ehlo();
  }

  private hasCapability(name: string): boolean {
    const upper = name.toUpperCase();
    for (const cap of this.capabilities) {
      if (cap === upper || cap.startsWith(`${upper} `)) return true;
    }
    return false;
  }

  private async authenticate(): Promise<void> {
    const { user, password } = this.settings;
    if (this.authMechanism('PLAIN')) {
      const token = Buffer.from(` ${user} ${password}`, 'utf-8').toString('base64');
      await this.command(`AUTH PLAIN ${token}`, [235]);
      return;
    }
    if (this.authMechanism('LOGIN')) {
      await this.command('AUTH LOGIN', [334]);
      await this.command(Buffer.from(user, 'utf-8').toString('base64'), [334]);
      await this.command(Buffer.from(password, 'utf-8').toString('base64'), [235]);
      return;
    }
    throw new SmtpError('No supported SMTP AUTH mechanism (PLAIN/LOGIN)', 'SMTP_NO_AUTH');
  }

  private authMechanism(name: string): boolean {
    const upper = name.toUpperCase();
    for (const cap of this.capabilities) {
      if (!cap.toUpperCase().startsWith('AUTH ')) continue;
      // Capability is a space-delimited list of mechanisms, e.g. "AUTH PLAIN LOGIN CRAM-MD5".
      // Require exact token membership so a mechanism that merely contains the
      // substring (e.g. "XPLAIN" vs "PLAIN") does not falsely match.
      const mechanisms = cap.slice('AUTH '.length).toUpperCase().split(/\s+/).filter(Boolean);
      if (mechanisms.includes(upper)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async send(message: SmtpMessage): Promise<SmtpSendResult> {
    const recipients = parseRecipients(message.to);
    if (recipients.length === 0) {
      throw new SmtpError('At least one recipient is required', 'SMTP_NO_RCPT');
    }
    const date = message.date ?? new Date();
    const messageId = message.messageId ?? generateMessageId(this.settings.from);
    const raw = buildRfc5322Message({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      body: message.body,
      inReplyTo: message.inReplyTo,
      references: message.references,
      messageId,
      date,
    });

    await this.command(`MAIL FROM:<${extractAddress(this.settings.from)}>`, [250]);
    for (const rcpt of recipients) {
      await this.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await this.command('DATA', [354]);
    // Dot-stuff and terminate with <CRLF>.<CRLF>.
    const stuffed = dotStuff(raw.replace(/\r?\n/g, CRLF));
    this.write(stuffed + CRLF + '.' + CRLF);
    await this.expect([250]);

    return { messageId, sentAt: date.toISOString() };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Parse a complete SMTP reply from a buffer, if one is present. */
export function extractCompleteReply(
  buffer: string,
): { code: number; lines: string[]; consumed: number } | null {
  const lines: string[] = [];
  let consumed = 0;
  let cursor = 0;
  for (;;) {
    const idx = buffer.indexOf(CRLF, cursor);
    if (idx < 0) return null;
    const line = buffer.slice(cursor, idx);
    lines.push(line);
    cursor = idx + CRLF.length;
    // Final line of a reply has a space at position 3 (e.g. '250 OK');
    // continuation lines have a hyphen ('250-...').
    if (/^\d{3} /.test(line)) {
      consumed = cursor;
      const code = Number(line.slice(0, 3));
      return { code, lines, consumed };
    }
    if (!/^\d{3}-/.test(line)) {
      // Malformed line — treat as terminal to avoid a hang.
      consumed = cursor;
      const code = Number(line.slice(0, 3)) || 0;
      return { code, lines, consumed };
    }
  }
}

/** Extract a bare email address from a possibly display-named header value. */
export function extractAddress(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  if (angle) return angle[1].trim();
  return value.trim();
}

/** Parse a comma-separated recipient list into bare addresses. */
export function parseRecipients(value: string): string[] {
  return value
    .split(',')
    .map((part) => extractAddress(part))
    .filter((addr) => addr.length > 0 && addr.includes('@'));
}

/** Dot-stuff a message body: lines beginning with '.' get an extra leading '.'. */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, '$1..');
}

export function generateMessageId(from: string): string {
  const domain = (() => {
    const at = extractAddress(from).indexOf('@');
    return at >= 0 ? extractAddress(from).slice(at + 1) : 'localhost';
  })();
  const random = randomBytes(16).toString('hex');
  return `<${Date.now()}.${random}@${domain}>`;
}

export interface Rfc5322Parts {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly messageId: string;
  readonly date: Date;
  readonly inReplyTo?: string;
  readonly references?: string;
}

/** Build an RFC 5322 message with a UTF-8 quoted-printable text/plain body. */
export function buildRfc5322Message(parts: Rfc5322Parts): string {
  const headers: string[] = [];
  headers.push(`From: ${parts.from}`);
  headers.push(`To: ${parts.to}`);
  headers.push(`Subject: ${encodeHeaderValue(parts.subject)}`);
  headers.push(`Date: ${formatRfc2822Date(parts.date)}`);
  headers.push(`Message-ID: ${parts.messageId}`);
  if (parts.inReplyTo) headers.push(`In-Reply-To: ${parts.inReplyTo}`);
  if (parts.references) headers.push(`References: ${parts.references}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset=utf-8');
  headers.push('Content-Transfer-Encoding: quoted-printable');
  const body = encodeQuotedPrintable(parts.body);
  return headers.join(CRLF) + CRLF + CRLF + body;
}

/** RFC 2047 encode a header value when it contains non-ASCII characters. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const encoded = Buffer.from(value, 'utf-8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

export function formatRfc2822Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = days[date.getUTCDay()];
  const dd = pad(date.getUTCDate());
  const mon = months[date.getUTCMonth()];
  const yyyy = date.getUTCFullYear();
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${day}, ${dd} ${mon} ${yyyy} ${hh}:${mm}:${ss} +0000`;
}

/**
 * Quoted-printable encode a UTF-8 body (RFC 2045).
 *
 * Soft-wraps at 76 columns: a content line carries at most 75 characters
 * followed by the `=` soft-break, so the emitted line never exceeds 76 chars
 * (RFC 2045 §6.7 rule 5). An escape sequence (`=XX`) is treated as one
 * indivisible chunk so a soft break can never split it.
 *
 * Trailing whitespace handling (RFC 2045 §6.7 rule 3): a space (0x20) or tab
 * (0x09) that immediately precedes a hard line break, or that ends the body,
 * MUST be encoded (`=20` / `=09`) — otherwise an intermediate MTA is permitted
 * to strip it and corrupt the message. We defer emitting a pending whitespace
 * byte until we know what follows: a real character flushes it literally, while
 * a line break or end-of-input forces its encoded form.
 */
export function encodeQuotedPrintable(input: string): string {
  const bytes = Buffer.from(input, 'utf-8');
  let out = '';
  let lineLen = 0;
  // A space/tab byte awaiting disposition: emitted literally if a normal
  // character follows, or encoded (=20/=09) if a line break / EOF follows.
  let pendingWs: number | null = null;
  const append = (chunk: string): void => {
    // The soft break itself occupies a column, so a content line may hold at
    // most 75 chars before the trailing '='. Never split a chunk (an escape
    // sequence must stay whole), so wrap *before* appending an oversized chunk.
    if (lineLen + chunk.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };
  const encodeByte = (byte: number): string =>
    '=' + byte.toString(16).toUpperCase().padStart(2, '0');
  // Flush a deferred whitespace byte literally (a normal character follows it).
  const flushPendingLiteral = (): void => {
    if (pendingWs !== null) {
      append(String.fromCharCode(pendingWs));
      pendingWs = null;
    }
  };
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0d) continue; // CR handled with LF
    if (byte === 0x0a) {
      // Whitespace immediately before a hard break must be encoded, not literal.
      if (pendingWs !== null) {
        append(encodeByte(pendingWs));
        pendingWs = null;
      }
      out += '\r\n';
      lineLen = 0;
      continue;
    }
    if (byte === 0x20 || byte === 0x09) {
      // A space/tab can be literal mid-line, so defer it. Two whitespace bytes
      // in a row means the first is interior (safe to emit literally now).
      flushPendingLiteral();
      pendingWs = byte;
      continue;
    }
    // A normal byte follows the deferred whitespace: emit that whitespace as-is.
    flushPendingLiteral();
    const printable = byte >= 0x20 && byte <= 0x7e && byte !== 0x3d; // not '='
    if (printable) {
      append(String.fromCharCode(byte));
    } else {
      append(encodeByte(byte));
    }
  }
  // Whitespace at the very end of the body must be encoded too (rule 3).
  if (pendingWs !== null) {
    append(encodeByte(pendingWs));
    pendingWs = null;
  }
  return out;
}
