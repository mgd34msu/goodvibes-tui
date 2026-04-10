import { logger } from '../../utils/logger.ts';
import { DiscordIntegration, DiscordInteractionResponseType, DiscordInteractionType } from '../../integrations/index.ts';
import type { SurfaceAdapterContext } from '../types.ts';

export async function handleDiscordSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_000_000) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const publicKey =
    await context.serviceRegistry.resolveSecret('discord', 'publicKey')
    ?? process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    logger.warn('handleDiscordSurfaceWebhook: DISCORD_PUBLIC_KEY not set — rejecting');
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  const rawBody = await req.text();

  const discord = new DiscordIntegration(
    await context.serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL,
    await context.serviceRegistry.resolveSecret('discord', 'primary') ?? process.env.DISCORD_BOT_TOKEN,
  );

  const valid = await discord.verifySignature(rawBody, signature, timestamp, publicKey);
  if (!valid) {
    logger.warn('handleDiscordSurfaceWebhook: invalid Ed25519 signature');
    return new Response('Invalid request signature', { status: 401 });
  }

  let bodyRecord: Record<string, unknown>;
  try {
    bodyRecord = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  return handleDiscordInteractionPayload(bodyRecord, context, discord, req);
}

export async function handleDiscordInteractionPayload(
  bodyRecord: Record<string, unknown>,
  context: SurfaceAdapterContext,
  discord = new DiscordIntegration(),
  req: Request = new Request('http://goodvibes.local/webhook/discord', { method: 'POST' }),
): Promise<Response> {
  const interaction = discord.parseInteraction(bodyRecord);
  if (interaction.type === DiscordInteractionType.Ping) {
    return Response.json({ type: DiscordInteractionResponseType.Pong });
  }

  if (interaction.type === DiscordInteractionType.ApplicationCommand) {
    const promptOption = interaction.commandOptions?.find((option) => option.name === 'prompt');
    const task = typeof promptOption?.value === 'string' ? promptOption.value.trim() : '';
    const policy = await context.authorizeSurfaceIngress({
      surface: 'discord',
      userId: interaction.userId,
      channelId: interaction.channelId,
      groupId: interaction.channelId,
      conversationKind: interaction.channelId ? 'channel' : 'service',
      text: task,
      mentioned: true,
      metadata: {
        commandName: interaction.commandName,
      },
    });
    if (!policy.allowed) {
      return Response.json({
        type: DiscordInteractionResponseType.ChannelMessageWithSource,
        data: { content: `Blocked by channel policy: ${policy.reason}` },
      }, { status: 403 });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: 'channel',
      surfaceKind: 'discord',
      surfaceId: interaction.guildId ?? interaction.applicationId ?? 'discord',
      externalId: interaction.channelId ?? interaction.id,
      channelId: interaction.channelId,
      title: interaction.commandName ?? 'discord',
      metadata: {
        userId: interaction.userId,
        commandName: interaction.commandName,
        applicationId: interaction.applicationId,
        interactionToken: interaction.token,
      },
    });

    const deferredResponse = Response.json({
      type: DiscordInteractionResponseType.DeferredChannelMessageWithSource,
    });
    if (!task) {
      return deferredResponse;
    }

    const controlCommand = context.parseSurfaceControlCommand(task);
    if (controlCommand) {
      const message = await context.performSurfaceControlCommand(controlCommand);
      return Response.json({
        type: DiscordInteractionResponseType.ChannelMessageWithSource,
        data: { content: message },
      });
    }

    const appId = interaction.applicationId;
    const token = interaction.token;

    setImmediate(() => {
      void (async () => {
        const submission = await context.sessionBroker.submitMessage({
          routeId: binding.id,
          surfaceKind: 'discord',
          surfaceId: binding.surfaceId,
          externalId: interaction.channelId ?? interaction.id,
          threadId: interaction.channelId,
          userId: interaction.userId,
          displayName: interaction.userId,
          title: interaction.commandName ?? 'discord',
          body: task,
          metadata: {
            applicationId: appId,
            interactionToken: token,
          },
        });
        if (submission.mode === 'continued-live') {
          await discord
            .editOriginalResponse(appId, token, `Continuing session ${submission.session.id} via agent ${submission.activeAgentId}.`)
            .catch(() => {});
          return;
        }

        const spawnResult = context.trySpawnAgent(
          { mode: 'spawn', task: submission.task! },
          'handleDiscordSurfaceWebhook',
          submission.session.id,
        );
        if (spawnResult instanceof Response) {
          const payload = await spawnResult.json() as { error?: string };
          const message = payload.error ?? 'Agent spawn failed';
          logger.error('handleDiscordSurfaceWebhook: spawn failed', { error: message });
          await discord.editOriginalResponse(appId, token, `Agent spawn failed: ${message}`).catch(() => {});
          return;
        }

        await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
        context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
          agentId: spawnResult.id,
          task,
          sessionId: submission.session.id,
        });
        const embed = discord.formatAgentResult(
          spawnResult.id,
          task,
          `Session ${submission.session.id} active. Result will be posted here when complete.`,
        );
        await discord
          .editOriginalResponse(appId, token, '', [embed])
          .catch((error: unknown) => {
            logger.warn('handleDiscordSurfaceWebhook: follow-up failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      })();
    });

    return deferredResponse;
  }

  if (interaction.type === DiscordInteractionType.MessageComponent) {
    const data = (interaction.raw.data ?? {}) as Record<string, unknown>;
    const customId = typeof data.custom_id === 'string' ? data.custom_id : '';
    if (customId) {
      const policy = await context.authorizeSurfaceIngress({
        surface: 'discord',
        userId: interaction.userId,
        channelId: interaction.channelId,
        groupId: interaction.channelId,
        conversationKind: interaction.channelId ? 'channel' : 'service',
        text: customId,
        mentioned: true,
        metadata: { interactive: true },
      });
      if (!policy.allowed) {
        return Response.json({
          type: DiscordInteractionResponseType.ChannelMessageWithSource,
          data: { content: `Blocked by channel policy: ${policy.reason}` },
        }, { status: 403 });
      }
      const message = await context.performInteractiveSurfaceAction(customId, 'discord', req);
      return Response.json({
        type: DiscordInteractionResponseType.ChannelMessageWithSource,
        data: { content: message },
      });
    }
  }

  return Response.json({ type: DiscordInteractionResponseType.DeferredUpdateMessage });
}

export async function handleDiscordGatewayDispatchPayload(
  dispatch: { readonly t?: string; readonly d?: Record<string, unknown> | null },
  context: SurfaceAdapterContext,
  discord = new DiscordIntegration(),
): Promise<Response> {
  if (!dispatch.d) return new Response(null, { status: 204 });
  if (dispatch.t === 'INTERACTION_CREATE') {
    return handleDiscordInteractionPayload(dispatch.d, context, discord);
  }
  if (dispatch.t !== 'MESSAGE_CREATE') {
    return new Response(null, { status: 204 });
  }

  const author = (dispatch.d.author ?? {}) as Record<string, unknown>;
  if (author.bot === true) return new Response(null, { status: 204 });
  const content = typeof dispatch.d.content === 'string' ? dispatch.d.content.trim() : '';
  if (!content) return new Response(null, { status: 204 });
  const channelId = typeof dispatch.d.channel_id === 'string' ? dispatch.d.channel_id : undefined;
  const guildId = typeof dispatch.d.guild_id === 'string' ? dispatch.d.guild_id : undefined;
  const messageId = typeof dispatch.d.id === 'string' ? dispatch.d.id : undefined;
  const userId = typeof author.id === 'string' ? author.id : undefined;
  const mentioned = Array.isArray(dispatch.d.mentions) && dispatch.d.mentions.length > 0;
  const policy = await context.authorizeSurfaceIngress({
    surface: 'discord',
    userId,
    channelId,
    groupId: channelId,
    workspaceId: guildId,
    conversationKind: channelId ? 'channel' : 'service',
    text: content,
    mentioned,
    metadata: {
      gatewayEvent: dispatch.t,
      messageId,
    },
  });
  if (!policy.allowed) {
    return Response.json({ ok: false, error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }
  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'discord',
    surfaceId: guildId ?? 'discord',
    externalId: channelId ?? messageId ?? 'discord',
    channelId,
    title: 'Discord message',
    metadata: {
      userId,
      messageId,
      gatewayEvent: dispatch.t,
    },
  });
  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'discord',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.channelId,
    userId,
    displayName: typeof author.username === 'string' ? author.username : userId,
    title: 'Discord message',
    body: content,
    metadata: {
      messageId,
      gatewayEvent: dispatch.t,
    },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({
      ok: true,
      continued: true,
      sessionId: submission.session.id,
      agentId: submission.activeAgentId,
    });
  }
  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleDiscordGatewayDispatchPayload',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: content,
    sessionId: submission.session.id,
  });
  return Response.json({
    ok: true,
    queued: true,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
