import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticateOperatorRequest,
  authenticateOperatorToken,
  extractOperatorAuthToken,
  isOperatorAdmin,
  OPERATOR_SESSION_COOKIE_NAME,
} from '@pellux/goodvibes-sdk/platform/security';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';

describe('http auth helpers', () => {
  let userAuth: UserAuthManager;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'gv-http-auth-'));
    userAuth = new UserAuthManager({
      bootstrapFilePath: join(root, 'users.json'),
      bootstrapCredentialPath: join(root, 'bootstrap.txt'),
      users: [
        {
          username: 'admin',
          passwordHash: UserAuthManager.hashPassword('admin-password'),
          roles: ['admin'],
        },
        {
          username: 'operator',
          passwordHash: UserAuthManager.hashPassword('operator-password'),
          roles: ['operator'],
        },
      ],
    });
  });

  test('prefers bearer auth over the session cookie when both are present', () => {
    const request = new Request('http://localhost/api', {
      headers: {
        Authorization: 'Bearer shared-secret',
        Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=session-token`,
      },
    });
    expect(extractOperatorAuthToken(request)).toBe('shared-secret');
  });

  test('authenticates shared tokens and treats them as admin', () => {
    const request = new Request('http://localhost/api', {
      headers: {
        Authorization: 'Bearer shared-secret',
      },
    });
    const authenticated = authenticateOperatorRequest(request, {
      sharedToken: 'shared-secret',
      userAuth,
    });
    expect(authenticated).toEqual({
      kind: 'shared-token',
      token: 'shared-secret',
    });
    expect(isOperatorAdmin(authenticated)).toBe(true);
  });

  test('authenticates local sessions from cookies', () => {
    const session = userAuth.createSession('admin');
    const request = new Request('http://localhost/api', {
      headers: {
        Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      },
    });
    const authenticated = authenticateOperatorRequest(request, {
      userAuth,
    });
    expect(authenticated).toEqual({
      kind: 'session',
      token: session.token,
      username: 'admin',
      roles: ['admin'],
    });
    expect(isOperatorAdmin(authenticated)).toBe(true);
  });

  test('returns null for invalid credentials and keeps non-admin sessions non-admin', () => {
    const operatorSession = userAuth.createSession('operator');
    expect(authenticateOperatorToken('wrong-token', { userAuth })).toBeNull();

    const authenticated = authenticateOperatorToken(operatorSession.token, { userAuth });
    expect(authenticated).toEqual({
      kind: 'session',
      token: operatorSession.token,
      username: 'operator',
      roles: ['operator'],
    });
    expect(isOperatorAdmin(authenticated)).toBe(false);
  });
});
