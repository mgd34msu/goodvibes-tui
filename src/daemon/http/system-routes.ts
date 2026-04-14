import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { JsonRecord } from './route-helpers.ts';
import { jsonErrorResponse } from './error-response.ts';
import type {
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  DaemonSystemRouteContext,
  WatcherKind,
} from './system-route-types.ts';

export function createDaemonSystemRouteHandlers(
  context: DaemonSystemRouteContext,
  request: Request,
): Pick<
  DaemonApiRouteHandlers,
  | 'getWatchers'
  | 'postWatcher'
  | 'patchWatcher'
  | 'watcherAction'
  | 'deleteWatcher'
  | 'getServiceStatus'
  | 'installService'
  | 'startService'
  | 'stopService'
  | 'restartService'
  | 'uninstallService'
  | 'getRouteBindings'
  | 'postRouteBinding'
  | 'patchRouteBinding'
  | 'deleteRouteBinding'
  | 'getApprovals'
  | 'approvalAction'
  | 'getConfig'
  | 'postConfig'
> {
  return {
    getWatchers: () => Response.json({ watchers: context.watcherRegistry.list() }),
    postWatcher: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleRegisterWatcher(context, req);
    },
    patchWatcher: (watcherId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleUpdateWatcher(context, watcherId, req);
    },
    watcherAction: (watcherId, action) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return handleWatcherAction(context, watcherId, action);
    },
    deleteWatcher: (watcherId) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      const removed = context.watcherRegistry.removeWatcher(watcherId);
      return removed
        ? Response.json({ removed: true, id: watcherId })
        : Response.json({ error: 'Unknown watcher' }, { status: 404 });
    },
    getServiceStatus: () => Response.json({
      ...context.platformServiceManager.status(),
      network: {
        controlPlane: context.inspectInboundTls('controlPlane'),
        httpListener: context.inspectInboundTls('httpListener'),
        outbound: context.inspectOutboundTls(),
      },
    }),
    installService: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.install());
    },
    startService: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.start());
    },
    stopService: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.stop());
    },
    restartService: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.restart());
    },
    uninstallService: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.uninstall());
    },
    getRouteBindings: () => Response.json({ bindings: context.routeBindings.listBindings() }),
    postRouteBinding: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const surfaceKind = typeof body.surfaceKind === 'string' ? body.surfaceKind : '';
      const kind = typeof body.kind === 'string' ? body.kind : '';
      const surfaceId = typeof body.surfaceId === 'string' ? body.surfaceId : '';
      const externalId = typeof body.externalId === 'string' ? body.externalId : '';
      if (!surfaceKind || !kind || !surfaceId || !externalId) {
        return Response.json({ error: 'Missing required route binding fields' }, { status: 400 });
      }
      const binding = await context.routeBindings.upsertBinding({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: kind as AutomationRouteBindingKind,
        surfaceKind: surfaceKind as AutomationSurfaceKind,
        surfaceId,
        externalId,
        sessionPolicy: typeof body.sessionPolicy === 'string' ? body.sessionPolicy as AutomationSessionPolicy : undefined,
        threadPolicy: typeof body.threadPolicy === 'string' ? body.threadPolicy as AutomationThreadPolicy : undefined,
        deliveryGuarantee: typeof body.deliveryGuarantee === 'string' ? body.deliveryGuarantee as AutomationDeliveryGuarantee : undefined,
        threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
        channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      });
      return Response.json(binding, { status: 201 });
    },
    patchRouteBinding: async (bindingId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const updated = await context.routeBindings.patchBinding(bindingId, {
        ...(body.sessionPolicy !== undefined ? { sessionPolicy: typeof body.sessionPolicy === 'string' ? body.sessionPolicy as AutomationSessionPolicy : undefined } : {}),
        ...(body.threadPolicy !== undefined ? { threadPolicy: typeof body.threadPolicy === 'string' ? body.threadPolicy as AutomationThreadPolicy : undefined } : {}),
        ...(body.deliveryGuarantee !== undefined ? { deliveryGuarantee: typeof body.deliveryGuarantee === 'string' ? body.deliveryGuarantee as AutomationDeliveryGuarantee : undefined } : {}),
        ...(body.threadId !== undefined ? { threadId: typeof body.threadId === 'string' ? body.threadId : undefined } : {}),
        ...(body.channelId !== undefined ? { channelId: typeof body.channelId === 'string' ? body.channelId : undefined } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId === null ? null : typeof body.sessionId === 'string' ? body.sessionId : undefined } : {}),
        ...(body.jobId !== undefined ? { jobId: body.jobId === null ? null : typeof body.jobId === 'string' ? body.jobId : undefined } : {}),
        ...(body.runId !== undefined ? { runId: body.runId === null ? null : typeof body.runId === 'string' ? body.runId : undefined } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return updated
        ? Response.json(updated)
        : Response.json({ error: 'Unknown route binding' }, { status: 404 });
    },
    deleteRouteBinding: async (bindingId) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      const removed = await context.routeBindings.removeBinding(bindingId);
      return removed
        ? Response.json({ removed: true, id: bindingId })
        : Response.json({ error: 'Unknown route binding' }, { status: 404 });
    },
    getApprovals: () => {
      if (!context.integrationHelpers) {
        return Response.json({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      return Response.json(context.integrationHelpers.getApprovalSnapshot());
    },
    approvalAction: (approvalId, action, req) => handleApprovalAction(context, approvalId, action, req),
    getConfig: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(context.configManager.getAll());
    },
    postConfig: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      const { key, value } = payload;
      if (!key || typeof key !== 'string') {
        return Response.json({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (!context.isValidConfigKey(key)) {
        return Response.json({ error: 'Invalid config key' }, { status: 400 });
      }
      try {
        context.configManager.setDynamic(key, value);
      } catch (error: unknown) {
        return jsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to set config' });
      }
      return Response.json({ success: true, key, value });
    },
  };
}

async function handleRegisterWatcher(context: DaemonSystemRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const label = typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : '';
  const id = typeof body.id === 'string' && body.id.trim().length > 0
    ? body.id.trim()
    : label
      ? `watcher-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
      : `watcher-${Date.now()}`;
  const kind = typeof body.kind === 'string'
    ? body.kind as WatcherKind
    : typeof body.sourceKind === 'string'
      ? body.sourceKind === 'webhook'
        ? 'webhook'
        : body.sourceKind === 'file'
          ? 'filesystem'
          : body.sourceKind === 'stream'
            ? 'socket'
            : body.sourceKind === 'api'
              ? 'integration'
              : 'polling'
      : 'polling';
  const intervalMs = Number(body.intervalMs ?? context.configManager.get('watchers.pollIntervalMs') ?? 60_000);
  if (!label) {
    return Response.json({ error: 'Missing watcher label' }, { status: 400 });
  }
  const metadata = typeof body.metadata === 'object' && body.metadata !== null
    ? body.metadata as Record<string, unknown>
    : {};
  const sourceMetadata = {
    ...metadata,
    ...(typeof body.url === 'string' ? { url: body.url } : {}),
    ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
    ...(typeof body.path === 'string' ? { path: body.path } : {}),
    ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
    ...(typeof body.address === 'string' ? { address: body.address } : {}),
    ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
  };
  const record = context.watcherRegistry.registerWatcher({
    id,
    label,
    kind,
    source: {
      id: typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : `source:${id}`,
      kind: typeof body.sourceKind === 'string'
        ? body.sourceKind === 'webhook'
          ? 'webhook'
          : body.sourceKind === 'file' || body.sourceKind === 'stream' || body.sourceKind === 'api'
            ? 'hook'
            : 'watcher'
        : 'watcher',
      label,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: sourceMetadata,
    },
    intervalMs,
    metadata: sourceMetadata,
    ...(typeof body.run === 'string' ? { run: () => body.run as string } : {}),
  });
  return Response.json(record, { status: 201 });
}

async function handleUpdateWatcher(context: DaemonSystemRouteContext, watcherId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const current = context.watcherRegistry.getWatcher(watcherId);
  if (!current) {
    return Response.json({ error: 'Unknown watcher' }, { status: 404 });
  }
  const nextSourceKind = typeof body.sourceKind === 'string'
    ? body.sourceKind === 'webhook'
      ? 'webhook'
      : body.sourceKind === 'file' || body.sourceKind === 'stream' || body.sourceKind === 'api'
        ? 'hook'
        : 'watcher'
    : current.source.kind;
  const updated = context.watcherRegistry.registerWatcher({
    id: watcherId,
    label: typeof body.label === 'string' ? body.label : current.label,
    kind: typeof body.kind === 'string'
      ? body.kind as WatcherKind
      : current.kind,
    source: {
      ...current.source,
      ...(typeof body.source === 'object' && body.source !== null ? body.source as Partial<typeof current.source> : {}),
      kind: nextSourceKind,
      ...(typeof body.sourceId === 'string' && body.sourceId.trim().length > 0 ? { id: body.sourceId.trim() } : {}),
      ...(typeof body.label === 'string' && body.label.trim().length > 0 ? { label: body.label.trim() } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      metadata: {
        ...current.source.metadata,
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
        ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
        ...(typeof body.path === 'string' ? { path: body.path } : {}),
        ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
        ...(typeof body.address === 'string' ? { address: body.address } : {}),
        ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {}),
      },
      updatedAt: Date.now(),
    },
    intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : (current.intervalMs ?? 60_000),
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : current.metadata,
  });
  return Response.json(updated);
}

async function handleWatcherAction(
  context: DaemonSystemRouteContext,
  watcherId: string,
  action: 'start' | 'stop' | 'run',
): Promise<Response> {
  if (action === 'start') {
    const watcher = context.watcherRegistry.startWatcher(watcherId);
    return watcher
      ? Response.json(watcher)
      : Response.json({ error: 'Unknown watcher' }, { status: 404 });
  }
  if (action === 'stop') {
    const watcher = context.watcherRegistry.stopWatcher(watcherId, 'operator-stop');
    return watcher
      ? Response.json(watcher)
      : Response.json({ error: 'Unknown watcher' }, { status: 404 });
  }
  const watcher = await context.watcherRegistry.runWatcherNow(watcherId);
  return watcher
    ? Response.json(watcher)
    : Response.json({ error: 'Unknown watcher' }, { status: 404 });
}

async function handleApprovalAction(
  context: DaemonSystemRouteContext,
  approvalId: string,
  action: 'claim' | 'approve' | 'deny' | 'cancel',
  req: Request,
): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  const payload = body instanceof Response || body === null ? {} as JsonRecord : body;
  const actor = context.requireAuthenticatedSession(req)?.username ?? 'operator';
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  if (action === 'claim') {
    const approval = await context.approvalBroker.claimApproval(approvalId, actor, 'web', note);
    return approval
      ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }
  if (action === 'cancel') {
    const approval = await context.approvalBroker.cancelApproval(approvalId, actor, 'web', note);
    return approval
      ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }
  const approval = await context.approvalBroker.resolveApproval(approvalId, {
    approved: action === 'approve',
    remember: typeof payload.remember === 'boolean' ? payload.remember : false,
    actor,
    actorSurface: 'web',
    note,
  });
  return approval
    ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
    : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
}
