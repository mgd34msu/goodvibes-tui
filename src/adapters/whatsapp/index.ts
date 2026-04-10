import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function handleWhatsAppSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const verifyToken =
    String(context.configManager.get('surfaces.whatsapp.verifyToken') ?? '')
    || await context.serviceRegistry.resolveSecret('whatsapp', 'signingSecret')
    || process.env.WHATSAPP_VERIFY_TOKEN
    || '';
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode') ?? '';
    const token = url.searchParams.get('hub.verify_token') ?? '';
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      return new Response(challenge, { status: 200 });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const entry = Array.isArray(payload.entry) ? readRecord(payload.entry[0]) : null;
  const change = entry && Array.isArray(entry.changes) ? readRecord(entry.changes[0]) : null;
  const value = readRecord(change?.value);
  const message = value && Array.isArray(value.messages) ? readRecord(value.messages[0]) : null;
  if (!message) {
    return Response.json({ acknowledged: true, ignored: true });
  }
  const contact = value && Array.isArray(value.contacts) ? readRecord(value.contacts[0]) : null;
  const from = readString(message.from);
  const text = readString(readRecord(message.text)?.body) ?? readString(message.caption) ?? '';
  if (!from) return Response.json({ error: 'Missing sender' }, { status: 400 });

  const policy = await context.authorizeSurfaceIngress({
    surface: 'whatsapp',
    userId: from,
    channelId: from,
    groupId: from,
    conversationKind: 'direct',
    text,
    mentioned: true,
    metadata: {
      messageId: readString(message.id),
      profileName: readString(contact?.profile && readRecord(contact.profile)?.name),
      phoneNumberId: readString(value?.metadata && readRecord(value.metadata)?.phone_number_id),
    },
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'whatsapp',
    surfaceId: readString(value?.metadata && readRecord(value.metadata)?.phone_number_id)
      ?? readString(context.configManager.get('surfaces.whatsapp.phoneNumberId'))
      ?? 'whatsapp',
    externalId: from,
    channelId: from,
    title: readString(contact?.profile && readRecord(contact.profile)?.name) ?? from,
    metadata: {
      messageId: readString(message.id),
      from,
    },
  });
  if (!text) {
    return Response.json({ acknowledged: true, queued: false, bindingId: binding.id });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'whatsapp',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.channelId,
    userId: from,
    displayName: binding.title,
    title: binding.title ?? from,
    body: text,
    metadata: {
      messageId: readString(message.id),
    },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleWhatsAppSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: text,
    sessionId: submission.session.id,
  });
  return Response.json({ acknowledged: true, queued: true, bindingId: binding.id, sessionId: submission.session.id, agentId: spawnResult.id });
}
