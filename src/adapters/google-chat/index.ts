import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function handleGoogleChatSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_000_000) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }
  const verificationToken =
    String(context.configManager.get('surfaces.googleChat.verificationToken') ?? '')
    || await context.serviceRegistry.resolveSecret('google-chat', 'signingSecret')
    || process.env.GOOGLE_CHAT_VERIFICATION_TOKEN
    || '';
  const body = await req.json().catch(() => null);
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const providedToken = readString(payload.token) ?? req.headers.get('x-goog-chat-token') ?? '';
  if (verificationToken && providedToken !== verificationToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const eventType = readString(payload.type) ?? 'MESSAGE';
  if (eventType !== 'MESSAGE' && eventType !== 'ADDED_TO_SPACE') {
    return Response.json({ text: 'ignored' });
  }

  const message = readRecord(payload.message);
  const space = readRecord(payload.space);
  const user = readRecord(payload.user) ?? readRecord(message?.sender);
  const thread = readRecord(message?.thread);
  const text = readString(message?.argumentText) ?? readString(message?.text) ?? '';
  const spaceName = readString(space?.name);
  if (!spaceName) return Response.json({ text: 'missing space' }, { status: 400 });
  const threadName = readString(thread?.name);

  const policy = await context.authorizeSurfaceIngress({
    surface: 'google-chat',
    userId: readString(user?.name),
    channelId: spaceName,
    groupId: spaceName,
    threadId: threadName,
    workspaceId: readString(payload.hostApp),
    conversationKind: threadName ? 'thread' : 'channel',
    text,
    mentioned: true,
    metadata: {
      eventType,
      spaceDisplayName: readString(space?.displayName),
      userDisplayName: readString(user?.displayName),
    },
  });
  if (!policy.allowed) {
    return Response.json({ text: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadName ? 'thread' : 'channel',
    surfaceKind: 'google-chat',
    surfaceId: readString(context.configManager.get('surfaces.googleChat.appId')) ?? 'google-chat',
    externalId: threadName ?? spaceName,
    channelId: spaceName,
    threadId: threadName,
    title: readString(space?.displayName) ?? spaceName,
    metadata: {
      eventType,
      userName: readString(user?.name),
    },
  });

  if (!text) {
    return Response.json({ text: 'Acknowledged.' });
  }

  const controlCommand = context.parseSurfaceControlCommand(text);
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ text: message });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'google-chat',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: readString(user?.name),
    displayName: readString(user?.displayName),
    title: binding.title ?? 'Google Chat',
    body: text,
    metadata: {
      eventType,
      spaceName,
    },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ text: `Continuing session ${submission.session.id}.` });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleGoogleChatSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: text,
    sessionId: submission.session.id,
  });
  return Response.json({ text: `Running ${spawnResult.id}` });
}
