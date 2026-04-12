/**
 * Tests for fetch tool auth integration (inline auth + service registry auth).
 * Kept in a separate file to avoid growing fetch.test.ts further.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createFetchTool } from '../../tools/fetch/index.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Local test server — echoes headers so we can verify auth was applied
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/echo') {
        return Response.json({
          method: req.method,
          headers: Object.fromEntries(req.headers),
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

// ---------------------------------------------------------------------------
// Inline auth: bearer
// ---------------------------------------------------------------------------

describe('fetch tool - inline auth bearer', () => {
  test('sends Authorization: Bearer header', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'bearer', token: 'my-secret-token' },
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['authorization']).toBe('Bearer my-secret-token');
  });

  test('does not send Authorization when bearer token is missing', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'bearer' }, // no token
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    // No authorization header should be added
    expect(echo.headers['authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inline auth: basic
// ---------------------------------------------------------------------------

describe('fetch tool - inline auth basic', () => {
  test('sends Authorization: Basic header with base64 username:password', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'basic', username: 'alice', password: 'p4ssw0rd' },
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    const expected = 'Basic ' + Buffer.from('alice:p4ssw0rd').toString('base64');
    expect(echo.headers['authorization']).toBe(expected);
  });

  test('handles missing password as empty string', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'basic', username: 'bob' },
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    const expected = 'Basic ' + Buffer.from('bob:').toString('base64');
    expect(echo.headers['authorization']).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Inline auth: api-key
// ---------------------------------------------------------------------------

describe('fetch tool - inline auth api-key', () => {
  test('sends X-API-Key header by default', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'api-key', key: 'my-api-key-value' },
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['x-api-key']).toBe('my-api-key-value');
  });

  test('sends custom header when auth.header is specified', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'api-key', header: 'X-Auth-Token', key: 'custom-token' },
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['x-auth-token']).toBe('custom-token');
    expect(echo.headers['x-api-key']).toBeUndefined();
  });

  test('does not send api-key header when key is missing', async () => {
    const fetchTool = createFetchTool();
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        extract: 'json',
        auth: { type: 'api-key' }, // no key
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['x-api-key']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Service registry auth
// ---------------------------------------------------------------------------

describe('fetch tool - service registry auth', () => {
  test('applies bearer auth from service registry via env var', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gv-fetch-auth-'));
    try {
      writeFileSync(join(tempDir, 'services.json'), JSON.stringify({
        echo: { name: 'echo', authType: 'bearer', tokenKey: 'TEST_SERVICE_TOKEN' },
      }, null, 2), 'utf-8');

      const origToken = process.env['TEST_SERVICE_TOKEN'];
      process.env['TEST_SERVICE_TOKEN'] = 'registry-bearer-token';
      try {
        const registry = new ServiceRegistry(join(tempDir, 'services.json'));
        const fetchTool = createFetchTool({ serviceRegistry: registry });
        const result = await fetchTool.execute({
          urls: [{
            url: `${base}/echo`,
            extract: 'json',
            service: 'echo',
          }],
        });
        expect(result.success).toBe(true);
        const out = JSON.parse(result.output!);
        const echo = JSON.parse(out.results[0].content);
        expect(echo.headers['authorization']).toBe('Bearer registry-bearer-token');
      } finally {
        if (origToken === undefined) delete process.env['TEST_SERVICE_TOKEN'];
        else process.env['TEST_SERVICE_TOKEN'] = origToken;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('inline auth takes precedence over service field (auth wins when both set)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gv-fetch-auth-'));
    writeFileSync(join(tempDir, 'services.json'), JSON.stringify({
      echo: { name: 'echo', authType: 'bearer', tokenKey: 'TEST_SERVICE_TOKEN' },
    }, null, 2), 'utf-8');
    try {
      const registry = new ServiceRegistry(join(tempDir, 'services.json'));
      const fetchTool = createFetchTool({ serviceRegistry: registry });
      const result = await fetchTool.execute({
        urls: [{
          url: `${base}/echo`,
          extract: 'json',
          auth: { type: 'bearer', token: 'inline-wins' },
          service: 'echo',
        }],
      });
      expect(result.success).toBe(true);
      const out = JSON.parse(result.output!);
      const echo = JSON.parse(out.results[0].content);
      // Inline auth should have been applied
      expect(echo.headers['authorization']).toBe('Bearer inline-wins');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
