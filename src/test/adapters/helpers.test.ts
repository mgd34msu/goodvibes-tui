import { describe, expect, test } from 'bun:test';
import { readBearerOrHeaderToken, readTextBodyWithinLimit, verifySha256HmacSignature } from '@pellux/goodvibes-sdk/platform/adapters';
import { createHmac } from 'node:crypto';

describe('adapter helpers', () => {
  test('extracts explicit adapter tokens before bearer auth', () => {
    const req = new Request('http://goodvibes.local/webhook/test', {
      headers: {
        'x-goodvibes-test-token': 'adapter-token',
        Authorization: 'Bearer bearer-token',
      },
    });
    expect(readBearerOrHeaderToken(req, 'x-goodvibes-test-token')).toBe('adapter-token');
  });

  test('enforces request body limits before parsing webhook payloads', async () => {
    const req = new Request('http://goodvibes.local/webhook/test', {
      method: 'POST',
      headers: {
        'content-length': '1000001',
      },
      body: 'ignored',
    });
    const result = await readTextBodyWithinLimit(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  test('verifies sha256 hmac signatures for signed webhook providers', () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    const signature = `sha256=${createHmac('sha256', 'secret').update(rawBody).digest('hex')}`;
    expect(verifySha256HmacSignature(rawBody, 'secret', signature)).toBe(true);
    expect(verifySha256HmacSignature(rawBody, 'wrong', signature)).toBe(false);
  });
});
