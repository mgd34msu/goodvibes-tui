import { describe, expect, test } from 'bun:test';
import {
  buildMissingScopeBody,
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
} from '@pellux/goodvibes-sdk/platform/daemon/http-policy';

describe('daemon http policy helpers', () => {
  test('resolveAuthenticatedPrincipal resolves principals from request auth', () => {
    const request = new Request('http://localhost/api', {
      headers: {
        Authorization: 'Bearer session-token',
      },
    });
    const principal = resolveAuthenticatedPrincipal(request, {
      extractAuthToken: (req) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
      describeAuthenticatedPrincipal: (token) => token === 'session-token'
        ? {
            principalId: 'alice',
            principalKind: 'user',
            admin: false,
            scopes: ['read:control-plane'],
          }
        : null,
    });
    expect(principal).toEqual({
      principalId: 'alice',
      principalKind: 'user',
      admin: false,
      scopes: ['read:control-plane'],
    });
  });

  test('buildMissingScopeBody respects wildcard scopes and returns detailed denials', () => {
    expect(buildMissingScopeBody('gateway.method', ['read:events'], ['read:*'])).toBeNull();
    expect(buildMissingScopeBody('gateway.method', ['write:knowledge'], ['read:knowledge'])).toEqual({
      error: 'Missing required scope for gateway.method: write:knowledge',
      requiredScopes: ['write:knowledge'],
      grantedScopes: ['read:knowledge'],
      missingScopes: ['write:knowledge'],
    });
  });

  test('resolvePrivateHostFetchOptions enforces config and elevated access consistently', async () => {
    expect(resolvePrivateHostFetchOptions(false, {
      configManager: { get: () => false },
    })).toEqual({});

    const disabled = resolvePrivateHostFetchOptions(true, {
      configManager: { get: () => false },
    });
    expect(disabled instanceof Response).toBe(true);
    expect(disabled instanceof Response ? disabled.status : 0).toBe(403);
    expect(disabled instanceof Response ? await disabled.json() : null).toEqual({
      error: 'Private-host remote fetches are disabled by config.',
    });

    const denied = resolvePrivateHostFetchOptions(true, {
      configManager: { get: () => true },
      req: new Request('http://localhost/api'),
      requireElevatedAccess: () => Response.json({ error: 'Admin role required' }, { status: 403 }),
    });
    expect(denied instanceof Response).toBe(true);
    expect(denied instanceof Response ? await denied.json() : null).toEqual({
      error: 'Admin role required',
    });

    expect(resolvePrivateHostFetchOptions(true, {
      configManager: { get: () => true },
      req: new Request('http://localhost/api'),
      requireElevatedAccess: () => null,
    })).toEqual({ allowPrivateHosts: true, fetchMode: 'allow-private-hosts' });
  });
});
