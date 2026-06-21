// ---------------------------------------------------------------------------
// Minimal, dependency-free IMAPS client (RFC 3501 subset) over node:tls.
//
// Implements exactly what the inbound poller needs:
//   LOGIN, SELECT, UID SEARCH (SINCE / ALL), UID FETCH (ENVELOPE + body peek),
//   LOGOUT. No external npm dependency — uses node:tls (Bun-compatible).
//
// This is intentionally conservative: line-buffered tagged-command protocol,
// per-command timeout, and a hard cap on response size to avoid unbounded
// memory growth from a hostile/large mailbox.
// ---------------------------------------------------------------------------

import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';

export interface ImapConfig {
  host: string;
  port: number; // 993 for IMAPS
  user: string;
  password: string;
  /** Per-command timeout in ms. */
  timeoutMs?: number;
  /** Hard cap on bytes buffered per command (defense against huge fetches). */
  maxResponseBytes?: number;
}

export interface ImapEnvelope {
  uid: number;
  from: string; // raw From header value (digested by the adapter)
  subject: string;
  date: number; // Unix ms (0 when unparseable)
  seen: boolean;
  bodyPreview: string; // first text fragment, raw (sanitized by the adapter)
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ImapClient {
  private socket: TLSSocket | null = null;
  private tagCounter = 0;
  private buffer = '';
  private readonly cfg: Required<ImapConfig>;

  constructor(cfg: ImapConfig) {
    this.cfg = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      ...cfg,
    };
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect(
        { host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host },
        () => {
          resolve();
        },
      );
      socket.setEncoding('utf-8');
      socket.once('error', reject);
      this.socket = socket;
    });
    // Consume the server greeting (untagged * OK ...).
    await this.readUntil((chunk) => /\r?\n/.test(chunk), 'greeting');
  }

  async login(): Promise<void> {
    const user = quote(this.cfg.user);
    const pass = quote(this.cfg.password);
    await this.command(`LOGIN ${user} ${pass}`);
  }

  /** SELECT a mailbox (default INBOX). */
  async select(mailbox = 'INBOX'): Promise<void> {
    await this.command(`SELECT ${quote(mailbox)}`);
  }

  /** UID SEARCH; returns matching UIDs. `since` filters by internal date. */
  async searchUids(since?: number): Promise<number[]> {
    const criteria = since ? `SINCE ${imapDate(since)}` : 'ALL';
    const lines = await this.command(`UID SEARCH ${criteria}`);
    const uids: number[] = [];
    for (const line of lines) {
      const match = /^\* SEARCH(.*)$/i.exec(line.trim());
      if (match) {
        for (const tok of match[1]!.trim().split(/\s+/)) {
          const n = Number.parseInt(tok, 10);
          if (Number.isFinite(n)) uids.push(n);
        }
      }
    }
    return uids;
  }

  /**
   * UID FETCH envelope + flags + a small text body peek for the given uids.
   * Returns one ImapEnvelope per uid that parsed successfully.
   */
  async fetchEnvelopes(uids: readonly number[]): Promise<ImapEnvelope[]> {
    if (uids.length === 0) return [];
    const set = uids.join(',');
    // BODY.PEEK[HEADER.FIELDS (...)] avoids setting \Seen; TEXT peek for preview.
    const lines = await this.command(
      `UID FETCH ${set} (UID FLAGS INTERNALDATE `
        + `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] `
        + `BODY.PEEK[TEXT]<0.600>)`,
    );
    return parseFetchResponse(lines.join('\r\n'));
  }

  async logout(): Promise<void> {
    if (!this.socket) return;
    try {
      await this.command('LOGOUT');
    } catch {
      // ignore logout failures
    }
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // -------------------------------------------------------------------------
  // Protocol plumbing
  // -------------------------------------------------------------------------

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${this.tagCounter.toString().padStart(4, '0')}`;
  }

  private requireSocket(): TLSSocket {
    if (!this.socket) throw new Error('IMAP socket not connected');
    return this.socket;
  }

  /** Send a tagged command and collect all response lines up to the tagged OK. */
  private async command(text: string): Promise<string[]> {
    const tag = this.nextTag();
    const socket = this.requireSocket();
    socket.write(`${tag} ${text}\r\n`);
    const taggedOk = new RegExp(`^${tag} (OK|NO|BAD)\\b`, 'm');
    const raw = await this.readUntil((buf) => taggedOk.test(buf), text);
    const lines = raw.split(/\r?\n/);
    const statusLine = lines.find((l) => new RegExp(`^${tag} `).test(l)) ?? '';
    const status = /^A\d+ (OK|NO|BAD)/.exec(statusLine)?.[1];
    if (status !== 'OK') {
      throw new Error(`IMAP command failed: ${redactCommand(text)} -> ${statusLine.trim()}`);
    }
    return lines.filter((l) => l.startsWith('*'));
  }

  /** Read from the socket until `predicate(buffer)` is true or timeout. */
  private readUntil(predicate: (buf: string) => boolean, label: string): Promise<string> {
    const socket = this.requireSocket();
    return new Promise<string>((resolve, reject) => {
      const onData = (chunk: string): void => {
        this.buffer += chunk;
        if (this.buffer.length > this.cfg.maxResponseBytes) {
          cleanup();
          reject(new Error(`IMAP response exceeded ${this.cfg.maxResponseBytes} bytes (${label})`));
          return;
        }
        if (predicate(this.buffer)) {
          const out = this.buffer;
          this.buffer = '';
          cleanup();
          resolve(out);
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error(`IMAP connection closed during ${label}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`IMAP timeout after ${this.cfg.timeoutMs}ms (${label})`));
      }, this.cfg.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }
}

// ---------------------------------------------------------------------------
// Pure parsers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Quote an IMAP astring, escaping backslashes and double quotes. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Never echo a LOGIN password in an error message. */
function redactCommand(text: string): string {
  return /^LOGIN\b/i.test(text) ? 'LOGIN <redacted>' : text;
}

/** Format a Unix-ms timestamp as an IMAP date (dd-Mon-yyyy). */
export function imapDate(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

const HEADER_FROM_RE = /^From:\s*(.*)$/im;
const HEADER_SUBJECT_RE = /^Subject:\s*(.*)$/im;
const HEADER_DATE_RE = /^Date:\s*(.*)$/im;

/**
 * Parse a UID FETCH response block into envelopes. Robust to interleaving and
 * partial fields; entries that lack a UID are skipped.
 */
export function parseFetchResponse(raw: string): ImapEnvelope[] {
  const envelopes: ImapEnvelope[] = [];
  // Split on each "* <n> FETCH (" boundary.
  const blocks = raw.split(/\* \d+ FETCH \(/i).slice(1);
  for (const block of blocks) {
    const uidMatch = /UID (\d+)/i.exec(block);
    if (!uidMatch) continue;
    const uid = Number.parseInt(uidMatch[1]!, 10);
    const seen = /FLAGS \([^)]*\\Seen/i.test(block);

    // Header literal: BODY[HEADER.FIELDS (...)] {n}\r\n<header bytes>
    const headerText = extractLiteral(block, /BODY\[HEADER\.FIELDS[^\]]*\]/i);
    const bodyText = extractLiteral(block, /BODY\[TEXT\](?:<\d+(?:\.\d+)?>)?/i);

    const from = HEADER_FROM_RE.exec(headerText)?.[1]?.trim() ?? '';
    const subject = decodeHeader(HEADER_SUBJECT_RE.exec(headerText)?.[1]?.trim() ?? '');
    const dateRaw = HEADER_DATE_RE.exec(headerText)?.[1]?.trim() ?? '';
    const parsedDate = dateRaw ? Date.parse(dateRaw) : NaN;

    envelopes.push({
      uid,
      from,
      subject,
      date: Number.isFinite(parsedDate) ? parsedDate : 0,
      seen,
      bodyPreview: bodyText,
    });
  }
  return envelopes;
}

/**
 * Extract a literal `{n}\r\n<bytes>` that follows a section header matched by
 * `sectionRe`. Returns the literal content (n bytes) or ''.
 */
function extractLiteral(block: string, sectionRe: RegExp): string {
  const sectionMatch = sectionRe.exec(block);
  if (!sectionMatch) return '';
  const after = block.slice(sectionMatch.index + sectionMatch[0].length);
  const litMatch = /^\s*\{(\d+)\}\r?\n/.exec(after);
  if (!litMatch) {
    // Quoted-string form: BODY[...] "value"
    const q = /^\s*"((?:[^"\\]|\\.)*)"/.exec(after);
    return q ? q[1]!.replace(/\\"/g, '"') : '';
  }
  const n = Number.parseInt(litMatch[1]!, 10);
  const start = litMatch.index + litMatch[0].length;
  return after.slice(start, start + n);
}

/** Decode RFC 2047 encoded-word subjects (UTF-8 B/Q) best-effort. */
export function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      }
      // Q-encoding: _ -> space, =XX -> byte
      const replaced = String(text)
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_s: string, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      return replaced;
    } catch {
      return text;
    }
  });
}
