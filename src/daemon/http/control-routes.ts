import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { RuntimeEventDomain } from '../../types/foundation-contract.ts';
import type { AuthenticatedPrincipal } from '../http-policy.ts';
import { serializableJsonResponse } from './route-helpers.ts';

interface GatewayMethodDescriptorLike {
  readonly dangerous?: boolean;
  readonly access?: string;
}

interface GatewayMethodCatalogLike {
  list(options?: Record<string, unknown>): unknown;
  listEvents(options?: Record<string, unknown>): unknown;
  get(methodId: string): GatewayMethodDescriptorLike | null | undefined;
}

interface ControlPlaneGatewayLike {
  getSnapshot(): unknown;
  renderWebUi(): Response;
  listRecentEvents(limit: number): unknown;
  listSurfaceMessages(): unknown;
  listClients(): unknown;
  createEventStream(
    req: Request,
    input: Record<string, unknown>,
  ): Response | Promise<Response>;
}

interface ControlRouteContext {
  readonly authToken: string | null;
  readonly version: string;
  readonly sessionCookieName: string;
  readonly controlPlaneGateway: ControlPlaneGatewayLike;
  readonly extractAuthToken: (req: Request) => string;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipal | null;
  readonly gatewayMethods: GatewayMethodCatalogLike;
  readonly getOperatorContract: () => unknown;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly invokeGatewayMethodCall: (input: {
    readonly authToken: string;
    readonly methodId: string;
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
    readonly context?: {
      readonly principalId?: string;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly admin?: boolean;
      readonly scopes?: readonly string[];
      readonly clientKind?: string;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<Record<string, unknown> | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
}

export function createDaemonControlRouteHandlers(
  context: ControlRouteContext,
  request: Request,
): Pick<
  DaemonApiRouteHandlers,
  | 'getStatus'
  | 'getCurrentAuth'
  | 'getControlPlaneSnapshot'
  | 'getOperatorContract'
  | 'getControlPlaneWeb'
  | 'getControlPlaneRecentEvents'
  | 'getControlPlaneMessages'
  | 'getControlPlaneClients'
  | 'getGatewayMethods'
  | 'getGatewayEvents'
  | 'getGatewayMethod'
  | 'invokeGatewayMethod'
  | 'createControlPlaneEventStream'
> {
  const hasAuthorizationHeader = Boolean(request.headers.get('authorization')?.trim());
  const sessionCookiePresent = (request.headers.get('cookie') ?? '')
    .split(';')
    .some((segment) => segment.trim().startsWith(`${context.sessionCookieName}=`));

  return {
    getStatus: () => Response.json({
      status: 'running',
      version: context.version,
      network: {
        controlPlane: context.inspectInboundTls('controlPlane'),
        httpListener: context.inspectInboundTls('httpListener'),
        outbound: context.inspectOutboundTls(),
      },
    }),
    getCurrentAuth: (req) => {
      const token = context.extractAuthToken(req).trim();
      const principal = context.resolveAuthenticatedPrincipal(req);
      const session = principal?.principalKind === 'user'
        ? context.requireAuthenticatedSession(req)
        : null;
      const authMode = principal
        ? (principal.principalKind === 'token' && principal.principalId === 'shared-token' ? 'shared-token' : 'session')
        : token.length > 0
          ? 'invalid'
          : 'anonymous';
      const snapshot = {
        authenticated: principal !== null,
        authMode,
        tokenPresent: token.length > 0,
        authorizationHeaderPresent: hasAuthorizationHeader,
        sessionCookiePresent,
        principalId: principal?.principalId ?? null,
        principalKind: principal?.principalKind ?? null,
        admin: principal?.admin ?? false,
        scopes: principal?.scopes ?? [],
        roles: session?.roles ?? [],
      };

      return Response.json(snapshot);
    },
    getControlPlaneSnapshot: () => Response.json(context.controlPlaneGateway.getSnapshot()),
    getOperatorContract: () => serializableJsonResponse({ contract: context.getOperatorContract() }),
    getControlPlaneWeb: () => context.controlPlaneGateway.renderWebUi(),
    getControlPlaneRecentEvents: (limit) => Response.json({ events: context.controlPlaneGateway.listRecentEvents(limit) }),
    getControlPlaneMessages: () => Response.json({ messages: context.controlPlaneGateway.listSurfaceMessages() }),
    getControlPlaneClients: () => Response.json({ clients: context.controlPlaneGateway.listClients() }),
    getGatewayMethods: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      return serializableJsonResponse({
        methods: context.gatewayMethods.list({
          ...(category ? { category } : {}),
          ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
        }),
      });
    },
    getGatewayEvents: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      const domain = url.searchParams.get('domain') ?? undefined;
      return serializableJsonResponse({
        events: context.gatewayMethods.listEvents({
          ...(category ? { category } : {}),
          ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
          ...(domain ? { domain: domain as RuntimeEventDomain } : {}),
        }),
      });
    },
    getGatewayMethod: (methodId) => {
      const method = context.gatewayMethods.get(methodId);
      return method
        ? serializableJsonResponse({ method })
        : Response.json({ error: 'Unknown gateway method' }, { status: 404 });
    },
    invokeGatewayMethod: async (methodId, req) => {
      const descriptor = context.gatewayMethods.get(methodId);
      if (!descriptor) return Response.json({ error: 'Unknown gateway method' }, { status: 404 });
      if (descriptor.dangerous || descriptor.access === 'admin') {
        const admin = context.requireAdmin(req);
        if (admin) return admin;
      }
      const principal = context.resolveAuthenticatedPrincipal(req);
      const parsedBody = await context.parseOptionalJsonBody(req);
      if (parsedBody instanceof Response) return parsedBody;
      const payload = parsedBody ?? {};
      const response = await context.invokeGatewayMethodCall({
        authToken: context.extractAuthToken(req),
        methodId,
        query: typeof payload.query === 'object' && payload.query !== null ? payload.query as Record<string, unknown> : undefined,
        body: Object.hasOwn(payload, 'body') ? payload.body : payload,
        context: {
          principalId: principal?.principalId,
          principalKind: principal?.principalKind,
          admin: principal?.admin,
          scopes: principal?.scopes,
          clientKind: 'web',
        },
      });
      return Response.json(response.body, { status: response.status });
    },
    createControlPlaneEventStream: (req) => {
      const url = new URL(req.url);
      const rawDomains = url.searchParams.get('domains');
      const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
      const principal = context.resolveAuthenticatedPrincipal(req);
      return context.controlPlaneGateway.createEventStream(req, {
        clientKind: 'web',
        transport: 'sse',
        domains,
        principalId: principal?.principalId ?? (context.authToken ? 'shared-token' : context.requireAuthenticatedSession(req)?.username ?? 'session-user'),
        principalKind: principal?.principalKind ?? (context.authToken ? 'token' : 'user'),
        scopes: principal?.scopes ?? ['read:events', 'read:control-plane'],
      });
    },
  };
}
