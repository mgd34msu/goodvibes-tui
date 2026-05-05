import { describe, expect, test } from 'bun:test';
import { extractForwardedClientIp } from '@/runtime/index.ts';

describe('runtime/network shared helpers', () => {
  test('extractForwardedClientIp only trusts forwarded headers when enabled', () => {
    const req = new Request('http://example.test', {
      headers: {
        'x-forwarded-for': '203.0.113.10, 10.0.0.5',
        'x-real-ip': '203.0.113.11',
      },
    });

    expect(extractForwardedClientIp(req, false)).toBeUndefined();
    expect(extractForwardedClientIp(req, true)).toBe('203.0.113.10');
  });
});
