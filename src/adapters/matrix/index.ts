import { parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '@pellux/goodvibes-sdk/platform/adapters/helpers';
import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readThreadId(content: Record<string, unknown> | null): string | undefined {
  const relatesTo = readRecord(content?.['m.relates_to']);
  const reply = readRecord(relatesTo?.['m.in_reply_to']);
  return readString(relatesTo?.event_id) ?? readString(reply?.event_id);
}

export async function handleMatrixSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const configuredToken =
    String(context.configManager.get('surfaces.matrix.accessToken') ?? '')
    || await context.serviceRegistry.resolveSecret('matrix', 'primary')
    || process.env.MATRIX_ACCESS_TOKEN
    || '';
  const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-matrix-token');
  if (configuredToken && providedToken !== configuredToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const event = readRecord(payload.event) ?? payload;
  const content = readRecord(event.content);
  const roomId = readString(event.room_id) ?? readString(payload.roomId);
  const text = readString(content?.body) ?? readString(event.text) ?? readString(payload.text) ?? '';
  if (!roomId) return Response.json({ error: 'Missing room id' }, { status: 400 });
  const threadId = readThreadId(content);

  const policy = await context.authorizeSurfaceIngress({
    surface: 'matrix',
    userId: readString(event.sender) ?? readString(payload.sender),
    channelId: roomId,
    groupId: roomId,
    threadId,
    workspaceId: readString(payload.homeserver) ?? readString(context.configManager.get('surfaces.matrix.homeserverUrl')),
    conversationKind: threadId ? 'thread' : 'channel',
    text,
    mentioned: true,
    metadata: payload,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadId ? 'thread' : 'channel',
    surfaceKind: 'matrix',
    surfaceId: readString(context.configManager.get('surfaces.matrix.userId')) ?? 'matrix',
    externalId: threadId ?? roomId,
    channelId: roomId,
    threadId,
    title: roomId,
    metadata: {
      ...payload,
      ...(readString(event.event_id) ? { eventId: readString(event.event_id) } : {}),
      ...(readString(content?.msgtype) ? { msgtype: readString(content?.msgtype) } : {}),
    },
  });
  if (!text) {
    return Response.json({ ok: true, acknowledged: true, bindingId: binding.id });
  }

  const controlCommand = context.parseSurfaceControlCommand(text);
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ ok: true, acknowledged: true, message });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'matrix',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: readString(event.sender) ?? readString(payload.sender),
    displayName: readString(payload.displayName) ?? readString(event.sender),
    title: binding.title ?? 'Matrix',
    body: text,
    metadata: binding.metadata,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleMatrixSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: text,
    sessionId: submission.session.id,
  });
  return Response.json({
    ok: true,
    queued: true,
    bindingId: binding.id,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
