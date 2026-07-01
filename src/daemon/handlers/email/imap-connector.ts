// ---------------------------------------------------------------------------
// Daemon-owned IMAP connector.
//
// A dependency-free IMAP4rev1 client built on node:tls / node:net (Bun-compatible).
// The daemon owns this connector outright — it does NOT import any agent code.
//
// Read paths use EXAMINE (read-only) and BODY.PEEK so messages are never
// implicitly marked \Seen. Draft creation uses APPEND to the configured Drafts
// mailbox. Credentials are supplied by the caller (resolved from the daemon
// credential store) and are never logged.
//
// The pure wire-format / MIME parsing helpers live in `./imap-parsing.ts` and
// are re-exported from here so consumers keep a single import path.
// ---------------------------------------------------------------------------

import { connect as tlsConnect } from 'node:tls';
import { Socket } from 'node:net';
import { once } from 'node:events';
import {
  ImapError,
  quoteImapString,
  parseSearchUids,
  parseFetchSummaries,
  parseFullMessage,
  parseAppendUid,
  toImapSearchDate,
  type ImapEnvelopeSummary,
  type ImapFullMessage,
} from './imap-parsing.ts';

// Re-export the pure parsing helpers + shared message types so existing
// consumers (and tests) can continue importing them from './imap-connector.ts'.
export {
  ImapError,
  toImapSearchDate,
  quoteImapString,
  parseSearchUids,
  parseAppendUid,
  parseEnvelope,
  parseFetchSummaries,
  parseFullMessage,
  parseAddressList,
  parseMimeMessage,
  splitHeadersBody,
  tokenizeParen,
  extractParenValue,
  extractLiteralFor,
  unescapeImapString,
  decodeTransferEncoding,
  decodeQuotedPrintable,
  decodeMimeWords,
  stripHtml,
  collapseWhitespace,
} from './imap-parsing.ts';
export type {
  ImapEnvelopeSummary,
  ImapFullMessage,
  ImapAttachmentSummary,
  ParsedMime,
} from './imap-parsing.ts';

export interface ImapConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** Use implicit TLS (port 993). When false, a plain socket is used. */
  readonly secure: boolean;
  /** Mailbox to read from. Defaults to 'INBOX'. */
  readonly mailbox?: string;
  /** Mailbox to append drafts to. Defaults to 'Drafts'. */
  readonly draftsMailbox?: string;
  /** Socket connect / command timeout in ms. Defaults to 30000. */
  readonly timeoutMs?: number;
}

export interface ImapListOptions {
  readonly limit: number;
  readonly since?: string; // ISO-8601 date string
  readonly unreadOnly: boolean;
}

export interface ImapAppendResult {
  readonly uid: number;
  readonly mailbox: string;
}

type RawSocket = Socket;

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Low-level line/tag oriented IMAP client. One tagged command in flight at a
 * time, which is sufficient for the daemon's sequential list/read/append flows.
 */
export class ImapConnector {
  private socket: RawSocket | null = null;
  private buffer = '';
  private tagCounter = 0;
  private readonly settings: ImapConnectionSettings;
  private readonly timeoutMs: number;
  private dataWaiters: Array<() => void> = [];
  private closed = false;

  constructor(settings: ImapConnectionSettings) {
    if (!settings.host) throw new ImapError('IMAP host is required', 'IMAP_CONFIG');
    if (!settings.user) throw new ImapError('IMAP user is required', 'IMAP_CONFIG');
    if (!settings.password) throw new ImapError('IMAP password is required', 'IMAP_CONFIG');
    this.settings = settings;
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    const { host, port, secure } = this.settings;
    const socket: RawSocket = secure
      ? (tlsConnect({ host, port, servername: host }) as unknown as RawSocket)
      : new Socket();

    socket.setEncoding('utf-8');
    socket.setTimeout(this.timeoutMs);
    this.socket = socket;

    socket.on('data', (chunk: string | Buffer) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.flushWaiters();
    });
    socket.on('close', () => {
      this.closed = true;
      this.flushWaiters();
    });
    socket.on('error', () => {
      this.closed = true;
      this.flushWaiters();
    });

    const eventName = secure ? 'secureConnect' : 'connect';
    if (!secure) {
      (socket as Socket).connect({ host, port });
    }
    await this.waitForEvent(socket, eventName);
    // Server greeting (untagged OK).
    await this.readUntagged();
    await this.login();
  }

  private async waitForEvent(socket: RawSocket, eventName: string): Promise<void> {
    const timer = this.armTimeout(`Timed out waiting for ${eventName}`);
    try {
      await once(socket, eventName);
    } finally {
      clearTimeout(timer);
    }
  }

  private armTimeout(message: string): NodeJS.Timeout {
    return setTimeout(() => {
      this.destroy(new ImapError(message, 'IMAP_TIMEOUT'));
    }, this.timeoutMs);
  }

  private destroy(error?: ImapError): void {
    this.closed = true;
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.destroy();
      this.socket = null;
    }
    this.flushWaiters();
    if (error) throw error;
  }

  async close(): Promise<void> {
    if (this.closed || !this.socket) {
      this.closed = true;
      this.socket = null;
      return;
    }
    try {
      await this.command('LOGOUT');
    } catch {
      // Ignore — logout best-effort.
    } finally {
      if (this.socket) {
        this.socket.removeAllListeners('data');
        this.socket.destroy();
      }
      this.socket = null;
      this.closed = true;
    }
  }

  // -------------------------------------------------------------------------
  // Wire I/O
  // -------------------------------------------------------------------------

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  private write(line: string): void {
    if (!this.socket || this.closed) {
      throw new ImapError('IMAP socket is not connected', 'IMAP_CLOSED');
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
    return new Promise<void>((resolve) => {
      this.dataWaiters.push(resolve);
    });
  }

  /** Read the initial untagged greeting line. */
  private async readUntagged(): Promise<string> {
    const timer = this.armTimeout('Timed out waiting for server greeting');
    try {
      while (!this.buffer.includes(CRLF)) {
        if (this.closed) throw new ImapError('Connection closed before greeting', 'IMAP_CLOSED');
        await this.waitForData();
      }
      const idx = this.buffer.indexOf(CRLF);
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + CRLF.length);
      if (!/^\* (OK|PREAUTH)/i.test(line)) {
        throw new ImapError(`Unexpected greeting: ${line}`, 'IMAP_GREETING');
      }
      return line;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a tagged command and collect the full response (all untagged lines
   * plus the tagged completion line). Handles IMAP literals ({n}) transparently.
   */
  private async command(commandText: string): Promise<{ lines: string[]; status: string }> {
    const tag = this.nextTag();
    this.write(`${tag} ${commandText}${CRLF}`);
    return this.readResponse(tag);
  }

  private async readResponse(tag: string): Promise<{ lines: string[]; status: string }> {
    const lines: string[] = [];
    const timer = this.armTimeout(`Timed out waiting for response to ${tag}`);
    try {
      for (;;) {
        const line = await this.readLine();
        if (line === null) {
          throw new ImapError('Connection closed during command', 'IMAP_CLOSED');
        }
        // Handle a trailing literal: {n} at end of line means n octets follow.
        const literalMatch = /\{(\d+)\}$/.exec(line);
        if (literalMatch) {
          const octets = Number(literalMatch[1]);
          const literal = await this.readOctets(octets);
          lines.push(`${line}\n${literal}`);
          continue;
        }
        const tagged = new RegExp(`^${tag} (OK|NO|BAD)`, 'i').exec(line);
        if (tagged) {
          const status = tagged[1].toUpperCase();
          if (status !== 'OK') {
            throw new ImapError(`IMAP command failed: ${line}`, `IMAP_${status}`);
          }
          // Include the tagged completion line so callers can read response
          // codes carried there (e.g. [APPENDUID validity uid]).
          lines.push(line);
          return { lines, status };
        }
        lines.push(line);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async readLine(): Promise<string | null> {
    for (;;) {
      const idx = this.buffer.indexOf(CRLF);
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + CRLF.length);
        return line;
      }
      if (this.closed) {
        if (this.buffer.length > 0) {
          const remaining = this.buffer;
          this.buffer = '';
          return remaining;
        }
        return null;
      }
      await this.waitForData();
    }
  }

  private async readOctets(count: number): Promise<string> {
    while (this.buffer.length < count) {
      if (this.closed) break;
      await this.waitForData();
    }
    const data = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return data;
  }

  // -------------------------------------------------------------------------
  // Auth + mailbox selection
  // -------------------------------------------------------------------------

  private async login(): Promise<void> {
    // LOGIN with quoted-string arguments (escaping backslash + quote per RFC 3501).
    const user = quoteImapString(this.settings.user);
    const pass = quoteImapString(this.settings.password);
    await this.command(`LOGIN ${user} ${pass}`);
  }

  /** Open a mailbox read-only (EXAMINE) — never sets \Seen on fetch. */
  private async examine(mailbox: string): Promise<void> {
    await this.command(`EXAMINE ${quoteImapString(mailbox)}`);
  }

  /** Open a mailbox read-write (SELECT) — required before APPEND validation. */
  private async select(mailbox: string): Promise<void> {
    await this.command(`SELECT ${quoteImapString(mailbox)}`);
  }

  // -------------------------------------------------------------------------
  // High-level operations
  // -------------------------------------------------------------------------

  /**
   * List recent messages via read-only EXAMINE + UID SEARCH + UID FETCH.
   * Does NOT mark messages as read (EXAMINE + BODY.PEEK).
   */
  async listMessages(options: ImapListOptions): Promise<ImapEnvelopeSummary[]> {
    const mailbox = this.settings.mailbox ?? 'INBOX';
    await this.examine(mailbox);

    const criteria: string[] = [];
    if (options.unreadOnly) criteria.push('UNSEEN');
    if (options.since) criteria.push(`SINCE ${toImapSearchDate(options.since)}`);
    if (criteria.length === 0) criteria.push('ALL');

    const searchResp = await this.command(`UID SEARCH ${criteria.join(' ')}`);
    const uids = parseSearchUids(searchResp.lines);
    if (uids.length === 0) return [];

    // Most-recent-first, capped at limit.
    const selected = uids.slice(-options.limit).reverse();
    const set = selected.join(',');
    const fetchResp = await this.command(
      `UID FETCH ${set} (UID FLAGS ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)] BODY.PEEK[TEXT]<0.512>)`,
    );
    const parsed = parseFetchSummaries(fetchResp.lines);
    // Preserve the most-recent-first ordering established above.
    const byUid = new Map(parsed.map((m) => [m.uid, m]));
    return selected
      .map((uid) => byUid.get(uid))
      .filter((m): m is ImapEnvelopeSummary => m !== undefined);
  }

  /**
   * Fetch a full message body by UID using BODY.PEEK (no \Seen).
   */
  async readMessage(uid: number): Promise<ImapFullMessage> {
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new ImapError(`Invalid UID: ${uid}`, 'IMAP_BAD_UID');
    }
    const mailbox = this.settings.mailbox ?? 'INBOX';
    await this.examine(mailbox);
    const fetchResp = await this.command(
      `UID FETCH ${uid} (UID ENVELOPE BODY.PEEK[])`,
    );
    const message = parseFullMessage(uid, fetchResp.lines);
    if (!message) {
      throw new ImapError(`Message UID ${uid} not found`, 'IMAP_NOT_FOUND');
    }
    return message;
  }

  /**
   * Append a fully-formed RFC 5322 message to the Drafts mailbox.
   * Returns the assigned UID when the server reports APPENDUID, else 0.
   */
  async appendDraft(rawMessage: string): Promise<ImapAppendResult> {
    const mailbox = this.settings.draftsMailbox ?? 'Drafts';
    // Ensure the mailbox exists / is selectable; ignore CREATE failure when it
    // already exists.
    try {
      await this.command(`CREATE ${quoteImapString(mailbox)}`);
    } catch {
      // Already exists — fine.
    }
    await this.select(mailbox);

    const normalized = rawMessage.replace(/\r?\n/g, CRLF);
    const octets = Buffer.byteLength(normalized, 'utf-8');
    const tag = this.nextTag();
    // Send the command line ending with the literal length; server replies with
    // a continuation request ('+ ...') before we stream the message bytes.
    this.write(`${tag} APPEND ${quoteImapString(mailbox)} (\\Draft) {${octets}}${CRLF}`);
    await this.waitForContinuation();
    this.write(normalized + CRLF);
    const resp = await this.readResponse(tag);
    const uid = parseAppendUid(resp.lines);
    return { uid, mailbox };
  }

  private async waitForContinuation(): Promise<void> {
    const timer = this.armTimeout('Timed out waiting for APPEND continuation');
    try {
      for (;;) {
        const line = await this.readLine();
        if (line === null) {
          throw new ImapError('Connection closed awaiting continuation', 'IMAP_CLOSED');
        }
        if (line.startsWith('+')) return;
        if (/^A\d+ (NO|BAD)/i.test(line)) {
          throw new ImapError(`APPEND rejected: ${line}`, 'IMAP_APPEND_REJECTED');
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
