import { parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '@pellux/goodvibes-sdk/platform/adapters/helpers';
import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function readBody(req: Request): Promise<Record<string, unknown> | Response | null> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
    if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }
    const form = await req.formData().catch(() => null);
    if (!form) return null;
    return Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]),
    );
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  const parsed = parseJsonRecord(rawBody);
  return parsed instanceof Response ? null : readRecord(parsed);
}

export async function handleMattermostSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  if (!body) return Response.json({ error: 'Invalid webhook payload' }, { status: 400 });
  const configuredToken =
    String(context.configManager.get('surfaces.mattermost.botToken') ?? '')
    || await context.serviceRegistry.resolveSecret('mattermost', 'primary')
    || process.env.MATTERMOST_BOT_TOKEN
    || '';
  const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-mattermost-token')
    ?? readString(body.token)
    ?? '';
  if (configuredToken && providedToken !== configuredToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const post = typeof body.post === 'string'
    ? (() => {
        try {
          return readRecord(JSON.parse(body.post));
        } catch {
          return null;
        }
      })()
    : readRecord(body.post);
  const message = readString(post?.message) ?? readString(body.text) ?? '';
  const channelId = readString(post?.channel_id) ?? readString(body.channel_id);
  const threadId = readString(post?.root_id) ?? readString(body.root_id);
  const userId = readString(post?.user_id) ?? readString(body.user_id);
  const teamId = readString(post?.team_id) ?? readString(body.team_id);
  if (!channelId) return Response.json({ error: 'Missing channel id' }, { status: 400 });

  const task = readString(body.command) ? message : message;
  const policy = await context.authorizeSurfaceIngress({
    surface: 'mattermost',
    userId,
    channelId,
    groupId: teamId ?? channelId,
    threadId,
    workspaceId: teamId,
    conversationKind: threadId ? 'thread' : 'channel',
    text: task,
    mentioned: true,
    metadata: {
      ...body,
      ...(post ? { post } : {}),
    },
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadId ? 'thread' : 'channel',
    surfaceKind: 'mattermost',
    surfaceId: teamId ?? 'mattermost',
    externalId: threadId ?? channelId,
    channelId,
    threadId,
    title: readString(body.channel_name) ?? channelId,
    metadata: {
      ...body,
      ...(post ? { post } : {}),
    },
  });
  if (!task) {
    return Response.json({ ok: true, acknowledged: true, bindingId: binding.id });
  }

  const controlCommand = context.parseSurfaceControlCommand(task);
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ ok: true, acknowledged: true, message });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'mattermost',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId,
    displayName: readString(body.user_name) ?? userId,
    title: binding.title ?? 'Mattermost',
    body: task,
    metadata: binding.metadata,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleMattermostSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task,
    sessionId: submission.session.id,
  });

  if ((req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
    return Response.json({
      response_type: 'ephemeral',
      text: 'GoodVibes accepted the request and is processing it.',
    });
  }
  return Response.json({
    ok: true,
    queued: true,
    bindingId: binding.id,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
