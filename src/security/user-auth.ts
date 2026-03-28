import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export interface AuthUser {
  username: string;
  passwordHash: string;
  roles?: string[];
}

export interface AuthSession {
  token: string;
  username: string;
  expiresAt: number;
}

interface UserAuthConfig {
  sessionTtlMs?: number;
  users?: AuthUser[];
}

const DEFAULT_SESSION_TTL_MS = 3_600_000;

function toBase64(value: Buffer): string {
  return value.toString('base64');
}

function hashPassword(password: string, salt?: Buffer): string {
  const actualSalt = salt ?? randomBytes(16);
  const derived = scryptSync(password, actualSalt, 64);
  return `${toBase64(actualSalt)}:${toBase64(derived)}`;
}

/**
 * Generate a cryptographically random one-time password.
 * Called once on first boot when no users are configured.
 */
function generateInitialPassword(): string {
  return randomBytes(16).toString('hex');
}

function verifyPassword(password: string, passwordHash: string): boolean {
  const [saltEncoded, hashEncoded] = passwordHash.split(':');
  if (!saltEncoded || !hashEncoded) return false;

  const salt = Buffer.from(saltEncoded, 'base64');
  const expected = Buffer.from(hashEncoded, 'base64');
  const actual = scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export class UserAuthManager {
  private users = new Map<string, AuthUser>();
  private sessions = new Map<string, AuthSession>();
  private sessionTtlMs: number;

  constructor(config: UserAuthConfig = {}) {
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    const seedUsers = config.users ?? (() => {
      // No users configured — generate a random one-time admin password.
      // The password is printed to stderr once so the operator can retrieve it.
      const initialPassword = generateInitialPassword();
      process.stderr.write(
        `[goodvibes] No users configured. Generated initial admin password: ${initialPassword}\n` +
        `[goodvibes] Change this password immediately via the admin API.\n`,
      );
      return [
        {
          username: 'admin',
          passwordHash: hashPassword(initialPassword),
          roles: ['admin'],
        },
      ];
    })();

    for (const user of seedUsers) {
      this.users.set(user.username, user);
    }
  }

  static hashPassword(password: string): string {
    return hashPassword(password);
  }

  authenticate(username: string, password: string): AuthUser | null {
    const user = this.users.get(username);
    if (!user) return null;
    return verifyPassword(password, user.passwordHash) ? user : null;
  }

  createSession(username: string): AuthSession {
    this.pruneExpiredSessions();
    const token = randomBytes(32).toString('hex');
    const session: AuthSession = {
      token,
      username,
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    this.sessions.set(token, session);
    return session;
  }

  validateSession(token: string): AuthSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revokeSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }
}
