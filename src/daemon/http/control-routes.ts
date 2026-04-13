import { VERSION } from '../../version.ts';
import type { RuntimeEventDomain } from '../../runtime/events/index.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import { inspectInboundTls, inspectOutboundTls } from '../../runtime/network/index.ts';
import { buildOperatorContract } from '../../control-plane/operator-contract.ts';
import {
  resolveAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from '../http-policy.ts';

interface ControlRouteContext {
  readonly authToken: string | null;
  readonly configManager: import('../../config/manager.ts').ConfigManager;
  readonly controlPlaneGateway: import('../../control-plane/index.ts').ControlPlaneGateway;
  readonly describeAuthenticatedPrincipal: (token: string) => AuthenticatedPrincipal | null;
  readonly extractAuthToken: (req: Request) => string;
  readonly gatewayMethods: import('../../control-plane/index.ts').GatewayMethodCatalog;
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
  return {
    getStatus: () => Response.json({
      status: 'running',
      version: VERSION,
      network: {
        controlPlane: inspectInboundTls(context.configManager, 'controlPlane'),
        httpListener: inspectInboundTls(context.configManager, 'httpListener'),
        outbound: inspectOutboundTls(context.configManager),
      },
    }),
    getControlPlaneSnapshot: () => Response.json(context.controlPlaneGateway.getSnapshot()),
    getOperatorContract: () => Response.json({ contract: buildOperatorContract(context.gatewayMethods) }),
    getControlPlaneWeb: () => context.controlPlaneGateway.renderWebUi(),
    getControlPlaneRecentEvents: (limit) => Response.json({ events: context.controlPlaneGateway.listRecentEvents(limit) }),
    getControlPlaneMessages: () => Response.json({ messages: context.controlPlaneGateway.listSurfaceMessages() }),
    getControlPlaneClients: () => Response.json({ clients: context.controlPlaneGateway.listClients() }),
    getGatewayMethods: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      return Response.json({
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
      return Response.json({
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
        ? Response.json({ method })
        : Response.json({ error: 'Unknown gateway method' }, { status: 404 });
    },
    invokeGatewayMethod: async (methodId, req) => {
      const descriptor = context.gatewayMethods.get(methodId);
      if (!descriptor) return Response.json({ error: 'Unknown gateway method' }, { status: 404 });
      if (descriptor.dangerous || descriptor.access === 'admin') {
        const admin = context.requireAdmin(req);
        if (admin) return admin;
      }
      const principal = resolveAuthenticatedPrincipal(req, context);
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
      const principal = resolveAuthenticatedPrincipal(req, context);
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
