import { describe, expect, test } from 'bun:test';
import {
  BODY_PREVIEW_MAX,
  SUBJECT_PREVIEW_MAX,
  digestSender,
  normalizeWhitespace,
  stripMarkup,
  stripPii,
  toBodyPreview,
  toSubjectPreview,
} from '../../../daemon/channels/inbox/mapping.ts';
import { sha256First } from '../../../daemon/operator/index.ts';

describe('inbox mapping helpers', () => {
  test('digestSender produces a stable 16-hex token matching sha256First', () => {
    const digest = digestSender('slack:U12345');
    expect(digest).toBe(sha256First('slack:U12345', 16));
    expect(digest).toHaveLength(16);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    // determinism
    expect(digestSender('slack:U12345')).toBe(digest);
  });

  test('digest never exposes the raw id', () => {
    const raw = 'user@example.com';
    expect(digestSender(raw)).not.toContain(raw);
  });

  test('stripPii redacts emails, phones, long numbers and ips', () => {
    const input = 'mail me at john.doe@example.com or +1 (555) 123-4567, card 4111111111111111 from 10.0.0.5';
    const out = stripPii(input);
    expect(out).not.toContain('john.doe@example.com');
    expect(out).not.toContain('4111111111111111');
    expect(out).not.toContain('10.0.0.5');
    expect(out).toContain('[email]');
    expect(out).toContain('[number]');
    expect(out).toContain('[ip]');
    expect(out).toContain('[phone]');
  });

  test('stripPii redacts OAuth / bearer / API tokens', () => {
    const slack = stripPii('token is xoxb-EXAMPLE-faketoken-zzzz here');
    expect(slack).not.toContain('xoxb-EXAMPLE');
    expect(slack).toContain('[token]');

    const bearer = stripPii('Authorization: Bearer abc123DEF456ghi789JKL012');
    expect(bearer).not.toContain('abc123DEF456ghi789JKL012');
    expect(bearer).toContain('[token]');

    const realJwt = stripPii('here eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36 done');
    expect(realJwt).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(realJwt).toContain('[token]');

    const openai = stripPii('key=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(openai).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(openai).toContain('[token]');

    const kv = stripPii('api_key: a1b2c3d4e5f6g7h8');
    expect(kv).toContain('api_key:');
    expect(kv).not.toContain('a1b2c3d4e5f6g7h8');
    expect(kv).toContain('[token]');
  });

  test('stripPii leaves ordinary prose words intact (no false-positive token redaction)', () => {
    const prose = 'The quick brown fox jumped over the lazy dog repeatedly today';
    expect(stripPii(prose)).toBe(prose);
  });

  test('stripMarkup strips HTML tags and decodes entities', () => {
    const html = '<html><body><p>Hello&nbsp;<b>world</b></p><script>steal()</script></body></html>';
    const out = normalizeWhitespace(stripMarkup(html));
    expect(out).toBe('Hello world');
    expect(out).not.toContain('<');
    expect(out).not.toContain('steal');
  });

  test('stripMarkup de-MIMEs multipart, preferring text/plain', () => {
    const mime = [
      'Content-Type: multipart/alternative; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain body here',
      '--BOUND',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML body here</p>',
      '--BOUND--',
    ].join('\r\n');
    const out = normalizeWhitespace(stripMarkup(mime));
    expect(out).toBe('Plain body here');
    expect(out).not.toContain('boundary');
    expect(out).not.toContain('Content-Type');
  });

  test('stripMarkup leaves plain text unchanged (no-op)', () => {
    expect(stripMarkup('just a normal sentence.')).toBe('just a normal sentence.');
  });

  test('toBodyPreview produces clean text from an HTML email body', () => {
    const html = '<div>Hi there,<br>see <a href="http://x">link</a> and contact a@b.com</div>';
    const preview = toBodyPreview(html);
    expect(preview).not.toContain('<');
    expect(preview).not.toContain('href');
    expect(preview).toContain('Hi there,');
    expect(preview).toContain('[email]');
  });

  test('normalizeWhitespace collapses and trims', () => {
    expect(normalizeWhitespace('  a\n\t  b   c  ')).toBe('a b c');
  });

  test('toSubjectPreview enforces the 200-char cap and strips PII', () => {
    const long = 'x'.repeat(300);
    expect(toSubjectPreview(long)).toHaveLength(SUBJECT_PREVIEW_MAX);
    expect(toSubjectPreview('hi a@b.com')).toBe('hi [email]');
    expect(toSubjectPreview(undefined)).toBe('');
  });

  test('toBodyPreview enforces the 500-char cap and is single-line', () => {
    const long = 'y'.repeat(900);
    expect(toBodyPreview(long)).toHaveLength(BODY_PREVIEW_MAX);
    expect(toBodyPreview('line1\nline2')).toBe('line1 line2');
  });
});
