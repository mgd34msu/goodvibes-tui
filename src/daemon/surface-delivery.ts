import { createHmac } from 'crypto';
import type { ConfigManager } from '../config/manager.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { AgentManager } from '../tools/agent/index.ts';
import type { SharedSessionBroker } from '../control-plane/index.ts';
import type { ChannelPluginRegistry, ChannelReplyPipeline, RouteBindingManager } from '../channels/index.ts';
import type { ChannelSurface } from '../channels/index.ts';
import { SlackIntegration, DiscordIntegration, NtfyIntegration } from '../integrations/index.ts';
import { logger } from '../utils/logger.ts';
import { validatePublicWebhookUrl } from '../utils/url-safety.ts';
import type { SharedApprovalRecord } from '../control-plane/index.ts';
import type { PendingSurfaceReply } from './types.ts';
import { summarizeError } from '../utils/error-display.ts';

type DeliverySurface =
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix';

type RouteBinding = import('../automation/routes.ts').AutomationRouteBinding;

function isSupportedDeliverySurface(surface: string): surface is DeliverySurface {
  return surface === 'slack'
    || surface === 'discord'
    || surface === 'ntfy'
    || surface === 'webhook'
    || surface === 'telegram'
    || surface === 'google-chat'
    || surface === 'signal'
    || surface === 'whatsapp'
    || surface === 'imessage'
    || surface === 'msteams'
    || surface === 'bluebubbles'
    || surface === 'mattermost'
    || surface === 'matrix';
}

interface SurfaceReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionId?: string;
}

interface WebhookReplyInput extends SurfaceReplyInput {
  readonly routeId?: string;
  readonly callbackUrl?: string;
  readonly callbackCorrelationId?: string;
  readonly callbackSignature?: PendingSurfaceReply['callbackSignature'];
}

interface DaemonSurfaceDeliveryContext {
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly channelReplyPipeline: ChannelReplyPipeline;
  readonly configManager: ConfigManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly agentManager: AgentManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly authToken: () => string | null;
  readonly surfaceDeliveryEnabled: (surface: DeliverySurface) => boolean;
}

export class DaemonSurfaceDeliveryHelper {
  constructor(private readonly context: DaemonSurfaceDeliveryContext) {}

  queueSurfaceReplyFromBinding(binding: RouteBinding | undefined, input: SurfaceReplyInput): void {
    if (!binding) return;
    if (!isSupportedDeliverySurface(binding.surfaceKind)) return;
    if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return;
    const pending = this.buildPendingSurfaceReply(binding, input);
    if (!pending) return;
    this.context.pendingSurfaceReplies.set(input.agentId, pending);
    this.context.channelReplyPipeline.trackPending(pending);
  }

  queueWebhookReply(input: WebhookReplyInput): void {
    const pending: PendingSurfaceReply = {
      agentId: input.agentId,
      surfaceKind: 'webhook',
      task: input.task,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: input.routeId,
      callbackUrl: input.callbackUrl,
      callbackCorrelationId: input.callbackCorrelationId,
      callbackSignature: input.callbackSignature,
    };
    this.context.pendingSurfaceReplies.set(input.agentId, pending);
    this.context.channelReplyPipeline.trackPending(pending);
  }

  async pollPendingSurfaceReplies(syncFinishedAgentTask: (record: import('../tools/agent/index.ts').AgentRecord) => void): Promise<void> {
    if (this.context.pendingSurfaceReplies.size === 0) return;
    const completed: string[] = [];
    for (const pending of this.context.pendingSurfaceReplies.values()) {
      if (!this.context.channelReplyPipeline.has(pending.agentId)) {
        completed.push(pending.agentId);
        continue;
      }
      const record = this.context.agentManager.getStatus(pending.agentId);
      if (record && (record.status === 'pending' || record.status === 'running')) {
        const progress = record.progress ?? record.streamingContent;
        if (progress && progress !== pending.lastProgress && (Date.now() - (pending.lastProgressAt ?? 0)) >= 10_000) {
          try {
            await this.context.channelReplyPipeline.deliverProgress(pending.agentId, progress, true);
            pending.lastProgress = progress;
            pending.lastProgressAt = Date.now();
          } catch (error) {
            logger.debug('DaemonServer: progress delivery failed', {
              surface: pending.surfaceKind,
              agentId: pending.agentId,
              error: summarizeError(error),
            });
          }
        }
      }
      if (!record || (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled')) {
        continue;
      }
      const body = record.status === 'completed'
        ? (record.fullOutput ?? record.streamingContent ?? record.progress ?? 'Completed')
        : record.error ?? record.status;
      const message = String(body);
      syncFinishedAgentTask(record);
      if (pending.sessionId) {
        await this.context.sessionBroker.completeAgent(pending.sessionId, pending.agentId, message, {
          status: record.status,
          routeId: pending.routeId,
        });
      }
      try {
        await this.context.channelReplyPipeline.deliverFinal(pending.agentId, message);
      } catch (error) {
        logger.warn('DaemonServer: surface reply delivery failed', {
          surface: pending.surfaceKind,
          agentId: pending.agentId,
          error: summarizeError(error),
        });
      }
      completed.push(pending.agentId);
    }
    for (const agentId of completed) {
      this.context.pendingSurfaceReplies.delete(agentId);
    }
  }

  async deliverSurfaceProgress(pending: PendingSurfaceReply, progress: string): Promise<void> {
    if (pending.surfaceKind === 'slack') {
      const webhookUrl =
        await this.context.serviceRegistry.resolveSecret('slack', 'webhookUrl')
        ?? process.env.SLACK_WEBHOOK_URL;
      const botToken =
        await this.context.serviceRegistry.resolveSecret('slack', 'primary')
        ?? process.env.SLACK_BOT_TOKEN;
      const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      if (pending.responseUrl) {
        await fetch(pending.responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            text: `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`,
          }),
        });
        return;
      }
      if (pending.channelId) {
        await slack.postMessage(pending.channelId, `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`);
      }
      return;
    }
    if (pending.surfaceKind === 'discord') {
      const webhookUrl =
        await this.context.serviceRegistry.resolveSecret('discord', 'webhookUrl')
        ?? process.env.DISCORD_WEBHOOK_URL;
      const botToken =
        await this.context.serviceRegistry.resolveSecret('discord', 'primary')
        ?? process.env.DISCORD_BOT_TOKEN;
      const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      if (pending.applicationId && pending.interactionToken) {
        await discord.editOriginalResponse(pending.applicationId, pending.interactionToken, `Progress: ${progress.slice(0, 180)}`);
        return;
      }
      if (pending.channelId) {
        await discord.postMessage(pending.channelId, `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`);
      }
    }
  }

  async deliverSlackAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const webhookUrl =
      await this.context.serviceRegistry.resolveSecret('slack', 'webhookUrl')
      ?? process.env.SLACK_WEBHOOK_URL;
    const botToken =
      await this.context.serviceRegistry.resolveSecret('slack', 'primary')
      ?? process.env.SLACK_BOT_TOKEN;
    const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    if (pending.responseUrl) {
      await fetch(pending.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'in_channel',
          blocks: slack.formatAgentResult(pending.agentId, pending.task, message),
        }),
      });
      return;
    }
    if (pending.channelId) {
      await slack.postMessage(pending.channelId, message, slack.formatAgentResult(pending.agentId, pending.task, message));
    }
  }

  async deliverDiscordAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const webhookUrl =
      await this.context.serviceRegistry.resolveSecret('discord', 'webhookUrl')
      ?? process.env.DISCORD_WEBHOOK_URL;
    const botToken =
      await this.context.serviceRegistry.resolveSecret('discord', 'primary')
      ?? process.env.DISCORD_BOT_TOKEN;
    const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    if (pending.applicationId && pending.interactionToken) {
      await discord.editOriginalResponse(
        pending.applicationId,
        pending.interactionToken,
        '',
        [discord.formatAgentResult(pending.agentId, pending.task, message)],
      );
      return;
    }
    if (pending.channelId) {
      await discord.postMessage(pending.channelId, message, [discord.formatAgentResult(pending.agentId, pending.task, message)]);
    }
  }

  async deliverNtfyAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const baseUrl = String(this.context.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
    const token = await this.context.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN;
    const topic = pending.topic ?? String(this.context.configManager.get('surfaces.ntfy.topic') ?? '');
    if (!topic) return;
    const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
    const webBase = String(this.context.configManager.get('controlPlane.baseUrl') ?? this.context.configManager.get('web.publicBaseUrl') ?? '');
    const baseAction = webBase.replace(/\/+$/, '');
    await ntfy.publish(topic, message, {
      title: `Agent ${pending.agentId}`,
      ...(baseAction
        ? {
            click: `${baseAction}/api/control-plane/web`,
            actions: [
              `${pending.sessionId ? `view,Session,${baseAction}/api/control-plane/web?session=${encodeURIComponent(pending.sessionId)}` : `view,Control Plane,${baseAction}/api/control-plane/web`}`,
            ],
          }
        : {}),
    });
  }

  async deliverWebhookAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const callbackUrl = pending.callbackUrl ?? String(this.context.configManager.get('surfaces.webhook.defaultTarget') ?? '');
    if (!callbackUrl) return;
    const validation = validatePublicWebhookUrl(callbackUrl);
    if (!validation.ok) {
      logger.warn('DaemonServer: refusing unsafe webhook callback URL', {
        agentId: pending.agentId,
        reason: validation.error,
      });
      return;
    }
    const timeoutMs = Number(this.context.configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
    const payload = {
      agentId: pending.agentId,
      sessionId: pending.sessionId ?? null,
      routeId: pending.routeId ?? null,
      task: pending.task,
      message,
      status: this.context.agentManager.getStatus(pending.agentId)?.status ?? 'completed',
      correlationId: pending.callbackCorrelationId ?? null,
      completedAt: Date.now(),
    };
    const body = JSON.stringify(payload);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (pending.callbackCorrelationId) {
      headers.set('X-Goodvibes-Correlation-Id', pending.callbackCorrelationId);
    }
    const secret = String(this.context.configManager.get('surfaces.webhook.secret') ?? '');
    if (secret && pending.callbackSignature === 'hmac-sha256') {
      headers.set('X-Goodvibes-Signature', this.signWebhookPayload(body, secret));
    } else if (secret && pending.callbackSignature === 'shared-secret') {
      headers.set('X-Goodvibes-Webhook-Secret', secret);
    }
    await fetch(validation.url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body,
    });
  }

  async notifyApprovalUpdate(approval: SharedApprovalRecord): Promise<void> {
    await this.context.sessionBroker.start();
    await this.context.routeBindings.start();
    const routeId = approval.routeId
      ?? this.context.sessionBroker.getSession(approval.sessionId ?? '')?.routeIds[0];
    if (!routeId) return;
    const binding = this.context.routeBindings.getBinding(routeId);
    if (!binding) return;
    if (binding.surfaceKind !== 'service') {
      const pluginDelivered = await this.context.channelPlugins.notifyApproval(binding.surfaceKind, approval, binding);
      if (pluginDelivered) {
        return;
      }
    }

    if (binding.surfaceKind === 'slack') {
      await this.deliverSlackApprovalUpdate(approval, binding);
      return;
    }
    if (binding.surfaceKind === 'discord') {
      await this.deliverDiscordApprovalUpdate(approval, binding);
      return;
    }
    if (binding.surfaceKind === 'ntfy') {
      await this.deliverNtfyApprovalUpdate(approval, binding);
      return;
    }
    if (binding.surfaceKind === 'webhook') {
      await this.deliverWebhookApprovalUpdate(approval, binding);
    }
  }

  controlPlaneWebUrl(input: { readonly approvalId?: string; readonly sessionId?: string }): string | undefined {
    const base = String(this.context.configManager.get('controlPlane.baseUrl') ?? this.context.configManager.get('web.publicBaseUrl') ?? '');
    if (!base) return undefined;
    const url = new URL(`${base.replace(/\/+$/, '')}/api/control-plane/web`);
    if (input.approvalId) url.searchParams.set('approval', input.approvalId);
    if (input.sessionId) url.searchParams.set('session', input.sessionId);
    return url.toString();
  }

  signWebhookPayload(body: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  private buildPendingSurfaceReply(binding: RouteBinding, input: SurfaceReplyInput): PendingSurfaceReply | null {
    const shared = {
      agentId: input.agentId,
      task: input.task,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: binding.id,
      threadId: binding.threadId,
    } as const;

    switch (binding.surfaceKind) {
      case 'slack':
        return {
          ...shared,
          surfaceKind: 'slack',
          responseUrl: typeof binding.metadata.responseUrl === 'string' ? binding.metadata.responseUrl : undefined,
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'discord':
        return {
          ...shared,
          surfaceKind: 'discord',
          channelId: binding.channelId,
          applicationId: typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined,
          interactionToken: typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'ntfy':
        return {
          ...shared,
          surfaceKind: 'ntfy',
          topic: binding.channelId ?? binding.externalId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'webhook':
        return {
          ...shared,
          surfaceKind: 'webhook',
          callbackUrl: typeof binding.metadata.callbackUrl === 'string' ? binding.metadata.callbackUrl : undefined,
          callbackCorrelationId: typeof binding.metadata.correlationId === 'string' ? binding.metadata.correlationId : undefined,
          callbackSignature: typeof binding.metadata.callbackSignature === 'string'
            ? binding.metadata.callbackSignature as PendingSurfaceReply['callbackSignature']
            : undefined,
        };
      case 'telegram':
      case 'google-chat':
      case 'signal':
      case 'whatsapp':
      case 'imessage':
      case 'msteams':
      case 'bluebubbles':
      case 'mattermost':
      case 'matrix':
        return {
          ...shared,
          surfaceKind: binding.surfaceKind,
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'service':
        return null;
      default:
        return null;
    }
  }

  async deliverSlackApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;
    const webhookUrl =
      await this.context.serviceRegistry.resolveSecret('slack', 'webhookUrl')
      ?? process.env.SLACK_WEBHOOK_URL;
    const botToken =
      await this.context.serviceRegistry.resolveSecret('slack', 'primary')
      ?? process.env.SLACK_BOT_TOKEN;
    const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    const blocks = isPending
      ? [
          { type: 'section', text: { type: 'mrkdwn', text: `*Approval required* for \`${approval.request.tool}\`\n${summary}` } },
          {
            type: 'actions',
            elements: [
              { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: `gv:approval:approve:${approval.id}` },
              { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, action_id: `gv:approval:deny:${approval.id}` },
              ...(webUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Open Console' }, url: webUrl }] : []),
            ],
          },
        ]
      : undefined;
    if (typeof binding.metadata.responseUrl === 'string' && binding.metadata.responseUrl.startsWith('https://')) {
      await fetch(binding.metadata.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'in_channel',
          text: isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`,
          ...(blocks ? { blocks } : {}),
        }),
      }).catch(() => {});
      return;
    }
    if (binding.channelId) {
      await slack.postMessage(binding.channelId, isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`, blocks);
    }
  }

  async deliverDiscordApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;
    const webhookUrl =
      await this.context.serviceRegistry.resolveSecret('discord', 'webhookUrl')
      ?? process.env.DISCORD_WEBHOOK_URL;
    const botToken =
      await this.context.serviceRegistry.resolveSecret('discord', 'primary')
      ?? process.env.DISCORD_BOT_TOKEN;
    const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    const content = isPending
      ? `Approval required for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`
      : `Approval ${approval.status} for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`;
    const applicationId = typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined;
    const interactionToken = typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined;
    if (applicationId && interactionToken) {
      await discord.editOriginalResponse(applicationId, interactionToken, content).catch(() => {});
      return;
    }
    if (binding.channelId) {
      await discord.postMessage(binding.channelId, content).catch(() => {});
    }
  }

  async deliverNtfyApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    const topic = binding.channelId ?? binding.externalId;
    if (!topic) return;
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;
    const ntfy = new NtfyIntegration(
      String(this.context.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
      await this.context.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
    );
    await ntfy.publish(topic, `${isPending ? 'Approval required' : `Approval ${approval.status}`}: ${summary}`, {
      title: approval.request.tool,
      ...(webUrl ? { click: webUrl } : {}),
    }).catch(() => {});
  }

  async deliverWebhookApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    if (typeof binding.metadata.callbackUrl !== 'string') return;
    const validation = validatePublicWebhookUrl(binding.metadata.callbackUrl);
    if (!validation.ok) {
      logger.warn('DaemonServer: refusing unsafe webhook approval callback URL', {
        approvalId: approval.id,
        reason: validation.error,
      });
      return;
    }
    const payload = JSON.stringify({
      type: 'approval',
      approval,
      webUrl: this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId }) ?? null,
    });
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const secret = String(this.context.configManager.get('surfaces.webhook.secret') ?? '');
    if (secret) {
      headers.set('X-Goodvibes-Signature', this.signWebhookPayload(payload, secret));
    }
    await fetch(validation.url, {
      method: 'POST',
      headers,
      body: payload,
    }).catch(() => {});
  }
}
