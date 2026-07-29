/**
 * auth-behavior.test.ts — TASK-038 daemon-auth security behavior pins
 *
 * Pins three security behaviors the TUI depends on from the SDK's
 * HttpListener / UserAuthManager surfaces:
 *
 *   1. Rate limiter: POST /login is throttled to 5 attempts/min per IP.
 *   2. Forwarded-IP spoofing: with trustProxy OFF, X-Forwarded-For / X-Real-IP
 *      headers cannot rotate the rate-limiter bucket.
 *      With trustProxy ON, documenting current behavior (header IS trusted for
 *      bucket key) — NOTE: CF range validation is not yet performed by the SDK
 *      (handoff Item 5). Tests named to reflect TODAY's behavior, not a safety
 *      assertion.
 *   3. Empty/whitespace password regression: rejected on addUser, rotatePassword,
 *      and the /login endpoint.
 *
 * CF-Connecting-IP is SDK-internal-unreachable:
 *   extractForwardedClientIp only reads x-forwarded-for / x-real-ip, not
 *   CF-Connecting-IP. CF-Connecting-IP behavior cannot be pinned from TUI-side.
 *
 * Harness: HttpListener on an isolated port with a custom serveFactory (skips
 * OS port check). No sleeps >100 ms. No real network on fixed ports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { HttpListener } from '@pellux/goodvibes-sdk/platform/daemon';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeTempAuthEnv(): {
  configManager: ConfigManager;
  userAuth: UserAuthManager;
} {
  const dir = makeProjectTempDir('gv-auth-behavior');
  const configManager = new ConfigManager({
    surfaceRoot: 'tui',
    configDir: join(dir, 'config'),
    workingDir: dir,
    homeDir: dir,
  });
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
    users: [
      {
        username: 'admin',
        passwordHash: UserAuthManager.hashPassword('admin-pass-ok'),
        roles: ['admin'],
      },
    ],
  });
  return { configManager, userAuth };
}

/**
 * Starts an HttpListener on the given port with a custom serveFactory that
 * bypasses the OS port-availability check.
 *
 * Bun.serve is not injected — a proxy around Bun.serve is used so that the
 * listener acquires a real TCP socket (needed for fetch()) while still skipping
 * the pre-bind probe.
 */
async function startListener(opts: {
  port: number;
  configManager: ConfigManager;
  userAuth: UserAuthManager;
  loginRateLimit?: number;
  trustProxy?: boolean;
}): Promise<{ listener: HttpListener; baseUrl: string }> {
  // Custom serveFactory: wraps Bun.serve so the identity check
  // (this.serveFactory === Bun.serve) is FALSE, skipping requirePortAvailable.
  const serveFactory: typeof Bun.serve = (options) => Bun.serve(options as Parameters<typeof Bun.serve>[0]);

  const listener = new HttpListener({
    port: opts.port,
    host: '127.0.0.1',
    configManager: opts.configManager,
    userAuth: opts.userAuth,
    loginRateLimit: opts.loginRateLimit,
    trustProxy: opts.trustProxy,
    serveFactory,
  });

  listener.enable({ httpListener: true }, 'test-shared-token');
  await listener.start();
  return { listener, baseUrl: `http://127.0.0.1:${opts.port}` };
}

function loginRequest(
  baseUrl: string,
  username: string,
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ username, password }),
  });
}

// Ephemeral port per listener: a fixed 39700+ range collided intermittently
// with lingering sockets from concurrent test files (flaky "port in use"
// startup failures). Ask the OS for a genuinely free port instead.
function nextPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('Bun.serve did not assign a port for the free-port probe');
  return port;
}

// ---------------------------------------------------------------------------
// 1. Rate-limiter behavior: per-IP throttling on login attempts
// ---------------------------------------------------------------------------

describe('login rate limiter — per-IP throttling', () => {
  let listener: HttpListener;
  let baseUrl: string;

  beforeEach(async () => {
    const { configManager, userAuth } = makeTempAuthEnv();
    ({ listener, baseUrl } = await startListener({
      port: nextPort(),
      configManager,
      userAuth,
      // Override to 3 so we don't need to fire 5 real requests; same code path.
      loginRateLimit: 3,
    }));
  });

  afterEach(async () => {
    await listener.stop();
  });

  test('allows login attempts up to the configured limit', async () => {
    // The limit is 3 for this suite. Attempts 1–3 must not be rate-limited
    // (though they may return 401 for bad credentials).
    for (let i = 1; i <= 3; i++) {
      const res = await loginRequest(baseUrl, 'admin', 'wrong-password');
      // 401 = auth failure; anything except 429 means the limiter allowed it.
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(401);
    }
  });

  test('returns 429 once the per-IP limit is exceeded', async () => {
    // Exhaust the 3-request budget with wrong credentials.
    for (let i = 0; i < 3; i++) {
      await loginRequest(baseUrl, 'admin', 'wrong-password');
    }

    // The 4th attempt must be rate-limited.
    const blocked = await loginRequest(baseUrl, 'admin', 'wrong-password');
    expect(blocked.status).toBe(429);
    const body = await blocked.json() as { error: string };
    expect(body.error).toMatch(/too many requests/i);
  });

  test('blocks even valid credentials once the per-IP limit is exceeded', async () => {
    // Exhaust the budget with bad credentials.
    for (let i = 0; i < 3; i++) {
      await loginRequest(baseUrl, 'admin', 'wrong-password');
    }

    // The 4th attempt with correct credentials must still be blocked.
    const blocked = await loginRequest(baseUrl, 'admin', 'admin-pass-ok');
    expect(blocked.status).toBe(429);
  });

  test('default loginRateLimit is 5 — SDK constant pinned to guard against regression', async () => {
    // Proves the SDK default is 5 by exercising the `?? 5` fallback at
    // http-listener.js:79 via a listener started WITHOUT loginRateLimit.
    // If the SDK default changes, this test fails — that is the point.
    const { configManager, userAuth } = makeTempAuthEnv();
    const { listener: defaultListener, baseUrl: defaultBaseUrl } = await startListener({
      port: nextPort(),
      configManager,
      userAuth,
      // loginRateLimit intentionally omitted — SDK must supply the default of 5
    });

    try {
      // Attempts 1–5: must all return 401 (auth failure), never 429.
      for (let i = 1; i <= 5; i++) {
        const res = await loginRequest(defaultBaseUrl, 'admin', 'wrong-password');
        expect(res.status).toBe(401);
      }

      // Attempt 6: must return 429 — proves the default limit is exactly 5.
      const blocked = await loginRequest(defaultBaseUrl, 'admin', 'wrong-password');
      expect(blocked.status).toBe(429);
    } finally {
      await defaultListener.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 2a. Forwarded-IP spoofing: trustProxy OFF — headers do NOT rotate bucket
// ---------------------------------------------------------------------------

describe('forwarded-IP spoofing — trustProxy OFF (headers ignored for rate bucket)', () => {
  let listener: HttpListener;
  let baseUrl: string;

  beforeEach(async () => {
    const { configManager, userAuth } = makeTempAuthEnv();
    ({ listener, baseUrl } = await startListener({
      port: nextPort(),
      configManager,
      userAuth,
      loginRateLimit: 3,
      trustProxy: false, // explicit OFF — the default
    }));
  });

  afterEach(async () => {
    await listener.stop();
  });

  test(
    'rotating X-Forwarded-For headers does NOT rotate the rate-limiter bucket',
    async () => {
      // With trustProxy OFF, extractForwardedClientIp returns undefined and
      // the listener falls back to the connection remote address ('unknown'
      // for Bun in-process). All requests land in the same IP bucket regardless
      // of the X-Forwarded-For value.
      //
      // Send 3 requests each with a DIFFERENT X-Forwarded-For value.
      // If headers were trusted, each would be a fresh bucket and none would
      // trigger the 3-request limit. If headers are correctly ignored, the
      // 3rd request exhausts the single bucket and the 4th is blocked.
      const ips = ['1.2.3.4', '5.6.7.8', '9.10.11.12'];
      for (const ip of ips) {
        await loginRequest(baseUrl, 'admin', 'wrong-password', {
          'X-Forwarded-For': ip,
        });
      }

      // 4th request with yet another spoofed IP — still blocked because all
      // prior requests landed in the same bucket.
      const blocked = await loginRequest(baseUrl, 'admin', 'wrong-password', {
        'X-Forwarded-For': '200.1.2.3',
      });
      expect(blocked.status).toBe(429);
    },
  );

  test(
    'rotating X-Real-IP headers does NOT rotate the rate-limiter bucket',
    async () => {
      // Same logic but for x-real-ip header.
      const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
      for (const ip of ips) {
        await loginRequest(baseUrl, 'admin', 'wrong-password', {
          'X-Real-IP': ip,
        });
      }

      const blocked = await loginRequest(baseUrl, 'admin', 'wrong-password', {
        'X-Real-IP': '10.0.0.99',
      });
      expect(blocked.status).toBe(429);
    },
  );

  test(
    // NOTE: CF-Connecting-IP is SDK-internal-unreachable from TUI-side.
    // extractForwardedClientIp does not read CF-Connecting-IP at all —
    // it only reads x-forwarded-for and x-real-ip. CF-specific behavior
    // is not pinnable from TUI-side tests.
    'CF-Connecting-IP header is ignored (same bucket as all other requests)',
    async () => {
      const ips = ['103.21.244.1', '103.22.200.1', '103.31.4.1'];
      for (const ip of ips) {
        await loginRequest(baseUrl, 'admin', 'wrong-password', {
          'CF-Connecting-IP': ip,
        });
      }

      // CF header does not provide any IP isolation — 4th request still blocked.
      const blocked = await loginRequest(baseUrl, 'admin', 'wrong-password', {
        'CF-Connecting-IP': '141.101.64.1',
      });
      expect(blocked.status).toBe(429);
    },
  );
});

// ---------------------------------------------------------------------------
// 2b. Forwarded-IP spoofing: trustProxy ON — documenting current behavior
//
// NOTE: This describe block pins TODAY's behavior when trustProxy is ON.
// The SDK currently does NOT validate that X-Forwarded-For IPs come from
// legitimate Cloudflare ranges (handoff Item 5). That means an attacker who
// can send arbitrary headers to the listener can rotate their rate-limit
// bucket by changing X-Forwarded-For.
//
// These tests are named to reflect the CURRENT state. They are NOT safety
// assertions. When Item 5 is resolved (CF range validation added to the SDK),
// update these tests to verify the new validation behavior.
// ---------------------------------------------------------------------------

describe('forwarded-IP spoofing — trustProxy ON (current behavior, no CF range validation)', () => {
  let listener: HttpListener;
  let baseUrl: string;

  beforeEach(async () => {
    const { configManager, userAuth } = makeTempAuthEnv();
    ({ listener, baseUrl } = await startListener({
      port: nextPort(),
      configManager,
      userAuth,
      loginRateLimit: 3,
      trustProxy: true, // intentionally enabled
    }));
  });

  afterEach(async () => {
    await listener.stop();
  });

  test(
    // TODAY: with trustProxy ON, different X-Forwarded-For values produce
    // different rate-limiter buckets, allowing header-rotation bypass.
    // This is a KNOWN LIMITATION (Item 5: no CF range validation).
    // DO NOT read this test as "header rotation is safe" — it is not.
    '[current-behavior] distinct X-Forwarded-For values land in distinct buckets (known Item-5 gap)',
    async () => {
      // Send 3 requests, each with a different X-Forwarded-For.
      // With trustProxy ON, each has its own bucket → none are rate-limited.
      const ips = ['1.2.3.4', '5.6.7.8', '9.10.11.12'];
      for (const ip of ips) {
        const res = await loginRequest(baseUrl, 'admin', 'wrong-password', {
          'X-Forwarded-For': ip,
        });
        // Each should be allowed (401 = auth failure, NOT rate-limited)
        expect(res.status).toBe(401);
      }

      // With same IP repeated, the 4th attempt IS rate-limited.
      await loginRequest(baseUrl, 'admin', 'wrong-password', {
        'X-Forwarded-For': '1.2.3.4',
      });
      // That was #2 for '1.2.3.4'; we need one more to hit the limit.
      await loginRequest(baseUrl, 'admin', 'wrong-password', {
        'X-Forwarded-For': '1.2.3.4',
      });
      const blocked = await loginRequest(baseUrl, 'admin', 'wrong-password', {
        'X-Forwarded-For': '1.2.3.4',
      });
      expect(blocked.status).toBe(429);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Empty/whitespace password regression
//
// The SDK regression flagged in the dive: empty or whitespace passwords must
// be rejected at every entry point: addUser, rotatePassword, and /login.
// ---------------------------------------------------------------------------

describe('empty/whitespace password rejection', () => {
  // --- 3a. UserAuthManager.addUser rejects empty/short passwords ---

  test('addUser rejects empty password', () => {
    const dir = makeProjectTempDir('gv-pw-empty');
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    expect(() => auth.addUser('newuser', '')).toThrow(/password must be at least 8 characters/i);
  });

  test('addUser rejects whitespace-only password (length < 8)', () => {
    const dir = makeProjectTempDir('gv-pw-ws');
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    // Single spaces are shorter than 8 chars — also caught by the length guard.
    expect(() => auth.addUser('newuser', '   ')).toThrow(/password must be at least 8 characters/i);
  });

  test('addUser rejects password shorter than 8 characters', () => {
    const dir = makeProjectTempDir('gv-pw-short');
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    expect(() => auth.addUser('newuser', 'short')).toThrow(/password must be at least 8 characters/i);
  });

  // --- 3b. UserAuthManager.rotatePassword rejects empty/short passwords ---

  test('rotatePassword rejects empty password', () => {
    const dir = makeProjectTempDir('gv-rot-empty');
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    expect(() => auth.rotatePassword('admin', '')).toThrow(/password must be at least 8 characters/i);
  });

  test('rotatePassword rejects whitespace-only password (length < 8)', () => {
    const dir = makeProjectTempDir('gv-rot-ws');
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    expect(() => auth.rotatePassword('admin', '   ')).toThrow(/password must be at least 8 characters/i);
  });

  test('rotatePassword rejects password shorter than 8 characters', () => {
    const dir = makeProjectTempDir('gv-rot-short');
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    expect(() => auth.rotatePassword('admin', 'abc123')).toThrow(/password must be at least 8 characters/i);
  });

  // --- 3c. POST /login rejects empty password at the HTTP layer ---

  describe('POST /login rejects empty and whitespace passwords', () => {
    let listener: HttpListener;
    let baseUrl: string;

    beforeEach(async () => {
      const { configManager, userAuth } = makeTempAuthEnv();
      ({ listener, baseUrl } = await startListener({
        port: nextPort(),
        configManager,
        userAuth,
        loginRateLimit: 20, // high limit — we don't want rate-limiting to interfere
      }));
    });

    afterEach(async () => {
      await listener.stop();
    });

    test('empty password returns 401, not 200', async () => {
      // authenticate() hashes the empty string and compares — mismatch → null → 401.
      const res = await loginRequest(baseUrl, 'admin', '');
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/invalid credentials/i);
    });

    test('whitespace-only password returns 401, not 200', async () => {
      const res = await loginRequest(baseUrl, 'admin', '   ');
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/invalid credentials/i);
    });

    test('null/missing password field returns 401, not 500', async () => {
      // handleLogin: `typeof body.password === 'string' ? body.password : ''`
      // So a missing field becomes '' → authenticate('admin', '') → null → 401.
      const res = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }), // no password field
      });
      expect(res.status).toBe(401);
    });

    test('correct credentials still authenticate after above attempts', async () => {
      // Regression guard: the previous bad attempts must not corrupt state.
      await loginRequest(baseUrl, 'admin', '');
      await loginRequest(baseUrl, 'admin', '   ');
      const res = await loginRequest(baseUrl, 'admin', 'admin-pass-ok');
      expect(res.status).toBe(200);
    });
  });
});
