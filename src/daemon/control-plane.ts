import type { AgentManager } from '../tools/agent/index.ts';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import {
  authenticateOperatorRequest,
  authenticateOperatorToken,
  extractOperatorAuthToken,
  isOperatorAdmin,
} from '@pellux/goodvibes-sdk/platform/security/http-auth';
import type { ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.ts';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../control-plane/index.ts';
import type { RuntimeEventDomain } from '../runtime/events/index.ts';
import type { DistributedRuntimeManager } from '../runtime/remote/index.ts';
import { extractForwardedClientIp } from '../runtime/network/index.ts';
import { resolveGatewayPathTemplate } from './helpers.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import {
  buildMissingScopeBody,
  resolveAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from '@pellux/goodvibes-sdk/platform/daemon/http-policy';

export interface ControlPlaneWebSocketData {
  readonly channel: 'control-plane';
  authToken: string;
  principalId: string | null;
  principalKind: 'user' | 'bot' | 'service' | 'token' | null;
  admin: boolean;
  scopes: readonly string[];
  readonly domains: readonly RuntimeEventDomain[];
  readonly clientKind:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly remoteAddress?: string;
  clientId?: string;
  authenticated: boolean;
}

export interface DaemonControlPlaneContext {
  readonly authToken: () => string | null;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly host: string;
  readonly port: number;
  readonly trustProxyEnabled: () => boolean;
  readonly dispatchApiRoutes: (req: Request) => Promise<Response | null>;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
}

interface UpgradeCapableServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
}

export class DaemonControlPlaneHelper {
  constructor(private readonly context: DaemonControlPlaneContext) {}

  private trustProxyEnabled(): boolean {
    return this.context.trustProxyEnabled();
  }

  extractAuthToken(req: Request): string {
    return extractOperatorAuthToken(req);
  }

  checkAuth(req: Request): boolean {
    return authenticateOperatorRequest(req, {
      sharedToken: this.context.authToken(),
      userAuth: this.context.userAuth,
    }) !== null;
  }

  requireAuthenticatedSession(req: Request): { username: string; roles: readonly string[] } | null {
    const authenticated = authenticateOperatorRequest(req, {
      sharedToken: this.context.authToken(),
      userAuth: this.context.userAuth,
    });
    if (!authenticated || authenticated.kind !== 'session') return null;
    return {
      username: authenticated.username,
      roles: authenticated.roles,
    };
  }

  requireAdmin(req: Request): Response | null {
    const authenticated = authenticateOperatorRequest(req, {
      sharedToken: this.context.authToken(),
      userAuth: this.context.userAuth,
    });
    if (!authenticated) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!isOperatorAdmin(authenticated)) {
      return Response.json({ error: 'Admin role required' }, { status: 403 });
    }
    return null;
  }

  async requireRemotePeer(req: Request, scope?: string): Promise<import('../runtime/remote/index.ts').DistributedPeerAuth | Response> {
    const token = this.extractAuthToken(req);
    const auth = await this.context.distributedRuntime.authenticatePeerToken(
      token,
      extractForwardedClientIp(req, this.trustProxyEnabled()),
    );
    if (!auth) {
      return Response.json({ error: 'Unauthorized remote peer' }, { status: 401 });
    }
    if (scope && !auth.token.scopes.includes(scope)) {
      return Response.json({ error: `Remote peer token missing required scope: ${scope}` }, { status: 403 });
    }
    return auth;
  }

  describeAuthenticatedPrincipal(token: string): AuthenticatedPrincipal | null {
    const authenticated = authenticateOperatorToken(token, {
      sharedToken: this.context.authToken(),
      userAuth: this.context.userAuth,
    });
    if (!authenticated) return null;
    if (authenticated.kind === 'shared-token') {
      return {
        principalId: 'shared-token',
        principalKind: 'token',
        admin: true,
        scopes: this.getGrantedGatewayScopes(true),
      };
    }
    const admin = authenticated.roles.includes('admin');
    return {
      principalId: authenticated.username,
      principalKind: 'user',
      admin,
      scopes: this.getGrantedGatewayScopes(admin),
    };
  }

  getGrantedGatewayScopes(includeWrite: boolean): readonly string[] {
    const scopes = new Set(this.context.gatewayMethods.getAllScopes({ includeWrite }));
    scopes.add('read:events');
    scopes.add('read:control-plane');
    scopes.add('read:telemetry');
    if (includeWrite) scopes.add('read:telemetry-sensitive');
    if (includeWrite) scopes.add('write:control-plane');
    return [...scopes].sort();
  }

  validateGatewayInvocation(
    descriptor: GatewayMethodDescriptor,
    context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly scopes?: readonly string[];
      readonly admin?: boolean;
    },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    if (descriptor.invokable === false) {
      return {
        status: 400,
        ok: false,
        body: {
          error: `Gateway method is cataloged but not invokable through method dispatch: ${descriptor.id}`,
        },
      };
    }
    if (descriptor.access === 'public') {
      return null;
    }
    if (descriptor.access === 'admin' && !context?.admin) {
      return {
        status: 403,
        ok: false,
        body: { error: `Gateway method requires admin access: ${descriptor.id}` },
      };
    }
    if (descriptor.access === 'remote-peer' && context?.principalKind !== 'remote-peer') {
      return {
        status: 403,
        ok: false,
        body: { error: `Gateway method requires a remote-peer principal: ${descriptor.id}` },
      };
    }
    const body = buildMissingScopeBody(descriptor.id, descriptor.scopes, context?.scopes);
    if (body) {
      return {
        status: 403,
        ok: false,
        body,
      };
    }
    return null;
  }

  tryUpgradeControlPlaneWebSocket(
    req: Request,
    server: UpgradeCapableServer,
  ): Response | 'upgraded' | null {
    const url = new URL(req.url);
    if (url.pathname !== '/api/control-plane/ws' || req.method !== 'GET') {
      return null;
    }
    const token = this.extractAuthToken(req);
    const principal = resolveAuthenticatedPrincipal(req, this);
    if (token && !principal) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rawDomains = url.searchParams.get('domains');
    const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
    const requestedKind = url.searchParams.get('clientKind');
    const clientKind = requestedKind === 'tui'
      || requestedKind === 'web'
      || requestedKind === 'slack'
      || requestedKind === 'discord'
      || requestedKind === 'ntfy'
      || requestedKind === 'daemon'
      || requestedKind === 'webhook'
      ? requestedKind
      : 'web';
    const upgraded = server.upgrade(req, {
      data: {
        channel: 'control-plane',
        authToken: token,
        principalId: principal?.principalId ?? null,
        principalKind: principal?.principalKind ?? null,
        scopes: principal?.scopes ?? [],
        admin: principal?.admin ?? false,
        domains,
        clientKind,
        remoteAddress: extractForwardedClientIp(req, this.trustProxyEnabled()),
        authenticated: Boolean(principal),
      } satisfies ControlPlaneWebSocketData,
    });
    return upgraded ? 'upgraded' : Response.json({ error: 'WebSocket upgrade failed' }, { status: 400 });
  }

  handleControlPlaneWebSocketOpen(ws: {
    data: ControlPlaneWebSocketData;
    send(message: string): void;
  }): void {
    const connection = this.context.controlPlaneGateway.openWebSocketClient({
      clientKind: ws.data.clientKind,
      transport: 'ws',
      domains: ws.data.authenticated ? ws.data.domains : [],
      ...(ws.data.principalId ? { principalId: ws.data.principalId } : {}),
      ...(ws.data.principalKind ? { principalKind: ws.data.principalKind } : {}),
      ...(ws.data.scopes.length > 0 ? { scopes: ws.data.scopes } : {}),
      remoteAddress: ws.data.remoteAddress,
    }, (event, payload) => {
      ws.send(JSON.stringify({ type: 'event', event, payload }));
    });
    ws.data.clientId = connection.clientId;
  }

  async handleControlPlaneWebSocketMessage(
    ws: {
      data: ControlPlaneWebSocketData;
      send(message: string): void;
    },
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const clientId = ws.data.clientId;
    if (!clientId) return;
    const text = typeof message === 'string'
      ? message
      : message instanceof Uint8Array
        ? new TextDecoder().decode(message)
        : message instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(message))
          : Buffer.from(message).toString('utf8');
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON frame' }));
      return;
    }

    this.context.controlPlaneGateway.touchWebSocketClient(clientId, {
      lastFrameType: typeof frame.type === 'string' ? frame.type : 'unknown',
    });

    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (frame.type === 'auth') {
      const token = typeof frame.token === 'string' ? frame.token : ws.data.authToken;
      const principal = this.describeAuthenticatedPrincipal(token);
      if (!principal) {
        ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Unauthorized' }));
        return;
      }
      this.context.controlPlaneGateway.authenticateClient(clientId, {
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
        ...(typeof frame.label === 'string' ? { label: frame.label } : {}),
        ...(Array.isArray(frame.capabilities) ? { capabilities: frame.capabilities.filter((value): value is string => typeof value === 'string') } : {}),
      });
      if (Array.isArray(frame.domains)) {
        this.context.controlPlaneGateway.subscribeWebSocketClient(
          clientId,
          frame.domains.filter((value): value is RuntimeEventDomain => typeof value === 'string') as RuntimeEventDomain[],
        );
      }
      ws.data.authToken = token;
      ws.data.principalId = principal.principalId;
      ws.data.principalKind = principal.principalKind;
      ws.data.scopes = principal.scopes;
      ws.data.admin = principal.admin;
      ws.data.authenticated = true;
      ws.send(JSON.stringify({ type: 'auth', ok: true, clientId, principalId: principal.principalId }));
      return;
    }

    if (frame.type === 'subscribe') {
      if (!ws.data.authenticated) {
        ws.send(JSON.stringify({ type: 'error', error: 'Authenticate before subscribing' }));
        return;
      }
      const domains = Array.isArray(frame.domains)
        ? frame.domains.filter((value): value is RuntimeEventDomain => typeof value === 'string') as RuntimeEventDomain[]
        : [];
      this.context.controlPlaneGateway.subscribeWebSocketClient(clientId, domains);
      ws.send(JSON.stringify({ type: 'subscribed', clientId, domains }));
      return;
    }

    if (frame.type === 'unsubscribe') {
      const domains = Array.isArray(frame.domains)
        ? frame.domains.filter((value): value is RuntimeEventDomain => typeof value === 'string') as RuntimeEventDomain[]
        : undefined;
      this.context.controlPlaneGateway.unsubscribeWebSocketClient(clientId, domains);
      ws.send(JSON.stringify({ type: 'unsubscribed', clientId, domains: domains ?? [] }));
      return;
    }

    if (frame.type === 'call') {
      if (!ws.data.authenticated || !ws.data.principalId || !ws.data.principalKind) {
        ws.send(JSON.stringify({ type: 'error', error: 'Authenticate before invoking methods' }));
        return;
      }
      const id = typeof frame.id === 'string' ? frame.id : `call-${Date.now()}`;
      const methodId = typeof frame.methodId === 'string' ? frame.methodId : undefined;
      const response = methodId
        ? await this.invokeGatewayMethodCall({
            authToken: ws.data.authToken,
            methodId,
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalId: ws.data.principalId,
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
              clientKind: ws.data.clientKind,
            },
          })
        : await this.invokeWebSocketControlPlaneCall({
            authToken: ws.data.authToken,
            method: typeof frame.method === 'string' ? frame.method.toUpperCase() : 'GET',
            path: typeof frame.path === 'string' ? frame.path : '/api/control-plane',
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
            },
          });
      ws.send(JSON.stringify({
        type: 'response',
        id,
        ok: response.ok,
        status: response.status,
        body: response.body,
      }));
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'Unsupported frame type' }));
  }

  handleControlPlaneWebSocketClose(ws: {
    data: ControlPlaneWebSocketData;
  }): void {
    if (!ws.data.clientId) return;
    this.context.controlPlaneGateway.closeWebSocketClient(ws.data.clientId, 'socket-closed');
  }

  async invokeWebSocketControlPlaneCall(input: {
    readonly authToken: string;
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
    readonly context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly admin?: boolean;
      readonly scopes?: readonly string[];
    };
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    const matchedDescriptor = this.context.gatewayMethods.findByHttpBinding(input.method, input.path);
    if (matchedDescriptor) {
      const denied = this.validateGatewayInvocation(matchedDescriptor, input.context);
      if (denied) return denied;
    }
    const url = new URL(`http://${this.context.host}:${this.context.port}${input.path.startsWith('/') ? input.path : `/${input.path}`}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const request = new Request(url.toString(), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.authToken}`,
        ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    const response = await this.context.dispatchApiRoutes(request) ?? Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await response.text();
    let body: unknown = raw;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else {
      body = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
    };
  }

  async invokeGatewayMethodCall(input: {
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
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    const descriptor = this.context.gatewayMethods.get(input.methodId);
    if (!descriptor) {
      return { status: 404, ok: false, body: { error: `Unknown gateway method: ${input.methodId}` } };
    }
    const denied = this.validateGatewayInvocation(descriptor, input.context);
    if (denied) return denied;
    if (this.context.gatewayMethods.hasHandler(input.methodId)) {
      try {
        const body = await this.context.gatewayMethods.invoke(input.methodId, {
          body: input.body,
          query: input.query,
          context: {
            authToken: input.authToken,
            principalId: input.context?.principalId,
            principalKind: input.context?.principalKind,
            admin: input.context?.admin,
            scopes: input.context?.scopes,
            clientKind: input.context?.clientKind,
          },
        });
        return { status: 200, ok: true, body };
      } catch (error) {
        return {
          status: 500,
          ok: false,
          body: { error: summarizeError(error) },
        };
      }
    }
    if (!descriptor.http) {
      return { status: 501, ok: false, body: { error: `Gateway method is not invokable: ${input.methodId}` } };
    }
    const resolvedPath = resolveGatewayPathTemplate(descriptor.http.path, input.query, input.body);
    if (!resolvedPath.path) {
      return {
        status: 400,
        ok: false,
        body: {
          error: `Missing path parameter${resolvedPath.missing.length === 1 ? '' : 's'} for ${input.methodId}: ${resolvedPath.missing.join(', ')}`,
          missing: [...resolvedPath.missing],
        },
      };
    }
    return this.invokeWebSocketControlPlaneCall({
      authToken: input.authToken,
      method: descriptor.http.method,
      path: resolvedPath.path,
      query: input.query,
      body: descriptor.http.method === 'GET' || descriptor.http.method === 'DELETE' ? undefined : input.body,
      context: {
        principalKind: input.context?.principalKind,
        admin: input.context?.admin,
        scopes: input.context?.scopes,
      },
    });
  }
}
