import { describe, expect, test } from 'bun:test';
import {
  decodeHeader,
  imapDate,
  parseFetchResponse,
} from '../../../daemon/channels/inbox/providers/imap-client.ts';

describe('imap pure parsers', () => {
  test('imapDate formats Unix-ms as dd-Mon-yyyy (UTC)', () => {
    const ms = Date.UTC(2024, 0, 5); // 2024-01-05
    expect(imapDate(ms)).toBe('05-Jan-2024');
  });

  test('decodeHeader decodes RFC 2047 base64 and Q-encoding', () => {
    expect(decodeHeader('=?UTF-8?B?SGVsbG8gV29ybGQ=?=')).toBe('Hello World');
    expect(decodeHeader('=?UTF-8?Q?Hi_there=21?=')).toBe('Hi there!');
    expect(decodeHeader('plain subject')).toBe('plain subject');
  });

  test('parseFetchResponse extracts uid, flags, headers, and body literal', () => {
    const header = 'From: Alice <alice@example.com>\r\nSubject: Lunch?\r\nDate: Wed, 03 Jan 2024 10:00:00 +0000\r\n';
    const body = 'Hey, are you free for lunch today?';
    const raw =
      `* 1 FETCH (UID 42 FLAGS () INTERNALDATE "03-Jan-2024 10:00:00 +0000" `
      + `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${header.length}}\r\n${header}`
      + ` BODY[TEXT]<0> {${body.length}}\r\n${body})\r\n`
      + `A0002 OK FETCH completed\r\n`;
    const envelopes = parseFetchResponse(raw);
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0]!;
    expect(env.uid).toBe(42);
    expect(env.from).toBe('Alice <alice@example.com>');
    expect(env.subject).toBe('Lunch?');
    expect(env.seen).toBe(false);
    expect(env.bodyPreview).toBe(body);
    expect(env.date).toBe(Date.parse('Wed, 03 Jan 2024 10:00:00 +0000'));
  });

  test('parseFetchResponse marks \\Seen flag', () => {
    const header = 'From: bob@example.com\r\nSubject: x\r\n';
    const raw =
      `* 2 FETCH (UID 7 FLAGS (\\Seen) `
      + `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${header.length}}\r\n${header} `
      + `BODY[TEXT]<0> {1}\r\nz)\r\n`;
    const env = parseFetchResponse(raw)[0]!;
    expect(env.seen).toBe(true);
    expect(env.uid).toBe(7);
  });

  test('parseFetchResponse skips entries without a UID', () => {
    const raw = '* 1 FETCH (FLAGS ())\r\n';
    expect(parseFetchResponse(raw)).toHaveLength(0);
  });
});
