import type { ChannelConversationKind } from '../../channels/index.ts';
import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stripTeamsMarkup(text: string): string {
  return text
    .replace(/<at>.*?<\/at>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsConversationKind(conversationType?: string, threadId?: string): ChannelConversationKind {
  if (threadId) return 'thread';
  if (conversationType === 'personal') return 'direct';
  if (conversationType === 'channel') return 'channel';
  return 'group';
}

function normalizeConversationId(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/;messageid=[^;]+$/i, '');
}

export async function handleMSTeamsSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const configuredSecret =
    String(context.configManager.get('surfaces.msteams.appPassword') ?? '')
    || await context.serviceRegistry.resolveSecret('msteams', 'password')
    || process.env.MSTEAMS_APP_PASSWORD
    || '';
  const providedToken = req.headers.get('x-goodvibes-msteams-token')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  if (configuredSecret && !providedToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const activity = readRecord(body);
  if (!activity) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const activityType = readString(activity.type)?.toLowerCase();
  if (activityType && activityType !== 'message' && activityType !== 'invoke') {
    return Response.json({ ok: true, ignored: true, activityType });
  }

  const conversation = readRecord(activity.conversation);
  const from = readRecord(activity.from);
  const value = readRecord(activity.value);
  const channelData = readRecord(activity.channelData);
  const conversationId = normalizeConversationId(readString(conversation?.id));
  if (!conversationId) return Response.json({ error: 'Missing conversation id' }, { status: 400 });
  const replyToId = readString(activity.replyToId);
  const serviceUrl = readString(activity.serviceUrl)
    ?? (String(context.configManager.get('surfaces.msteams.serviceUrl') ?? '').trim() || undefined);
  const text = stripTeamsMarkup(
    readString(activity.text)
    ?? readString(value?.text)
    ?? readString(value?.command)
    ?? '',
  );
  const conversationType = readString(conversation?.conversationType) ?? readString(channelData?.conversationType);
  const channelId = readString(conversation?.id) ?? conversationId;
  const team = readRecord(channelData?.team);
  const channel = readRecord(channelData?.channel);
  const tenant = readRecord(channelData?.tenant);
  const teamId = readString(team?.['id']);
  const channelEntryId = readString(channel?.['id']);
  const tenantId = readString(tenant?.['id']);
  const policy = await context.authorizeSurfaceIngress({
    surface: 'msteams',
    userId: readString(from?.id),
    channelId,
    groupId: channelEntryId ?? channelId,
    threadId: replyToId,
    workspaceId: teamId ?? tenantId,
    conversationKind: teamsConversationKind(conversationType, replyToId),
    text,
    mentioned: conversationType === 'personal' || /goodvibes/i.test(text),
    metadata: {
      activityId: readString(activity.id),
      conversationId,
      conversationType,
      replyToId,
      serviceUrl,
      teamId,
      channelId: channelEntryId,
      tenantId,
    },
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: replyToId ? 'thread' : 'channel',
    surfaceKind: 'msteams',
    surfaceId: readString(context.configManager.get('surfaces.msteams.botId'))
      ?? readString(context.configManager.get('surfaces.msteams.appId'))
      ?? 'msteams',
    externalId: replyToId ?? conversationId,
    channelId: channelId,
    threadId: replyToId,
    title: readString(conversation?.name) ?? readString(channel?.id) ?? conversationId,
    metadata: {
      ...activity,
      conversationId,
      serviceUrl,
      conversationType,
      replyToId,
      teamId,
      channelId: channelEntryId,
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
    surfaceKind: 'msteams',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: readString(from?.id),
    displayName: readString(from?.name) ?? readString(from?.id),
    title: binding.title ?? 'Microsoft Teams',
    body: text,
    metadata: binding.metadata,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleMSTeamsSurfaceWebhook',
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
