import { describe, expect, test } from 'bun:test';
import {
  decodeQuotedPrintable,
  decodeMimeWords,
  stripHtml,
  collapseWhitespace,
  parseMimeMessage,
  splitHeadersBody,
  quoteImapString,
  parseSearchUids,
  parseAppendUid,
  parseAddressList,
  toImapSearchDate,
} from '../../../daemon/handlers/email/imap-parsing.ts';
import {
  encodeQuotedPrintable,
  buildRfc5322Message,
  parseRecipients,
  extractAddress,
  dotStuff,
  extractCompleteReply,
} from '../../../daemon/handlers/email/smtp-connector.ts';

describe('IMAP/MIME parsing', () => {
  test('decodes quoted-printable into UTF-8 (multi-byte stays one char)', () => {
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
    expect(decodeQuotedPrintable('a=\r\nb')).toBe('ab');
  });

  test('decodes RFC 2047 encoded-words (B and Q)', () => {
    expect(decodeMimeWords('=?UTF-8?B?Y2Fmw6k=?=')).toBe('café');
    expect(decodeMimeWords('=?UTF-8?Q?caf=C3=A9?=')).toBe('café');
  });

  test('strips html and collapses whitespace', () => {
    expect(stripHtml('<p>hi<br>there</p>').trim()).toBe('hi there');
    expect(collapseWhitespace('  a\n\t b  ')).toBe('a b');
  });

  test('splits headers from body and lowercases keys', () => {
    const { headers, body } = splitHeadersBody('Subject: Hello\r\nFrom: a@b.co\r\n\r\nthe body');
    expect(headers.subject).toBe('Hello');
    expect(headers.from).toBe('a@b.co');
    expect(body).toBe('the body');
  });

  test('parses a multipart/alternative message (text + html)', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain',
      '',
      'plain part',
      '--BOUND',
      'Content-Type: text/html',
      '',
      '<b>html part</b>',
      '--BOUND--',
    ].join('\r\n');
    const mime = parseMimeMessage(raw);
    expect(mime.text).toBe('plain part');
    expect(mime.html).toBe('<b>html part</b>');
  });

  test('quotes IMAP strings with escaping', () => {
    expect(quoteImapString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test('parses UID SEARCH and APPENDUID responses', () => {
    expect(parseSearchUids(['* SEARCH 1 5 9', 'A1 OK'])).toEqual([1, 5, 9]);
    expect(parseAppendUid(['A2 OK [APPENDUID 1 42] done'])).toBe(42);
  });

  test('parses an IMAP address-list into a display address', () => {
    const out = parseAddressList('(("Jane Doe" NIL "jane" "example.com"))');
    expect(out).toBe('Jane Doe <jane@example.com>');
  });

  test('formats an IMAP SEARCH date', () => {
    expect(toImapSearchDate('2024-03-09T00:00:00Z')).toBe('09-Mar-2024');
  });
});

describe('SMTP message building', () => {
  test('quoted-printable encodes non-ascii and soft-wraps long lines', () => {
    expect(encodeQuotedPrintable('é')).toBe('=C3=A9');
    const long = 'x'.repeat(100);
    const encoded = encodeQuotedPrintable(long);
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  test('encodes trailing whitespace before a hard break', () => {
    expect(encodeQuotedPrintable('a \nb')).toBe('a=20\r\nb');
  });

  test('builds an RFC 5322 message with required headers', () => {
    const msg = buildRfc5322Message({
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'Subject',
      body: 'Body line',
      messageId: '<id@example.com>',
      date: new Date('2024-01-02T03:04:05Z'),
    });
    expect(msg).toContain('From: sender@example.com');
    expect(msg).toContain('To: rcpt@example.com');
    expect(msg).toContain('Message-ID: <id@example.com>');
    expect(msg).toContain('Content-Transfer-Encoding: quoted-printable');
  });

  test('parses recipients and extracts addr-spec', () => {
    expect(parseRecipients('A <a@x.co>, b@y.co')).toEqual(['a@x.co', 'b@y.co']);
    expect(extractAddress('Name <a@x.co>')).toBe('a@x.co');
  });

  test('dot-stuffs leading dots', () => {
    expect(dotStuff('.hidden\r\n.again')).toBe('..hidden\r\n..again');
  });

  test('extracts a complete multi-line SMTP reply', () => {
    const reply = extractCompleteReply('250-first\r\n250 done\r\n');
    expect(reply?.code).toBe(250);
    expect(reply?.lines.length).toBe(2);
  });
});
