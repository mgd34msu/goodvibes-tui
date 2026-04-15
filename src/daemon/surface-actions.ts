import type { ConfigManager } from '../config/manager.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { AgentManager } from '../tools/agent/index.ts';
import type { SharedSessionBroker } from '../control-plane/index.ts';
import type { RouteBindingManager, ChannelPolicyManager } from '../channels/index.ts';
import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../adapters/index.ts';
import type { AutomationManager } from '../automation/index.ts';
import type { ChannelPolicyDecision, ChannelIngressPolicyInput } from '../channels/index.ts';

interface DaemonSurfaceActionContext {
  readonly serviceRegistry: ServiceRegistry;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly channelPolicy: ChannelPolicyManager;
  readonly automationManager: AutomationManager;
  readonly agentManager: AgentManager;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly sessionId?: string },
  ) => void;
  readonly queueWebhookReply: (input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly callbackUrl?: string;
    readonly callbackCorrelationId?: string;
    readonly callbackSignature?: import('./types.ts').PendingSurfaceReply['callbackSignature'];
  }) => void;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (
    approvalId: string,
    action: 'claim' | 'approve' | 'deny' | 'cancel',
    req: Request,
  ) => Promise<Response>;
}

export class DaemonSurfaceActionHelper {
  constructor(private readonly context: DaemonSurfaceActionContext) {}

  buildSurfaceAdapterContext(): SurfaceAdapterContext {
    return {
      serviceRegistry: this.context.serviceRegistry,
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      authorizeSurfaceIngress: (input) => this.authorizeSurfaceIngress(input),
      parseSurfaceControlCommand: (text) => this.parseSurfaceControlCommand(text),
      performSurfaceControlCommand: (command) => this.performSurfaceControlCommand(command),
      performInteractiveSurfaceAction: (actionId, surface, request) => this.performInteractiveSurfaceAction(actionId, surface, request),
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.context.queueSurfaceReplyFromBinding(binding, input),
    };
  }

  buildGenericWebhookAdapterContext(): GenericWebhookAdapterContext {
    return {
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      authorizeSurfaceIngress: (input) => this.authorizeSurfaceIngress(input),
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
      surfaceDeliveryEnabled: (surface) => this.context.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.context.signWebhookPayload(body, secret),
      queueWebhookReply: (input) => this.context.queueWebhookReply(input),
    };
  }

  async authorizeSurfaceIngress(input: ChannelIngressPolicyInput): Promise<ChannelPolicyDecision> {
    return this.context.channelPolicy.evaluateIngress(input);
  }

  parseSurfaceControlCommand(text: string): { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string } | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^(status|cancel|retry)\s+([a-z0-9:_-]+)/i);
    if (!match) return null;
    return {
      action: match[1]!.toLowerCase() as 'status' | 'cancel' | 'retry',
      id: match[2]!,
    };
  }

  async performSurfaceControlCommand(
    command: { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string },
  ): Promise<string> {
    if (command.action === 'status') {
      const run = this.context.automationManager.getRun(command.id);
      if (run) {
        return `Run ${run.id}: ${run.status}${run.agentId ? ` agent=${run.agentId}` : ''}`;
      }
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        return `Agent ${agent.id}: ${agent.status}${agent.progress ? ` (${agent.progress})` : ''}`;
      }
      const session = this.context.sessionBroker.getSession(command.id);
      if (session) {
        return `Session ${session.id}: ${session.status} messages=${session.messageCount}${session.activeAgentId ? ` activeAgent=${session.activeAgentId}` : ''}`;
      }
      return `Unknown run, agent, or session: ${command.id}`;
    }

    if (command.action === 'cancel') {
      const run = await this.context.automationManager.cancelRun(command.id, 'surface-cancelled');
      if (run) {
        return `Cancelled run ${run.id}`;
      }
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        this.context.agentManager.cancel(command.id);
        return `Cancelled agent ${command.id}`;
      }
      return `Unknown run or agent: ${command.id}`;
    }

    try {
      const run = await this.context.automationManager.retryRun(command.id);
      return `Retried run ${run.id}`;
    } catch {
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        const retried = this.context.trySpawnAgent({
          mode: 'spawn',
          task: agent.task,
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.provider ? { provider: agent.provider } : {}),
          ...(agent.tools.length > 0 ? { tools: agent.tools } : {}),
        }, 'DaemonSurfaceActionHelper.performSurfaceControlCommand');
        if (!(retried instanceof Response)) {
          return `Retried agent ${command.id} as ${retried.id}`;
        }
      }
      return `Unable to retry ${command.id}`;
    }
  }

  async performInteractiveSurfaceAction(
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
  ): Promise<string> {
    const approvalMatch = actionId.match(/^gv:approval:(approve|deny|claim):(.+)$/);
    if (approvalMatch) {
      const [, action, approvalId] = approvalMatch;
      const result = await this.context.handleApprovalAction(
        approvalId,
        action as 'approve' | 'deny' | 'claim',
        new Request(req.url, {
          method: 'POST',
          headers: req.headers,
        }),
      );
      const body = await result.json().catch(() => ({} as Record<string, unknown>));
      return result.ok
        ? `Approval ${action}d: ${approvalId}`
        : String((body as Record<string, unknown>).error ?? `Failed to ${action} approval ${approvalId}`);
    }
    const runMatch = actionId.match(/^gv:run:(cancel|retry):(.+)$/);
    if (runMatch) {
      const [, action, runId] = runMatch;
      if (action === 'cancel') {
        const run = await this.context.automationManager.cancelRun(runId, 'interactive-surface-cancel');
        return run ? `Cancelled run ${runId}` : `Failed to cancel run ${runId}`;
      }
      try {
        await this.context.automationManager.retryRun(runId);
        return `Retried run ${runId}`;
      } catch (error) {
        return error instanceof Error ? error.message : `Failed to retry run ${runId}`;
      }
    }
    return `No handler for ${surface} action ${actionId}`;
  }
}
