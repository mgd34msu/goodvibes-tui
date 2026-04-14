import { logger } from '../../utils/logger.ts';
import { SlackIntegration } from '../../integrations/index.ts';
import type { SurfaceAdapterContext } from '../types.ts';
import { summarizeError } from '../../utils/error-display.ts';

export async function handleSlackSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_000_000) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const signingSecret =
    await context.serviceRegistry.resolveSecret('slack', 'signingSecret')
    ?? process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    logger.warn('handleSlackSurfaceWebhook: SLACK_SIGNING_SECRET not set — rejecting');
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
  const signature = req.headers.get('x-slack-signature') ?? '';
  const rawBody = await req.text();

  const slack = new SlackIntegration(
    await context.serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL,
    await context.serviceRegistry.resolveSecret('slack', 'primary') ?? process.env.SLACK_BOT_TOKEN,
  );

  if (!slack.verifySignature(rawBody, timestamp, signature, signingSecret)) {
    logger.warn('handleSlackSurfaceWebhook: invalid signature');
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let bodyRecord: Record<string, unknown>;
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      bodyRecord = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  } else {
    bodyRecord = Object.fromEntries(new URLSearchParams(rawBody));
  }

  if (bodyRecord.type === 'url_verification') {
    return Response.json({ challenge: bodyRecord.challenge });
  }

  return handleSlackSurfacePayload(bodyRecord, context, slack, req);
}

export async function handleSlackSurfacePayload(
  bodyRecord: Record<string, unknown>,
  context: SurfaceAdapterContext,
  slack = new SlackIntegration(),
  req: Request = new Request('http://goodvibes.local/webhook/slack', { method: 'POST' }),
): Promise<Response> {
  const event = slack.parseEvent(bodyRecord);
  if (event.type === 'slash_command') {
    const task = event.text.trim();
    const policy = await context.authorizeSurfaceIngress({
      surface: 'slack',
      userId: event.userId,
      channelId: event.channelId,
      groupId: event.channelId,
      conversationKind: 'channel',
      text: task,
      mentioned: true,
      metadata: {
        command: event.command,
        userName: event.userName,
      },
    });
    if (!policy.allowed) {
      return Response.json({
        response_type: 'ephemeral',
        text: `Blocked by channel policy: ${policy.reason}`,
      }, { status: 403 });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: 'channel',
      surfaceKind: 'slack',
      surfaceId: event.teamId || 'slack',
      externalId: event.channelId,
      channelId: event.channelId,
      title: event.channelName || event.command,
      metadata: {
        command: event.command,
        userId: event.userId,
        userName: event.userName,
        responseUrl: event.responseUrl,
      },
    });
    if (!task) {
      return Response.json({
        response_type: 'ephemeral',
        text: 'Usage: `/goodvibes <your prompt>`',
      });
    }

    const controlCommand = context.parseSurfaceControlCommand(task);
    if (controlCommand) {
      const message = await context.performSurfaceControlCommand(controlCommand);
      return Response.json({
        response_type: 'ephemeral',
        text: message,
      });
    }

    let responseUrl: string | undefined = event.responseUrl;
    if (responseUrl && !responseUrl.startsWith('https://hooks.slack.com/')) {
      logger.warn('handleSlackSurfaceWebhook: suspicious responseUrl, ignoring');
      responseUrl = undefined;
    }
    setImmediate(() => {
      void (async () => {
        const submission = await context.sessionBroker.submitMessage({
          routeId: binding.id,
          surfaceKind: 'slack',
          surfaceId: binding.surfaceId,
          externalId: event.channelId,
          threadId: event.channelId,
          userId: event.userId,
          displayName: event.userName,
          title: event.channelName || event.command,
          body: task,
          metadata: {
            command: event.command,
            responseUrl,
          },
        });
        if (submission.mode === 'continued-live') {
          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'in_channel',
                text: `Continuing session ${submission.session.id} via agent ${submission.activeAgentId}.`,
              }),
            }).catch(() => {});
          }
          return;
        }

        const spawnResult = context.trySpawnAgent(
          { mode: 'spawn', task: submission.task! },
          'handleSlackSurfaceWebhook',
          submission.session.id,
        );
        if (spawnResult instanceof Response) {
          const payload = await spawnResult.json() as { error?: string };
          const message = payload.error ?? 'Agent spawn failed';
          logger.error('handleSlackSurfaceWebhook: spawn failed', { error: message });
          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'in_channel',
                text: `Agent spawn failed: ${message}`,
              }),
            }).catch(() => {});
          }
          return;
        }

        await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
        context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
          agentId: spawnResult.id,
          task,
          sessionId: submission.session.id,
        });
        if (responseUrl) {
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response_type: 'in_channel',
              blocks: slack.formatAgentResult(
                spawnResult.id,
                task,
                `Session ${submission.session.id} active. Agent ${spawnResult.id} will reply in-channel when complete.`,
              ),
            }),
          }).catch((error: unknown) => {
            logger.warn('handleSlackSurfaceWebhook: follow-up post failed', {
              error: summarizeError(error),
            });
          });
        }
      })();
    });

    return Response.json({
      response_type: 'in_channel',
      text: `Running: _${task}_`,
    });
  }

  if (event.type === 'event_callback') {
    if (event.eventType !== 'app_mention' && event.eventType !== 'message') {
      return new Response(null, { status: 200 });
    }
    const task = event.text.trim();
    if (!task) return new Response(null, { status: 200 });
    const mentioned = event.eventType === 'app_mention' || /<@[A-Z0-9]+>/i.test(task);
    const policy = await context.authorizeSurfaceIngress({
      surface: 'slack',
      userId: event.userId,
      channelId: event.channelId,
      groupId: event.channelId,
      threadId: event.threadTs ?? event.eventTs,
      workspaceId: event.teamId,
      conversationKind: event.threadTs ? 'thread' : 'channel',
      text: task,
      mentioned,
      metadata: {
        eventType: event.eventType,
        eventTs: event.eventTs,
      },
    });
    if (!policy.allowed) {
      return Response.json({ ok: false, error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
    }
    const binding = await context.routeBindings.upsertBinding({
      kind: event.threadTs ? 'thread' : 'channel',
      surfaceKind: 'slack',
      surfaceId: event.teamId || 'slack',
      externalId: event.threadTs ?? event.channelId,
      channelId: event.channelId,
      threadId: event.threadTs,
      title: `Slack ${event.eventType}`,
      metadata: {
        userId: event.userId,
        eventType: event.eventType,
        eventTs: event.eventTs,
      },
    });
    const submission = await context.sessionBroker.submitMessage({
      routeId: binding.id,
      surfaceKind: 'slack',
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId ?? binding.channelId,
      userId: event.userId,
      displayName: event.userId,
      title: `Slack ${event.eventType}`,
      body: task,
      metadata: {
        eventType: event.eventType,
        eventTs: event.eventTs,
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
      'handleSlackSurfacePayload',
      submission.session.id,
    );
    if (spawnResult instanceof Response) return spawnResult;
    await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
    context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
      agentId: spawnResult.id,
      task,
      sessionId: submission.session.id,
    });
    return Response.json({
      ok: true,
      queued: true,
      sessionId: submission.session.id,
      agentId: spawnResult.id,
    });
  }

  const actionPayload = event.payload;
  const actionId = Array.isArray(actionPayload.actions)
    ? (() => {
        const first = actionPayload.actions[0] as Record<string, unknown> | undefined;
        return typeof first?.action_id === 'string' ? first.action_id : '';
      })()
    : '';
  if (actionId) {
    const policy = await context.authorizeSurfaceIngress({
      surface: 'slack',
      userId: typeof (actionPayload.user as Record<string, unknown> | undefined)?.id === 'string'
        ? (actionPayload.user as Record<string, unknown>).id as string
        : undefined,
      channelId: typeof (actionPayload.channel as Record<string, unknown> | undefined)?.id === 'string'
        ? (actionPayload.channel as Record<string, unknown>).id as string
        : undefined,
      groupId: typeof (actionPayload.channel as Record<string, unknown> | undefined)?.id === 'string'
        ? (actionPayload.channel as Record<string, unknown>).id as string
        : undefined,
      conversationKind: 'channel',
      text: actionId,
      mentioned: true,
      metadata: { interactive: true },
    });
    if (!policy.allowed) {
      return Response.json({
        response_type: 'ephemeral',
        text: `Blocked by channel policy: ${policy.reason}`,
      }, { status: 403 });
    }
    const message = await context.performInteractiveSurfaceAction(actionId, 'slack', req);
    return Response.json({
      response_type: 'ephemeral',
      text: message,
    });
  }

  return new Response(null, { status: 200 });
}
