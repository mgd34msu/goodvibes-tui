/**
 * Unit tests for the pure mapping/redaction helpers. These guarantee that the
 * daemon never emits a raw sender id, a credential, or PII in a preview.
 */
import { describe, expect, test } from 'bun:test';
import {
  BODY_PREVIEW_MAX,
  SUBJECT_PREVIEW_MAX,
  digestSender,
  normalizeWhitespace,
  sha256First,
  stripMarkup,
  stripPii,
  toBodyPreview,
  toSubjectPreview,
} from '../../../daemon/handlers/inbox/mapping.ts';

describe('digestSender', () => {
  test('returns a stable 16-hex-char digest, never the raw id', () => {
    const raw = 'U-some-workspace-user';
    const digest = digestSender(raw);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).not.toContain(raw);
    expect(digestSender(raw)).toBe(digest); // deterministic
  });

  test('distinct ids produce distinct digests', () => {
    expect(digestSender('alice')).not.toBe(digestSender('bob'));
  });

  test('sha256First slices the hex digest to the requested width', () => {
    expect(sha256First('hello', 12)).toHaveLength(12);
    expect(sha256First('hello', 64)).toHaveLength(64);
  });
});

describe('stripPii', () => {
  test('redacts email addresses', () => {
    expect(stripPii('reach me at jane.doe@example.com please')).toBe(
      'reach me at [email] please',
    );
  });

  test('redacts phone numbers and long account numbers', () => {
    expect(stripPii('call +1 (555) 123-4567 now')).toContain('[phone]');
    expect(stripPii('card 4111111111111111 expires')).toContain('[number]');
  });

  test('redacts IPv4 addresses', () => {
    expect(stripPii('host 10.0.0.42 down')).toBe('host [ip] down');
  });

  test('redacts a Slack-style token before it can leak', () => {
    // Word-style fake token (NOT a real-format secret).
    const redacted = stripPii('token is xoxb-EXAMPLE-faketoken-donotuse here');
    expect(redacted).toContain('[token]');
    expect(redacted).not.toContain('faketoken');
  });

  test('redacts a bearer token and key=value secrets', () => {
    expect(stripPii('Authorization: Bearer abcdefgh-EXAMPLE-faketoken')).toContain('[token]');
    const kv = stripPii('api_key = wordstyle-EXAMPLE-fakevalue-token');
    expect(kv).toContain('api_key=[token]');
    expect(kv).not.toContain('fakevalue');
  });

  test('leaves ordinary prose untouched', () => {
    expect(stripPii('hello there friend')).toBe('hello there friend');
  });
});

describe('stripMarkup', () => {
  test('strips HTML tags and decodes entities', () => {
    const out = stripMarkup('<p>Hi &amp; <b>bye</b></p>');
    expect(out).not.toContain('<');
    expect(out).toContain('&');
    expect(out).toContain('Hi');
  });

  test('drops script/style bodies entirely', () => {
    const out = stripMarkup('<style>.x{color:red}</style><script>steal()</script>visible');
    expect(out).not.toContain('steal');
    expect(out).not.toContain('color:red');
    expect(out).toContain('visible');
  });

  test('extracts the text/plain part of a multipart MIME body', () => {
    const mime = [
      '--BOUNDARY',
      'Content-Type: text/plain',
      '',
      'plain version here',
      '--BOUNDARY',
      'Content-Type: text/html',
      '',
      '<p>html version</p>',
      '--BOUNDARY--',
    ].join('\r\n');
    const out = normalizeWhitespace(stripMarkup(mime));
    expect(out).toContain('plain version here');
    expect(out).not.toContain('html version');
  });
});

describe('preview builders', () => {
  test('subject preview is capped and PII-stripped', () => {
    const long = 'x'.repeat(SUBJECT_PREVIEW_MAX + 50);
    expect(toSubjectPreview(long).length).toBe(SUBJECT_PREVIEW_MAX);
    expect(toSubjectPreview('re: a@b.com')).toBe('re: [email]');
    expect(toSubjectPreview(undefined)).toBe('');
  });

  test('body preview is capped, single-line, plain text, PII-stripped', () => {
    const long = 'y'.repeat(BODY_PREVIEW_MAX + 100);
    expect(toBodyPreview(long).length).toBe(BODY_PREVIEW_MAX);
    const out = toBodyPreview('<p>mail me at\n  x@y.com</p>');
    expect(out).toBe('mail me at [email]');
  });
});
