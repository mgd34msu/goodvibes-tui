import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { GitHubIntegration } from '@pellux/goodvibes-sdk/platform/integrations/github';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { TrySpawnAgentFn } from '../types.ts';

function parseJsonRecord(rawBody: string): Record<string, unknown> | Response {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

export async function handleGitHubAutomationWebhook(
  req: Request,
  context: {
    readonly serviceRegistry: ServiceRegistry;
    readonly githubWebhookSecret: string | null;
    readonly trySpawnAgent: TrySpawnAgentFn;
  },
): Promise<Response> {
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_000_000) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const rawBody = await req.text();
  const githubWebhookSecret =
    context.githubWebhookSecret
    ?? await context.serviceRegistry.resolveSecret('github', 'signingSecret');
  if (!githubWebhookSecret) {
    logger.warn('handleGitHubAutomationWebhook: GITHUB_WEBHOOK_SECRET not configured — rejecting');
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (!signature) {
    return Response.json({ error: 'Missing X-Hub-Signature-256 header' }, { status: 401 });
  }
  if (!GitHubIntegration.verifySignature(rawBody, signature, githubWebhookSecret)) {
    logger.warn('handleGitHubAutomationWebhook: GitHub webhook signature verification failed');
    return Response.json({ error: 'Invalid webhook signature' }, { status: 401 });
  }

  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;

  const event = GitHubIntegration.parseEvent(req.headers, body);
  const prompt = GitHubIntegration.eventToPrompt(event);
  if (prompt === null) {
    logger.info('handleGitHubAutomationWebhook: event ignored (no prompt generated)', {
      type: event.type,
      action: event.action,
    });
    return Response.json({ acknowledged: true, queued: false, reason: 'Event not actionable' });
  }

  const spawnResult = context.trySpawnAgent({ mode: 'spawn', task: prompt }, 'handleGitHubAutomationWebhook');
  if (spawnResult instanceof Response) return spawnResult;
  logger.info('handleGitHubAutomationWebhook: spawned agent', {
    type: event.type,
    action: event.action,
    agentId: spawnResult.id,
  });

  return Response.json({
    acknowledged: true,
    queued: true,
    agentId: spawnResult.id,
    eventType: event.type,
    action: event.action,
  });
}
