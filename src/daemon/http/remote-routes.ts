import type { DistributedPeerAuth, DistributedRuntimeManager } from '../../runtime/remote/index.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import { jsonErrorResponse } from './error-response.ts';

type JsonBody = Record<string, unknown>;

interface SessionUserLike {
  readonly username: string;
}

interface DaemonRemoteRouteContext {
  readonly authToken?: string | null;
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<DistributedPeerAuth | Response>;
  readonly requireAuthenticatedSession: (req: Request) => SessionUserLike | null;
  readonly distributedRuntime: DistributedRuntimeManager;
}

export function createDaemonRemoteRouteHandlers(
  context: DaemonRemoteRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getRemotePairRequests'
  | 'approveRemotePairRequest'
  | 'rejectRemotePairRequest'
  | 'getRemotePeers'
  | 'rotateRemotePeerToken'
  | 'revokeRemotePeerToken'
  | 'disconnectRemotePeer'
  | 'getRemoteWork'
  | 'invokeRemotePeer'
  | 'cancelRemoteWork'
  | 'getRemoteNodeHostContract'
> {
  return {
    getRemotePairRequests: () => Response.json({ requests: context.distributedRuntime.listPairRequests() }),
    approveRemotePairRequest: async (requestId, request) => handleApproveRemotePairRequest(context, requestId, request),
    rejectRemotePairRequest: async (requestId, request) => handleRejectRemotePairRequest(context, requestId, request),
    getRemotePeers: () => Response.json({ peers: context.distributedRuntime.listPeers() }),
    rotateRemotePeerToken: async (peerId, request) => handleRotateRemotePeerToken(context, peerId, request),
    revokeRemotePeerToken: async (peerId, request) => handleRevokeRemotePeerToken(context, peerId, request),
    disconnectRemotePeer: async (peerId, request) => handleDisconnectRemotePeer(context, peerId, request),
    getRemoteWork: () => Response.json({ work: context.distributedRuntime.listWork() }),
    invokeRemotePeer: async (peerId, request) => handleInvokeRemotePeer(context, peerId, request),
    cancelRemoteWork: async (workId, request) => handleCancelRemoteWork(context, workId, request),
    getRemoteNodeHostContract: () => Response.json({ contract: context.distributedRuntime.getNodeHostContract() }),
  };
}

export async function handleRemotePairRequest(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peerKind = body.peerKind === 'device' ? 'device' : 'node';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) {
    return Response.json({ error: 'Missing remote peer label' }, { status: 400 });
  }
  const created = await context.distributedRuntime.requestPairing({
    peerKind,
    requestedId: typeof body.requestedId === 'string' ? body.requestedId : undefined,
    label,
    platform: typeof body.platform === 'string' ? body.platform : undefined,
    deviceFamily: typeof body.deviceFamily === 'string' ? body.deviceFamily : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    clientMode: typeof body.clientMode === 'string' ? body.clientMode : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === 'string') : [],
    commands: Array.isArray(body.commands) ? body.commands.filter((value): value is string => typeof value === 'string') : [],
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    requestedBy: 'remote',
    remoteAddress: req.headers.get('x-forwarded-for') ?? undefined,
    ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
  });
  return Response.json(created, { status: 201 });
}

export async function handleRemotePairVerify(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  const challenge = typeof body.challenge === 'string' ? body.challenge : '';
  if (!requestId || !challenge) {
    return Response.json({ error: 'Missing requestId or challenge' }, { status: 400 });
  }
  const verified = await context.distributedRuntime.verifyPairRequest(requestId, challenge, {
    remoteAddress: req.headers.get('x-forwarded-for') ?? undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return verified
    ? Response.json(verified)
    : Response.json({ error: 'Pair request not approved, expired, or invalid' }, { status: 404 });
}

export async function handleRemotePeerHeartbeat(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:heartbeat');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peer = await context.distributedRuntime.heartbeatPeer(auth, {
    remoteAddress: req.headers.get('x-forwarded-for') ?? undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === 'string') : undefined,
    commands: Array.isArray(body.commands) ? body.commands.filter((value): value is string => typeof value === 'string') : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    clientMode: typeof body.clientMode === 'string' ? body.clientMode : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return Response.json({ peer });
}

export async function handleRemotePeerWorkPull(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:pull');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const work = await context.distributedRuntime.claimWork(auth, {
    maxItems: typeof body.maxItems === 'number' ? body.maxItems : undefined,
    leaseMs: typeof body.leaseMs === 'number' ? body.leaseMs : undefined,
  });
  return Response.json({ work });
}

export async function handleRemotePeerWorkComplete(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  workId: string,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:complete');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const work = await context.distributedRuntime.completeWork(auth, workId, {
    status: body.status === 'failed' || body.status === 'cancelled' ? body.status : body.status === 'completed' ? 'completed' : undefined,
    result: body.result,
    error: typeof body.error === 'string' ? body.error : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return work
    ? Response.json({ work })
    : Response.json({ error: 'Unknown or unclaimed remote work item' }, { status: 404 });
}

function operatorActor(context: DaemonRemoteRouteContext, req: Request): string {
  return context.authToken ? 'shared-token' : context.requireAuthenticatedSession(req)?.username ?? 'operator';
}

async function handleApproveRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const approved = await context.distributedRuntime.approvePairRequest(requestId, {
    actor: operatorActor(context, req),
    note: typeof body.note === 'string' ? body.note : undefined,
    label: typeof body.label === 'string' ? body.label : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return approved
    ? Response.json(approved)
    : Response.json({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRejectRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const rejected = await context.distributedRuntime.rejectPairRequest(requestId, {
    actor: operatorActor(context, req),
    note: typeof body.note === 'string' ? body.note : undefined,
  });
  return rejected
    ? Response.json(rejected)
    : Response.json({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRotateRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const rotated = await context.distributedRuntime.rotatePeerToken(peerId, {
    actor: operatorActor(context, req),
    label: typeof body.label === 'string' ? body.label : undefined,
    scopes: Array.isArray(body.scopes) ? body.scopes.filter((value): value is string => typeof value === 'string') : undefined,
  });
  return rotated
    ? Response.json(rotated)
    : Response.json({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleRevokeRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peer = await context.distributedRuntime.revokePeerToken(peerId, {
    actor: operatorActor(context, req),
    tokenId: typeof body.tokenId === 'string' ? body.tokenId : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  });
  return peer
    ? Response.json({ peer })
    : Response.json({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleDisconnectRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peer = await context.distributedRuntime.disconnectPeer(peerId, {
    actor: operatorActor(context, req),
    note: typeof body.note === 'string' ? body.note : undefined,
    requeueClaimedWork: typeof body.requeueClaimedWork === 'boolean' ? body.requeueClaimedWork : undefined,
  });
  return peer
    ? Response.json({ peer })
    : Response.json({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleInvokeRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) {
    return Response.json({ error: 'Missing remote invoke command' }, { status: 400 });
  }
  try {
    const invoked = await context.distributedRuntime.invokePeer({
      peerId,
      command,
      payload: body.payload,
      priority: body.priority === 'high' || body.priority === 'default' ? body.priority : 'normal',
      actor: operatorActor(context, req),
      waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
      automationRunId: typeof body.automationRunId === 'string' ? body.automationRunId : undefined,
      automationJobId: typeof body.automationJobId === 'string' ? body.automationJobId : undefined,
      approvalId: typeof body.approvalId === 'string' ? body.approvalId : undefined,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    });
    return Response.json(invoked, { status: 202 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 404 });
  }
}

async function handleCancelRemoteWork(context: DaemonRemoteRouteContext, workId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const work = await context.distributedRuntime.cancelWork(workId, {
    actor: operatorActor(context, req),
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
  return work
    ? Response.json({ work })
    : Response.json({ error: 'Unknown remote work item' }, { status: 404 });
}
