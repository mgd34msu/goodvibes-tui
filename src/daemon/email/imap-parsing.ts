// ---------------------------------------------------------------------------
// Pure IMAP / MIME parsing helpers for the daemon-owned IMAP connector.
//
// This module is dependency-free (only node Buffer) and contains the wire-
// format parsing, MIME decoding, and text-normalization helpers used by
// `imap-connector.ts`. Everything here is exported for unit testing and is
// re-exported from `imap-connector.ts` so consumers keep a single import path.
// ---------------------------------------------------------------------------

export interface ImapEnvelopeSummary {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  readonly bodyPreview: string;
  readonly messageId: string;
}

export interface ImapAttachmentSummary {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface ImapFullMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly messageId: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
  readonly attachments?: ImapAttachmentSummary[];
}

export class ImapError extends Error {
  readonly code: string;
  constructor(message: string, code = 'IMAP_ERROR') {
    super(message);
    this.name = 'ImapError';
    this.code = code;
  }
}

const IMAP_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Format an ISO date string into the IMAP SEARCH date form: DD-Mon-YYYY. */
export function toImapSearchDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new ImapError(`Invalid since date: ${iso}`, 'IMAP_BAD_DATE');
  }
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = IMAP_MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

// ---------------------------------------------------------------------------
// Pure parsing helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Quote and escape a string for use as an IMAP quoted-string argument. */
export function quoteImapString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Parse UID list out of an untagged `* SEARCH ...` response. */
export function parseSearchUids(lines: string[]): number[] {
  const uids: number[] = [];
  for (const line of lines) {
    const match = /^\* SEARCH(.*)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      const n = Number(token);
      if (Number.isInteger(n) && n > 0) uids.push(n);
    }
  }
  return uids;
}

/** Parse APPENDUID response code: `[APPENDUID <validity> <uid>]`. */
export function parseAppendUid(lines: string[]): number {
  for (const line of lines) {
    const match = /\[APPENDUID\s+\d+\s+(\d+)\]/i.exec(line);
    if (match) return Number(match[1]);
  }
  return 0;
}

/**
 * Parse an IMAP ENVELOPE structure into addressable fields.
 * Envelope order (RFC 3501): date subject from sender reply-to to cc bcc
 * in-reply-to message-id.
 */
export function parseEnvelope(envelope: string): {
  date: string;
  subject: string;
  from: string;
  messageId: string;
} {
  const tokens = tokenizeParen(envelope);
  // tokens: [date, subject, from(list), sender, reply-to, to, cc, bcc,
  //          in-reply-to, message-id]
  const date = nilToEmpty(tokens[0]);
  const subject = decodeMimeWords(nilToEmpty(tokens[1]));
  const from = parseAddressList(tokens[2]);
  const messageId = nilToEmpty(tokens[9]);
  return { date, subject, from, messageId };
}

/** Parse `* n FETCH (...)` summary lines into envelope summaries. */
export function parseFetchSummaries(lines: string[]): ImapEnvelopeSummary[] {
  const joined = lines.join('\n');
  const blocks = splitFetchBlocks(joined);
  const summaries: ImapEnvelopeSummary[] = [];
  for (const block of blocks) {
    const uid = extractUid(block);
    if (uid === null) continue;
    const flags = extractFlags(block);
    const unread = !flags.includes('\\Seen');
    const envelopeRaw = extractParenValue(block, 'ENVELOPE');
    const env = envelopeRaw
      ? parseEnvelope(envelopeRaw)
      : { date: '', subject: '', from: '', messageId: '' };
    const headerMessageId = extractHeaderMessageId(block);
    const preview = extractBodyPreview(block);
    summaries.push({
      uid,
      from: env.from,
      subject: env.subject,
      date: env.date,
      unread,
      bodyPreview: preview,
      messageId: env.messageId || headerMessageId,
    });
  }
  return summaries;
}

/** Parse a full-body FETCH response (`BODY[]`) into a structured message. */
export function parseFullMessage(uid: number, lines: string[]): ImapFullMessage | null {
  const joined = lines.join('\n');
  const blocks = splitFetchBlocks(joined);
  for (const block of blocks) {
    const blockUid = extractUid(block);
    const rawBody = extractLiteralFor(block, /BODY\[\]/i) ?? extractLiteralFor(block, /RFC822/i);
    if (rawBody === null) continue;
    if (blockUid !== null && blockUid !== uid) continue;
    const mime = parseMimeMessage(rawBody);
    const envelopeRaw = extractParenValue(block, 'ENVELOPE');
    const env = envelopeRaw
      ? parseEnvelope(envelopeRaw)
      : { date: mime.headers.date ?? '', subject: mime.headers.subject ?? '', from: mime.headers.from ?? '', messageId: mime.headers['message-id'] ?? '' };
    return {
      uid: blockUid ?? uid,
      from: env.from || mime.headers.from || '',
      subject: env.subject || mime.headers.subject || '',
      date: env.date || mime.headers.date || '',
      messageId: env.messageId || mime.headers['message-id'] || '',
      bodyText: mime.text,
      ...(mime.html ? { bodyHtml: mime.html } : {}),
      ...(mime.attachments.length > 0 ? { attachments: mime.attachments } : {}),
    };
  }
  return null;
}

// ---- low-level token helpers ----------------------------------------------

function nilToEmpty(token: string | undefined): string {
  if (token === undefined) return '';
  const trimmed = token.trim();
  if (trimmed === '' || /^NIL$/i.test(trimmed)) return '';
  // Strip surrounding quotes if quoted-string.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeImapString(trimmed.slice(1, -1));
  }
  return trimmed;
}

export function unescapeImapString(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Tokenize the top-level items of a parenthesized IMAP list, respecting nested
 * parens and quoted strings. Returns the raw token strings.
 */
export function tokenizeParen(input: string): string[] {
  let src = input.trim();
  if (src.startsWith('(') && src.endsWith(')')) src = src.slice(1, -1);
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ') { i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '"';
      while (j < src.length) {
        out += src[j];
        if (src[j] === '\\') { out += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '"') { j += 1; break; }
        j += 1;
      }
      tokens.push(out);
      i = j;
      continue;
    }
    if (ch === '(') {
      let depth = 0;
      let j = i;
      let inQuote = false;
      while (j < src.length) {
        const c = src[j];
        if (inQuote) {
          if (c === '\\') { j += 2; continue; }
          if (c === '"') inQuote = false;
        } else if (c === '"') {
          inQuote = true;
        } else if (c === '(') {
          depth += 1;
        } else if (c === ')') {
          depth -= 1;
          if (depth === 0) { j += 1; break; }
        }
        j += 1;
      }
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    // Atom (until whitespace).
    let j = i;
    while (j < src.length && src[j] !== ' ') j += 1;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

/** Parse the first address out of an IMAP address-list structure. */
export function parseAddressList(token: string | undefined): string {
  if (token === undefined) return '';
  const trimmed = token.trim();
  if (trimmed === '' || /^NIL$/i.test(trimmed)) return '';
  // An address-list is `((name adl mailbox host) (...))`. tokenizeParen on the
  // whole list yields one token per address group; take the first group, then
  // tokenize that group into its (name adl mailbox host) parts.
  const firstAddr = tokenizeParen(trimmed)[0];
  if (firstAddr === undefined) return '';
  const parts = tokenizeParen(firstAddr);
  const name = nilToEmpty(parts[0]);
  const mailbox = nilToEmpty(parts[2]);
  const host = nilToEmpty(parts[3]);
  const address = mailbox && host ? `${mailbox}@${host}` : (mailbox || host);
  if (name && address) return `${decodeMimeWords(name)} <${address}>`;
  return address || decodeMimeWords(name);
}

function splitFetchBlocks(joined: string): string[] {
  // Split on untagged FETCH markers while keeping each block whole.
  const blocks: string[] = [];
  const regex = /(^|\n)\* \d+ FETCH /gi;
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(joined)) !== null) {
    indices.push(m.index + (m[1] ? 1 : 0));
  }
  for (let k = 0; k < indices.length; k += 1) {
    const start = indices[k];
    const end = k + 1 < indices.length ? indices[k + 1] : joined.length;
    blocks.push(joined.slice(start, end));
  }
  return blocks;
}

function extractUid(block: string): number | null {
  const match = /UID (\d+)/i.exec(block);
  return match ? Number(match[1]) : null;
}

function extractFlags(block: string): string[] {
  const match = /FLAGS \(([^)]*)\)/i.exec(block);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/** Extract a parenthesized value following a key (e.g. ENVELOPE (...)). */
export function extractParenValue(block: string, key: string): string | null {
  const keyIdx = block.toUpperCase().indexOf(key.toUpperCase());
  if (keyIdx < 0) return null;
  let i = keyIdx + key.length;
  while (i < block.length && block[i] !== '(') i += 1;
  if (i >= block.length) return null;
  let depth = 0;
  let inQuote = false;
  const start = i;
  while (i < block.length) {
    const c = block[i];
    if (inQuote) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
    i += 1;
  }
  return block.slice(start, i);
}

/** Extract the literal text that immediately follows a `KEY {n}` marker. */
export function extractLiteralFor(block: string, keyPattern: RegExp): string | null {
  const re = new RegExp(`${keyPattern.source}[^{]*\\{(\\d+)\\}\\n`, keyPattern.flags.includes('i') ? 'i' : '');
  const match = re.exec(block);
  if (!match) return null;
  const length = Number(match[1]);
  const startIdx = match.index + match[0].length;
  return block.slice(startIdx, startIdx + length);
}

function extractHeaderMessageId(block: string): string {
  const literal = extractLiteralFor(block, /BODY\[HEADER\.FIELDS \(MESSAGE-ID\)\]/i);
  const source = literal ?? block;
  const match = /Message-ID:\s*(<[^>]+>)/i.exec(source);
  return match ? match[1] : '';
}

function extractBodyPreview(block: string): string {
  const literal = extractLiteralFor(block, /BODY\[TEXT\](?:<\d+(?:\.\d+)?>)?/i);
  if (literal === null) return '';
  return collapseWhitespace(stripHtml(literal)).slice(0, 280);
}

// ---------------------------------------------------------------------------
// MIME parsing (sufficient for text/plain, text/html, multipart, attachments)
// ---------------------------------------------------------------------------

export interface ParsedMime {
  headers: Record<string, string>;
  text: string;
  html?: string;
  attachments: ImapAttachmentSummary[];
}

export function parseMimeMessage(raw: string): ParsedMime {
  const { headers, body } = splitHeadersBody(raw);
  const contentType = headers['content-type'] ?? 'text/plain';
  const attachments: ImapAttachmentSummary[] = [];
  let text = '';
  let html: string | undefined;

  const boundary = extractBoundary(contentType);
  if (boundary) {
    const parts = splitMultipart(body, boundary);
    for (const part of parts) {
      const { headers: ph, body: pb } = splitHeadersBody(part);
      const pct = ph['content-type'] ?? 'text/plain';
      const disposition = ph['content-disposition'] ?? '';
      const decoded = decodeTransferEncoding(pb, ph['content-transfer-encoding']);
      if (/attachment|filename=/i.test(disposition) || (!/text\//i.test(pct) && /name=/i.test(pct))) {
        attachments.push({
          filename: extractParam(disposition, 'filename') || extractParam(pct, 'name') || 'attachment',
          contentType: pct.split(';')[0].trim(),
          sizeBytes: Buffer.byteLength(decoded, 'utf-8'),
        });
      } else if (/text\/html/i.test(pct)) {
        html = decoded.trim();
      } else if (/text\/plain/i.test(pct)) {
        text = decoded.trim();
      }
    }
    if (!text && html) text = collapseWhitespace(stripHtml(html));
  } else {
    const decoded = decodeTransferEncoding(body, headers['content-transfer-encoding']);
    if (/text\/html/i.test(contentType)) {
      html = decoded.trim();
      text = collapseWhitespace(stripHtml(decoded));
    } else {
      text = decoded.trim();
    }
  }

  return { headers, text, ...(html ? { html } : {}), attachments };
}

export function splitHeadersBody(raw: string): { headers: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const sepIdx = normalized.indexOf('\n\n');
  const headerText = sepIdx >= 0 ? normalized.slice(0, sepIdx) : normalized;
  const body = sepIdx >= 0 ? normalized.slice(sepIdx + 2) : '';
  const headers: Record<string, string> = {};
  // Unfold continuation lines (leading whitespace).
  const unfolded = headerText.replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = decodeMimeWords(value);
  }
  return { headers, body };
}

function extractBoundary(contentType: string): string | null {
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match ? match[1] : null;
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const segments = body.split(marker);
  const parts: string[] = [];
  for (const seg of segments) {
    const trimmed = seg.replace(/^\r?\n/, '');
    if (trimmed === '' || trimmed.startsWith('--')) continue;
    parts.push(trimmed);
  }
  return parts;
}

function extractParam(source: string, name: string): string {
  const match = new RegExp(`${name}="?([^";]+)"?`, 'i').exec(source);
  return match ? match[1].trim() : '';
}

export function decodeTransferEncoding(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? '').toLowerCase().trim();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return body;
}

export function decodeQuotedPrintable(input: string): string {
  // Strip soft line breaks, then decode `=XX` escapes into raw bytes and
  // interpret the resulting byte stream as UTF-8 (a single `=C3=A9` pair must
  // become one 'é', not two Latin-1 characters).
  const unfolded = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i += 1) {
    const ch = unfolded[i];
    if (ch === '=' && /[0-9A-Fa-f]{2}/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Preserve the original character's UTF-8 bytes.
      for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** Decode RFC 2047 encoded-words (=?charset?B/Q?text?=). */
export function decodeMimeWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset, enc, text) => {
    if (enc.toUpperCase() === 'B') {
      try {
        return Buffer.from(text, 'base64').toString('utf-8');
      } catch {
        return text;
      }
    }
    return decodeQuotedPrintable(text.replace(/_/g, ' '));
  });
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
