import { timingSafeEqual } from 'node:crypto';
import type { UserAuthManager } from './user-auth.ts';

export const OPERATOR_SESSION_COOKIE_NAME = 'goodvibes_session';

export type AuthenticatedOperatorRequest =
  | {
      readonly kind: 'shared-token';
      readonly token: string;
    }
  | {
      readonly kind: 'session';
      readonly token: string;
      readonly username: string;
      readonly roles: readonly string[];
    };

interface SessionCookieOptions {
  readonly req: Request;
  readonly expiresAt: number;
  readonly trustProxy?: boolean;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const segment of header.split(';')) {
    const [rawName, ...rawValueParts] = segment.split('=');
    const name = rawName?.trim();
    if (!name) continue;
    const rawValue = rawValueParts.join('=').trim();
    if (!rawValue) continue;
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
}

function isSecureRequest(req: Request, trustProxy = false): boolean {
  try {
    const url = new URL(req.url);
    if (url.protocol === 'https:') return true;
  } catch {
    // Ignore malformed URLs; Bun always provides a valid request URL.
  }
  if (!trustProxy) return false;
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? '';
  return forwardedProto
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .some((value) => value === 'https');
}

export function extractOperatorAuthToken(
  req: Request,
): string {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const sessionCookie = parseCookies(req.headers.get('cookie')).get(OPERATOR_SESSION_COOKIE_NAME)?.trim();
  if (sessionCookie) return sessionCookie;

  return '';
}

function matchesSharedToken(token: string, sharedToken: string): boolean {
  if (token.length !== sharedToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(sharedToken));
}

export function authenticateOperatorToken(
  token: string,
  context: {
    readonly sharedToken?: string | null;
    readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'getUser'>;
  },
): AuthenticatedOperatorRequest | null {
  const normalized = token.trim();
  if (!normalized) return null;

  if (context.sharedToken) {
    return matchesSharedToken(normalized, context.sharedToken)
      ? { kind: 'shared-token', token: normalized }
      : null;
  }

  const session = context.userAuth.validateSession(normalized);
  if (!session) return null;
  const user = context.userAuth.getUser(session.username);
  if (!user) return null;
  return {
    kind: 'session',
    token: normalized,
    username: user.username,
    roles: user.roles,
  };
}

export function authenticateOperatorRequest(
  req: Request,
  context: {
    readonly sharedToken?: string | null;
    readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'getUser'>;
  },
): AuthenticatedOperatorRequest | null {
  return authenticateOperatorToken(extractOperatorAuthToken(req), context);
}

export function isOperatorAdmin(authenticated: AuthenticatedOperatorRequest | null): boolean {
  if (!authenticated) return false;
  return authenticated.kind === 'shared-token' || authenticated.roles.includes('admin');
}

export function buildOperatorSessionCookie(token: string, options: SessionCookieOptions): string {
  const maxAgeSeconds = Math.max(0, Math.floor((options.expiresAt - Date.now()) / 1_000));
  const secure = isSecureRequest(options.req, options.trustProxy);
  const parts = [
    `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(options.expiresAt).toUTCString()}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildExpiredOperatorSessionCookie(req: Request, trustProxy = false): string {
  const parts = [
    `${OPERATOR_SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (isSecureRequest(req, trustProxy)) parts.push('Secure');
  return parts.join('; ');
}
