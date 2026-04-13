import type { ConfigKey } from '../config/schema.ts';
import { missingScopes } from './helpers.ts';

export type AuthenticatedPrincipalKind = 'user' | 'bot' | 'service' | 'token';

export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly principalKind: AuthenticatedPrincipalKind;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

interface AuthenticatedPrincipalResolver {
  readonly extractAuthToken: (req: Request) => string;
  readonly describeAuthenticatedPrincipal: (token: string) => AuthenticatedPrincipal | null;
}

interface PrivateHostFetchConfig {
  readonly configManager: {
    get(key: ConfigKey): unknown;
  };
}

interface ElevatedPrivateHostFetchConfig extends PrivateHostFetchConfig {
  readonly req: Request;
  readonly requireElevatedAccess: (req: Request) => Response | null;
}

export function resolveAuthenticatedPrincipal(
  req: Request,
  resolver: AuthenticatedPrincipalResolver,
): AuthenticatedPrincipal | null {
  const token = resolver.extractAuthToken(req);
  return token ? resolver.describeAuthenticatedPrincipal(token) : null;
}

export function buildMissingScopeBody(
  target: string,
  requiredScopes: readonly string[],
  grantedScopes: readonly string[] | undefined,
): {
  readonly error: string;
  readonly requiredScopes: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly missingScopes: readonly string[];
} | null {
  const missing = missingScopes(grantedScopes, requiredScopes);
  if (missing.length === 0) return null;
  return {
    error: `Missing required scope${missing.length === 1 ? '' : 's'} for ${target}: ${missing.join(', ')}`,
    requiredScopes: [...requiredScopes],
    grantedScopes: [...(grantedScopes ?? [])],
    missingScopes: missing,
  };
}

export function resolvePrivateHostFetchOptions(
  requested: unknown,
  context: PrivateHostFetchConfig | ElevatedPrivateHostFetchConfig,
): { allowPrivateHosts: true } | {} | Response {
  if (requested !== true) return {};
  if (!Boolean(context.configManager.get('network.remoteFetch.allowPrivateHosts'))) {
    return Response.json({ error: 'Private-host remote fetches are disabled by config.' }, { status: 403 });
  }
  if ('requireElevatedAccess' in context) {
    const denied = context.requireElevatedAccess(context.req);
    if (denied) return denied;
  }
  return { allowPrivateHosts: true };
}
