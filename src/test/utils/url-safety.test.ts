import { describe, expect, test } from 'bun:test';
import { validatePublicWebhookUrl } from '@pellux/goodvibes-sdk/platform/utils/url-safety';

describe('validatePublicWebhookUrl', () => {
  test('accepts normalized public https webhook URLs', () => {
    expect(validatePublicWebhookUrl('https://example.com/callback?run=1')).toEqual({
      ok: true,
      url: 'https://example.com/callback?run=1',
    });
  });

  test('rejects non-public or credential-bearing webhook URLs', () => {
    const unsafeUrls = [
      'http://example.com/callback',
      'https://user:pass@example.com/callback',
      'https://localhost/callback',
      'https://api.localhost/callback',
      'https://metadata.google.internal/computeMetadata/v1',
      'https://127.0.0.1/callback',
      'https://10.0.0.5/callback',
      'https://172.16.0.5/callback',
      'https://192.168.1.5/callback',
      'https://[::1]/callback',
      'https://[::ffff:127.0.0.1]/callback',
      'https://[fd00::1]/callback',
      'https://[fe80::1]/callback',
    ];

    for (const url of unsafeUrls) {
      expect(validatePublicWebhookUrl(url).ok).toBe(false);
    }
  });
});
