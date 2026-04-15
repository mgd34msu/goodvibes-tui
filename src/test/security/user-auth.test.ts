import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';

describe('UserAuthManager local admin management', () => {
  let dir: string;
  let usersPath: string;
  let bootstrapPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-auth-'));
    usersPath = join(dir, 'auth-users.json');
    bootstrapPath = join(dir, 'auth-bootstrap.txt');
  });

  test('addUser persists and inspect reports bootstrap posture', () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });

    const added = auth.addUser('ops', 'supersecret', ['admin', 'operator']);
    const snapshot = auth.inspect();
    const stored = readFileSync(usersPath, 'utf-8');

    expect(added.username).toBe('ops');
    expect(snapshot.userCount).toBe(2);
    expect(snapshot.users.some((user) => user.username === 'ops')).toBe(true);
    expect(stored).toContain('"username": "ops"');
  });

  test('rotatePassword revokes sessions and updates bootstrap file for admin', () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });
    const session = auth.createSession('admin');

    auth.rotatePassword('admin', 'new-password-123');

    expect(auth.validateSession(session.token)).toBeNull();
    expect(readFileSync(bootstrapPath, 'utf-8')).toContain('password=new-password-123');
  });

  test('deleteUser refuses to remove the last user', () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'auth-users.json'),
      bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin-pass'), roles: ['admin'] }],
    });

    expect(() => auth.deleteUser('admin')).toThrow(/last local auth user/i);
  });
});
