import type { AutomationRouteBinding } from '../automation/routes.ts';
import {
  type GenericWebhookAdapterContext,
  type SurfaceAdapterContext,
  handleDiscordSurfaceWebhook,
  handleGenericWebhookSurface,
  handleNtfySurfaceWebhook,
  handleSlackSurfaceWebhook,
} from '../adapters/index.ts';
import type { SharedApprovalRecord } from '../control-plane/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import type { ServiceSecretField } from '../config/service-registry.ts';
import { getSecretsManager } from '../config/secrets.ts';
import { DiscordIntegration, NtfyIntegration, SlackIntegration } from '../integrations/index.ts';
import type { Tool } from '../types/tools.ts';
import type { ChannelPlugin, ChannelPluginRegistry } from './plugin-registry.ts';
import type { ChannelProviderRuntimeManager, ProviderRuntimeSurface } from './provider-runtime.ts';
import type { RouteBindingManager } from './route-manager.ts';
import type {
  ChannelAccountAction,
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelAccountRecord,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapability,
  ChannelCapabilityDescriptor,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelDirectoryScope,
  ChannelOperatorActionDescriptor,
  ChannelResolvedTarget,
  ChannelSecretStatus,
  ChannelSurface,
  ChannelTargetResolveOptions,
  ChannelToolDescriptor,
} from './types.ts';

type ManagedSurface = 'slack' | 'discord' | 'ntfy' | 'webhook';

interface BuiltinChannelRuntimeDeps {
  readonly configManager: ConfigManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly providerRuntime?: ChannelProviderRuntimeManager;
  readonly surfaceDeliveryEnabled: (surface: ManagedSurface) => boolean;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  readonly deliverSurfaceProgress: (pending: unknown, progress: string) => Promise<void>;
  readonly deliverSlackAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverDiscordAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverNtfyAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverWebhookAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverSlackApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverDiscordApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverNtfyApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverWebhookApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
}

export class BuiltinChannelRuntime {
  constructor(private readonly deps: BuiltinChannelRuntimeDeps) {}

  registerPlugins(): void {
    this.deps.channelPlugins.register({
      id: 'surface:tui',
      surface: 'tui',
      displayName: 'Terminal UI',
      capabilities: ['ingress', 'egress', 'session_binding', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      getStatus: async () => ({
        id: 'surface:tui',
        surface: 'tui',
        label: 'Terminal UI',
        state: 'healthy',
        enabled: true,
        metadata: {},
      }),
      listAccounts: async () => [await this.buildAccount('tui')],
      getAccount: async (accountId) => this.resolveAccount('tui', accountId),
      listCapabilities: async () => this.listCapabilities('tui'),
      listTools: async () => this.listTools('tui'),
      runTool: (toolId, input) => this.runTool('tui', toolId, input),
      listOperatorActions: async () => this.listOperatorActions('tui'),
      runOperatorAction: (actionId, input) => this.runOperatorAction('tui', actionId, input),
      ...this.buildProductHooks('tui'),
      lookupDirectory: async (query) => query.trim()
        ? [{ id: 'surface:tui', surface: 'tui', kind: 'service', label: 'Terminal UI', metadata: {} }]
        : [],
    });

    this.deps.channelPlugins.register({
      id: 'surface:web',
      surface: 'web',
      displayName: 'Web control plane',
      capabilities: ['ingress', 'egress', 'threaded_reply', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      getStatus: async () => ({
        id: 'surface:web',
        surface: 'web',
        label: 'Web control plane',
        state: this.deps.configManager.get('web.enabled') || this.deps.configManager.get('controlPlane.enabled') ? 'healthy' : 'disabled',
        enabled: Boolean(this.deps.configManager.get('web.enabled') || this.deps.configManager.get('controlPlane.enabled')),
        metadata: {
          baseUrl: this.deps.configManager.get('web.publicBaseUrl'),
        },
      }),
      listAccounts: async () => [await this.buildAccount('web')],
      getAccount: async (accountId) => this.resolveAccount('web', accountId),
      listCapabilities: async () => this.listCapabilities('web'),
      listTools: async () => this.listTools('web'),
      runTool: (toolId, input) => this.runTool('web', toolId, input),
      listOperatorActions: async () => this.listOperatorActions('web'),
      runOperatorAction: (actionId, input) => this.runOperatorAction('web', actionId, input),
      ...this.buildProductHooks('web'),
      lookupDirectory: async () => [{ id: 'surface:web', surface: 'web', kind: 'service', label: 'Web control plane', metadata: {} }],
    });

    this.deps.channelPlugins.register({
      id: 'surface:slack',
      surface: 'slack',
      displayName: 'Slack',
      capabilities: ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      webhookPath: '/webhook/slack',
      handleInbound: (req) => handleSlackSurfaceWebhook(req, this.deps.buildSurfaceAdapterContext()),
      deliverReply: (pending, message) => this.deps.deliverSlackAgentReply(pending, message),
      deliverProgress: (pending, progress) => this.deps.deliverSurfaceProgress(pending, progress),
      notifyApproval: (approval, binding) => this.deps.deliverSlackApprovalUpdate(approval, binding),
      getStatus: async () => ({
        id: 'surface:slack',
        surface: 'slack',
        label: 'Slack',
        state: this.deps.surfaceDeliveryEnabled('slack') ? 'healthy' : 'disabled',
        enabled: this.deps.surfaceDeliveryEnabled('slack'),
        accountId: String(this.deps.configManager.get('surfaces.slack.workspaceId') || ''),
        metadata: {
          defaultChannel: this.deps.configManager.get('surfaces.slack.defaultChannel'),
          providerRuntime: this.providerRuntimeStatus('slack'),
        },
      }),
      listAccounts: async () => [await this.buildAccount('slack')],
      getAccount: async (accountId) => this.resolveAccount('slack', accountId),
      listCapabilities: async () => this.listCapabilities('slack'),
      listTools: async () => this.listTools('slack'),
      runTool: (toolId, input) => this.runTool('slack', toolId, input),
      listOperatorActions: async () => this.listOperatorActions('slack'),
      runOperatorAction: (actionId, input) => this.runOperatorAction('slack', actionId, input),
      ...this.buildProductHooks('slack'),
      lookupDirectory: async (query, options) => this.lookupDirectory('slack', query, options),
    });

    this.deps.channelPlugins.register({
      id: 'surface:discord',
      surface: 'discord',
      displayName: 'Discord',
      capabilities: ['ingress', 'egress', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      webhookPath: '/webhook/discord',
      handleInbound: (req) => handleDiscordSurfaceWebhook(req, this.deps.buildSurfaceAdapterContext()),
      deliverReply: (pending, message) => this.deps.deliverDiscordAgentReply(pending, message),
      deliverProgress: (pending, progress) => this.deps.deliverSurfaceProgress(pending, progress),
      notifyApproval: (approval, binding) => this.deps.deliverDiscordApprovalUpdate(approval, binding),
      getStatus: async () => ({
        id: 'surface:discord',
        surface: 'discord',
        label: 'Discord',
        state: this.deps.surfaceDeliveryEnabled('discord') ? 'healthy' : 'disabled',
        enabled: this.deps.surfaceDeliveryEnabled('discord'),
        accountId: String(this.deps.configManager.get('surfaces.discord.applicationId') || ''),
        metadata: {
          defaultChannelId: this.deps.configManager.get('surfaces.discord.defaultChannelId'),
          providerRuntime: this.providerRuntimeStatus('discord'),
        },
      }),
      listAccounts: async () => [await this.buildAccount('discord')],
      getAccount: async (accountId) => this.resolveAccount('discord', accountId),
      listCapabilities: async () => this.listCapabilities('discord'),
      listTools: async () => this.listTools('discord'),
      runTool: (toolId, input) => this.runTool('discord', toolId, input),
      listOperatorActions: async () => this.listOperatorActions('discord'),
      runOperatorAction: (actionId, input) => this.runOperatorAction('discord', actionId, input),
      ...this.buildProductHooks('discord'),
      lookupDirectory: async (query, options) => this.lookupDirectory('discord', query, options),
    });

    this.deps.channelPlugins.register({
      id: 'surface:ntfy',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['ingress', 'egress', 'delivery_only', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      webhookPath: '/webhook/ntfy',
      handleInbound: (req) => handleNtfySurfaceWebhook(req, this.deps.buildSurfaceAdapterContext()),
      deliverReply: (pending, message) => this.deps.deliverNtfyAgentReply(pending, message),
      notifyApproval: (approval, binding) => this.deps.deliverNtfyApprovalUpdate(approval, binding),
      getStatus: async () => ({
        id: 'surface:ntfy',
        surface: 'ntfy',
        label: 'ntfy',
        state: this.deps.surfaceDeliveryEnabled('ntfy') ? 'healthy' : 'disabled',
        enabled: this.deps.surfaceDeliveryEnabled('ntfy'),
        metadata: {
          topic: this.deps.configManager.get('surfaces.ntfy.topic'),
          baseUrl: this.deps.configManager.get('surfaces.ntfy.baseUrl'),
          providerRuntime: this.providerRuntimeStatus('ntfy'),
        },
      }),
      listAccounts: async () => [await this.buildAccount('ntfy')],
      getAccount: async (accountId) => this.resolveAccount('ntfy', accountId),
      listCapabilities: async () => this.listCapabilities('ntfy'),
      listTools: async () => this.listTools('ntfy'),
      runTool: (toolId, input) => this.runTool('ntfy', toolId, input),
      listOperatorActions: async () => this.listOperatorActions('ntfy'),
      runOperatorAction: (actionId, input) => this.runOperatorAction('ntfy', actionId, input),
      ...this.buildProductHooks('ntfy'),
      lookupDirectory: async (query, options) => this.lookupDirectory('ntfy', query, options),
    });

    this.deps.channelPlugins.register({
      id: 'surface:webhook',
      surface: 'webhook',
      displayName: 'Generic webhook',
      capabilities: ['ingress', 'egress', 'delivery_only', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      webhookPath: '/webhook/generic',
      handleInbound: (req) => handleGenericWebhookSurface(req, this.deps.buildGenericWebhookAdapterContext()),
      deliverReply: (pending, message) => this.deps.deliverWebhookAgentReply(pending, message),
      notifyApproval: (approval, binding) => this.deps.deliverWebhookApprovalUpdate(approval, binding),
      getStatus: async () => ({
        id: 'surface:webhook',
        surface: 'webhook',
        label: 'Generic webhook',
        state: this.deps.surfaceDeliveryEnabled('webhook') ? 'healthy' : 'disabled',
        enabled: this.deps.surfaceDeliveryEnabled('webhook'),
        metadata: {
          defaultTarget: this.deps.configManager.get('surfaces.webhook.defaultTarget'),
        },
      }),
      listAccounts: async () => [await this.buildAccount('webhook')],
      getAccount: async (accountId) => this.resolveAccount('webhook', accountId),
      listCapabilities: async () => this.listCapabilities('webhook'),
      listTools: async () => this.listTools('webhook'),
      runTool: (toolId, input) => this.runTool('webhook', toolId, input),
      listOperatorActions: async () => this.listOperatorActions('webhook'),
      runOperatorAction: (actionId, input) => this.runOperatorAction('webhook', actionId, input),
      ...this.buildProductHooks('webhook'),
      lookupDirectory: async (query, options) => this.lookupRouteDirectory('webhook', query, options),
    });
  }

  async buildAccount(surface: ChannelSurface): Promise<ChannelAccountRecord> {
    switch (surface) {
      case 'tui':
        return this.finalizeChannelAccount({
          surface,
          label: 'Terminal UI',
          enabled: true,
          accountId: 'surface:tui',
          secrets: [],
          metadata: { managed: 'local' },
        });
      case 'web':
        return this.finalizeChannelAccount({
          surface,
          label: 'Web control plane',
          enabled: Boolean(this.deps.configManager.get('web.enabled') || this.deps.configManager.get('controlPlane.enabled')),
          accountId: 'surface:web',
          secrets: [],
          metadata: {
            baseUrl: this.deps.configManager.get('web.publicBaseUrl'),
            port: this.deps.configManager.get('web.port'),
          },
        });
      case 'slack': {
        const workspaceId = String(this.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined;
        const secrets = await Promise.all([
          this.describeSecret('primary', 'Bot token', this.deps.configManager.get('surfaces.slack.botToken'), ['SLACK_BOT_TOKEN'], 'slack', 'primary'),
          this.describeSecret('signingSecret', 'Signing secret', this.deps.configManager.get('surfaces.slack.signingSecret'), ['SLACK_SIGNING_SECRET'], 'slack', 'signingSecret'),
          this.describeSecret('appToken', 'App token', this.deps.configManager.get('surfaces.slack.appToken'), ['SLACK_APP_TOKEN']),
          this.describeSecret('webhookUrl', 'Webhook URL', undefined, ['SLACK_WEBHOOK_URL'], 'slack', 'webhookUrl'),
        ]);
        return this.finalizeChannelAccount({
          surface,
          label: 'Slack',
          enabled: this.deps.surfaceDeliveryEnabled('slack'),
          accountId: workspaceId ?? 'surface:slack',
          workspaceId,
          secrets,
          metadata: {
            defaultChannel: this.deps.configManager.get('surfaces.slack.defaultChannel'),
            providerRuntime: this.providerRuntimeStatus('slack'),
          },
        });
      }
      case 'discord': {
        const applicationId = String(this.deps.configManager.get('surfaces.discord.applicationId') || '') || undefined;
        const secrets = await Promise.all([
          this.describeSecret('primary', 'Bot token', this.deps.configManager.get('surfaces.discord.botToken'), ['DISCORD_BOT_TOKEN'], 'discord', 'primary'),
          this.describeSecret('publicKey', 'Public key', this.deps.configManager.get('surfaces.discord.publicKey'), ['DISCORD_PUBLIC_KEY'], 'discord', 'publicKey'),
          this.describeSecret('webhookUrl', 'Webhook URL', undefined, ['DISCORD_WEBHOOK_URL'], 'discord', 'webhookUrl'),
        ]);
        return this.finalizeChannelAccount({
          surface,
          label: 'Discord',
          enabled: this.deps.surfaceDeliveryEnabled('discord'),
          accountId: applicationId ?? 'surface:discord',
          workspaceId: String(this.deps.configManager.get('surfaces.discord.guildId') || '') || undefined,
          secrets,
          metadata: {
            applicationId,
            defaultChannelId: this.deps.configManager.get('surfaces.discord.defaultChannelId'),
            providerRuntime: this.providerRuntimeStatus('discord'),
          },
        });
      }
      case 'ntfy': {
        const secrets = await Promise.all([
          this.describeSecret('primary', 'Access token', undefined, ['NTFY_ACCESS_TOKEN'], 'ntfy', 'primary'),
        ]);
        return this.finalizeChannelAccount({
          surface,
          label: 'ntfy',
          enabled: this.deps.surfaceDeliveryEnabled('ntfy'),
          accountId: String(this.deps.configManager.get('surfaces.ntfy.topic') || '') || 'surface:ntfy',
          secrets,
          metadata: {
            baseUrl: this.deps.configManager.get('surfaces.ntfy.baseUrl'),
            topic: this.deps.configManager.get('surfaces.ntfy.topic'),
            providerRuntime: this.providerRuntimeStatus('ntfy'),
          },
        });
      }
      case 'webhook': {
        const secrets = await Promise.all([
          this.describeSecret('secret', 'Shared secret', this.deps.configManager.get('surfaces.webhook.secret')),
          this.describeSecret('defaultTarget', 'Default target', this.deps.configManager.get('surfaces.webhook.defaultTarget')),
        ]);
        return this.finalizeChannelAccount({
          surface,
          label: 'Generic webhook',
          enabled: this.deps.surfaceDeliveryEnabled('webhook'),
          accountId: 'surface:webhook',
          secrets,
          metadata: {
            defaultTarget: this.deps.configManager.get('surfaces.webhook.defaultTarget'),
            timeoutMs: this.deps.configManager.get('surfaces.webhook.timeoutMs'),
          },
        });
      }
    }
  }

  async resolveAccount(surface: ChannelSurface, accountId: string): Promise<ChannelAccountRecord | null> {
    const record = await this.buildAccount(surface);
    return record.id === accountId || record.accountId === accountId || record.workspaceId === accountId
      ? record
      : null;
  }

  async listCapabilities(surface: ChannelSurface): Promise<ChannelCapabilityDescriptor[]> {
    const account = await this.buildAccount(surface);
    const plugin = this.deps.channelPlugins.getBySurface(surface);
    const rawCapabilities = plugin?.capabilities ?? [];
    const supports = (capability: ChannelCapability): boolean => rawCapabilities.includes(capability);
    return [
      {
        id: 'ingress',
        surface,
        label: 'Inbound messages',
        scope: 'surface',
        supported: supports('ingress'),
        detail: supports('ingress') ? 'Surface can accept inbound traffic into the runtime.' : 'Inbound traffic is not supported.',
        metadata: {},
      },
      {
        id: 'egress',
        surface,
        label: 'Outbound delivery',
        scope: 'delivery',
        supported: supports('egress'),
        detail: supports('egress') ? 'Surface can deliver replies and automation output.' : 'Outbound delivery is not supported.',
        metadata: {},
      },
      {
        id: 'threaded_reply',
        surface,
        label: 'Thread-aware replies',
        scope: 'interaction',
        supported: supports('threaded_reply'),
        detail: supports('threaded_reply') ? 'Replies can preserve thread context.' : 'Replies are not thread-aware.',
        metadata: {},
      },
      {
        id: 'interactive_actions',
        surface,
        label: 'Interactive actions',
        scope: 'interaction',
        supported: supports('interactive_actions'),
        detail: supports('interactive_actions') ? 'Surface supports button or interaction callbacks.' : 'Interactive callbacks are not available.',
        metadata: {},
      },
      {
        id: 'session_binding',
        surface,
        label: 'Session binding',
        scope: 'surface',
        supported: supports('session_binding'),
        detail: supports('session_binding') ? 'Routes can be bound to shared runtime sessions.' : 'Session binding is not supported on this surface.',
        metadata: {},
      },
      {
        id: 'account_posture',
        surface,
        label: 'Account posture',
        scope: 'accounts',
        supported: true,
        detail: `Account state: ${account.state}; auth posture: ${account.authState}.`,
        metadata: {
          accountId: account.accountId,
          configured: account.configured,
          linked: account.linked,
        },
      },
      {
        id: 'directory',
        surface,
        label: 'Directory lookup',
        scope: 'directory',
        supported: true,
        detail: 'Directory and group/member projections are available through the channel runtime.',
        metadata: {},
      },
      {
        id: 'tooling',
        surface,
        label: 'Channel tool bridge',
        scope: 'tooling',
        supported: true,
        detail: 'Channel-owned tools and operator actions can be executed through the shared channel tool bridge.',
        metadata: {},
      },
      {
        id: 'account_lifecycle',
        surface,
        label: 'Account lifecycle',
        scope: 'accounts',
        supported: supports('account_lifecycle'),
        detail: supports('account_lifecycle')
          ? 'Surface exposes account lifecycle commands through the channel runtime.'
          : 'Account lifecycle commands are not available.',
        metadata: {},
      },
      {
        id: 'target_resolution',
        surface,
        label: 'Target resolution',
        scope: 'directory',
        supported: supports('target_resolution'),
        detail: supports('target_resolution')
          ? 'Surface can resolve channel-specific target inputs into structured destinations.'
          : 'Target resolution is not available.',
        metadata: {},
      },
      {
        id: 'agent_tools',
        surface,
        label: 'Direct agent tools',
        scope: 'tooling',
        supported: supports('agent_tools'),
        detail: supports('agent_tools')
          ? 'Surface contributes direct tool entries to agent runtimes when the channel registry is active.'
          : 'Direct channel-owned agent tools are not available.',
        metadata: {},
      },
    ];
  }

  listOperatorActions(surface: ChannelSurface): ChannelOperatorActionDescriptor[] {
    return [
      {
        id: 'inspect-account',
        surface,
        label: 'Inspect account',
        description: 'Return the current channel-account posture and safe secret-source summary.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
          },
        },
        metadata: {},
      },
      {
        id: 'inspect-status',
        surface,
        label: 'Inspect status',
        description: 'Return the current surface status snapshot.',
        dangerous: false,
        metadata: {},
      },
      {
        id: 'list-directory',
        surface,
        label: 'List directory',
        description: 'Search or scope the route-backed channel directory.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: { type: 'string' },
            groupId: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        metadata: {},
      },
      {
        id: 'list-capabilities',
        surface,
        label: 'List capabilities',
        description: 'Return the current channel capability descriptors.',
        dangerous: false,
        metadata: {},
      },
      {
        id: 'account-action',
        surface,
        label: 'Run account lifecycle action',
        description: 'Execute a safe channel-account lifecycle action such as inspect, retest, start, stop, login, or logout.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            action: { type: 'string' },
          },
          required: ['action'],
        },
        metadata: {},
      },
      {
        id: 'resolve-target',
        surface,
        label: 'Resolve target',
        description: 'Resolve a channel-specific target like #channel, @user, a thread id, or a route-backed destination.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            input: { type: 'string' },
            preferredKind: { type: 'string' },
            threadId: { type: 'string' },
            accountId: { type: 'string' },
            createIfMissing: { type: 'boolean' },
            live: { type: 'boolean' },
          },
        },
        metadata: {},
      },
      {
        id: 'authorize-actor-action',
        surface,
        label: 'Authorize actor action',
        description: 'Check whether a channel actor can run a channel action against an account or target.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            actorId: { type: 'string' },
            actionId: { type: 'string' },
            accountId: { type: 'string' },
            target: { type: 'string' },
          },
          required: ['actionId'],
        },
        metadata: {},
      },
      {
        id: 'provider-api',
        surface,
        label: 'Run provider-native API operation',
        description: 'Run provider-native operations such as OAuth URL generation, live directory lookup, Discord command registration, or ntfy polling.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            query: { type: 'string' },
            scope: { type: 'string' },
            limit: { type: 'number' },
            clientId: { type: 'string' },
            redirectUri: { type: 'string' },
            guildId: { type: 'string' },
            topic: { type: 'string' },
            since: { type: 'string' },
          },
          required: ['operation'],
          additionalProperties: true,
        },
        metadata: {},
      },
    ];
  }

  listTools(surface: ChannelSurface): ChannelToolDescriptor[] {
    return [
      {
        id: `${surface}:account`,
        surface,
        name: `${surface}_account`,
        description: `Inspect account posture for the ${surface} surface.`,
        actionIds: ['inspect-account'],
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
          },
          additionalProperties: false,
        },
        metadata: {},
      },
      {
        id: `${surface}:status`,
        surface,
        name: `${surface}_status`,
        description: `Inspect status for the ${surface} surface.`,
        actionIds: ['inspect-status'],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
        metadata: {},
      },
      {
        id: `${surface}:directory`,
        surface,
        name: `${surface}_directory`,
        description: `Query the ${surface} channel directory and group membership view.`,
        actionIds: ['list-directory'],
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: { type: 'string' },
            groupId: { type: 'string' },
            limit: { type: 'number' },
          },
          additionalProperties: false,
        },
        metadata: {},
      },
      {
        id: `${surface}:capabilities`,
        surface,
        name: `${surface}_capabilities`,
        description: `List capability descriptors for the ${surface} surface.`,
        actionIds: ['list-capabilities'],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
        metadata: {},
      },
      {
        id: `${surface}:account_action`,
        surface,
        name: `${surface}_account_action`,
        description: `Run a safe account lifecycle action for the ${surface} surface.`,
        actionIds: ['account-action'],
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            action: { type: 'string' },
          },
          required: ['action'],
          additionalProperties: true,
        },
        metadata: {},
      },
      {
        id: `${surface}:target`,
        surface,
        name: `${surface}_target`,
        description: `Resolve a ${surface} target into a structured channel destination.`,
        actionIds: ['resolve-target'],
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            input: { type: 'string' },
            preferredKind: { type: 'string' },
            threadId: { type: 'string' },
            accountId: { type: 'string' },
            createIfMissing: { type: 'boolean' },
            live: { type: 'boolean' },
          },
          required: ['target'],
          additionalProperties: false,
        },
        metadata: {},
      },
      {
        id: `${surface}:authorize`,
        surface,
        name: `${surface}_authorize`,
        description: `Check whether a channel actor can run an action on the ${surface} surface.`,
        actionIds: ['authorize-actor-action'],
        inputSchema: {
          type: 'object',
          properties: {
            actorId: { type: 'string' },
            actionId: { type: 'string' },
            accountId: { type: 'string' },
            target: { type: 'string' },
          },
          required: ['actionId'],
          additionalProperties: true,
        },
        metadata: {},
      },
      {
        id: `${surface}:provider`,
        surface,
        name: `${surface}_provider`,
        description: `Run provider-native operations for the ${surface} surface.`,
        actionIds: ['provider-api'],
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            query: { type: 'string' },
            scope: { type: 'string' },
            limit: { type: 'number' },
            clientId: { type: 'string' },
            redirectUri: { type: 'string' },
            guildId: { type: 'string' },
            topic: { type: 'string' },
            since: { type: 'string' },
          },
          required: ['operation'],
          additionalProperties: true,
        },
        metadata: {},
      },
    ];
  }

  async runTool(surface: ChannelSurface, toolId: string, input?: Record<string, unknown>): Promise<unknown> {
    const tool = this.listTools(surface).find((entry) => entry.id === toolId || entry.name === toolId);
    if (!tool) return null;
    const actionId = tool.actionIds[0];
    if (!actionId) return null;
    return this.runOperatorAction(surface, actionId, input);
  }

  async runOperatorAction(
    surface: ChannelSurface,
    actionId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown> {
    if (actionId === 'inspect-account') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      if (accountId) {
        return this.resolveAccount(surface, accountId);
      }
      return this.buildAccount(surface);
    }
    if (actionId === 'inspect-status') {
      return this.deps.channelPlugins.listStatus().then((entries) => entries.find((entry) => entry.surface === surface) ?? null);
    }
    if (actionId === 'list-directory') {
      return this.deps.channelPlugins.queryDirectory(surface, {
        query: typeof input?.query === 'string' ? input.query : undefined,
        scope: typeof input?.scope === 'string' ? input.scope as ChannelDirectoryScope : undefined,
        groupId: typeof input?.groupId === 'string' ? input.groupId : undefined,
        limit: typeof input?.limit === 'number' ? input.limit : undefined,
      });
    }
    if (actionId === 'list-capabilities') {
      return this.listCapabilities(surface);
    }
    if (actionId === 'account-action') {
      const action = this.readLifecycleAction(input?.action ?? input?.accountAction);
      if (!action) {
        return {
          surface,
          ok: false,
          error: 'account-action requires a valid lifecycle action.',
        };
      }
      return this.runAccountAction(
        surface,
        action,
        typeof input?.accountId === 'string' ? input.accountId : undefined,
        input,
      );
    }
    if (actionId === 'resolve-target') {
      const targetInput = typeof input?.target === 'string'
        ? input.target
        : typeof input?.input === 'string'
          ? input.input
          : typeof input?.query === 'string'
            ? input.query
            : '';
      if (targetInput.trim().length === 0) {
        return {
          surface,
          ok: false,
          error: 'resolve-target requires "target" or "input".',
        };
      }
      return this.resolveTarget(surface, {
        input: targetInput,
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
        ...(this.readConversationKind(input?.preferredKind) ? { preferredKind: this.readConversationKind(input?.preferredKind)! } : {}),
        ...(typeof input?.threadId === 'string' ? { threadId: input.threadId } : {}),
        ...(typeof input?.createIfMissing === 'boolean' ? { createIfMissing: input.createIfMissing } : {}),
        ...(typeof input?.live === 'boolean' ? { live: input.live } : {}),
      });
    }
    if (actionId === 'authorize-actor-action') {
      const targetInput = typeof input?.target === 'string' ? input.target : undefined;
      const target = targetInput
        ? await this.resolveTarget(surface, {
            input: targetInput,
            ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
            createIfMissing: true,
          })
        : undefined;
      return this.authorizeActorAction(surface, {
        actionId: typeof input?.actionId === 'string' ? input.actionId : 'unknown',
        ...(typeof input?.actorId === 'string' ? { actorId: input.actorId } : {}),
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
        ...(target ? { target } : {}),
        metadata: {},
      });
    }
    if (actionId === 'provider-api') {
      return this.runProviderApi(surface, input);
    }
    return null;
  }

  private buildProductHooks(surface: ChannelSurface): Pick<
    ChannelPlugin,
    | 'runAccountAction'
    | 'authorizeActorAction'
    | 'parseExplicitTarget'
    | 'inferTargetConversationKind'
    | 'resolveTarget'
    | 'resolveSessionTarget'
    | 'resolveParentConversationCandidates'
    | 'listAgentTools'
  > {
    return {
      runAccountAction: (action, accountId, input) => this.runAccountAction(surface, action, accountId, input),
      authorizeActorAction: (request) => this.authorizeActorAction(surface, request),
      parseExplicitTarget: (input, options) => this.parseExplicitTarget(surface, input, options),
      inferTargetConversationKind: (input, options) => this.inferTargetConversationKind(input, options),
      resolveTarget: (options) => this.resolveTarget(surface, options),
      resolveSessionTarget: (target) => this.resolveSessionTarget(target),
      resolveParentConversationCandidates: (options) => this.resolveParentConversationCandidates(surface, options),
      listAgentTools: () => this.listAgentTools(surface),
    };
  }

  private listAgentTools(surface: ChannelSurface): readonly Tool[] {
    return this.listTools(surface).map((descriptor): Tool => ({
      definition: {
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema ?? {
          type: 'object',
          additionalProperties: true,
        },
        sideEffects: ['network', 'state'],
        concurrency: 'serial',
      },
      execute: async (args) => {
        const result = await this.runTool(surface, descriptor.id, args);
        if (result === null) {
          return {
            success: false,
            error: `Unknown channel tool '${descriptor.id}' for surface '${surface}'.`,
          };
        }
        return {
          success: true,
          output: JSON.stringify({ surface, toolId: descriptor.id, result }, null, 2),
        };
      },
    }));
  }

  private async runAccountAction(
    surface: ChannelSurface,
    action: ChannelAccountLifecycleAction,
    accountId?: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult> {
    const account = accountId ? await this.resolveAccount(surface, accountId) : await this.buildAccount(surface);
    const resultAccountId = accountId ?? account?.accountId ?? account?.id;
    const base = {
      surface,
      ...(resultAccountId ? { accountId: resultAccountId } : {}),
      action,
      ...(account ? { state: account.state, authState: account.authState } : {}),
      account,
    };
    if (!account) {
      return {
        ...base,
        ok: false,
        message: 'No matching channel account was found.',
        metadata: { requestedAccountId: accountId ?? null },
      };
    }
    const providerSurface = this.asProviderRuntimeSurface(surface);

    switch (action) {
      case 'inspect':
        return {
          ...base,
          ok: true,
          message: 'Account posture inspected.',
          metadata: {},
        };
      case 'retest':
        return {
          ...base,
          ok: account.configured,
          message: account.configured
            ? 'Account configuration is present; secret values remain hidden.'
            : 'Account is not configured.',
          metadata: { configured: account.configured, linked: account.linked },
        };
      case 'setup':
        if (providerSurface) {
          return this.runProviderSetupAction(providerSurface, action, base, account, input);
        }
        return {
          ...base,
          ok: account.configured,
          login: account.configured
            ? { kind: 'none' }
            : {
                kind: 'manual',
                instructions: 'Configure this built-in surface through GoodVibes config or the service registry.',
              },
          message: account.configured
            ? 'Account is already configured.'
            : 'This built-in surface is config-backed; interactive setup is not available for it.',
          metadata: { configBacked: true },
        };
      case 'connect':
      case 'login':
        if (providerSurface) {
          return this.runProviderSetupAction(providerSurface, action, base, account, input);
        }
        return {
          ...base,
          ok: account.linked,
          login: account.linked
            ? { kind: 'none' }
            : {
                kind: 'manual',
                instructions: 'Add the required credential sources in GoodVibes config, environment, or service registry.',
              },
          message: account.linked
            ? 'Account is already linked.'
            : 'No mutable OAuth/QR login flow is available for this config-backed built-in surface.',
          metadata: { configBacked: true },
        };
      case 'wait_login':
        return {
          ...base,
          ok: false,
          login: { kind: 'none' },
          message: 'No interactive login is pending for this built-in surface.',
          metadata: { pending: false },
        };
      case 'start':
        if (providerSurface && this.deps.providerRuntime) {
          const runtimeResult = await this.deps.providerRuntime.start(providerSurface);
          const refreshed = await this.buildAccount(surface);
          return {
            ...base,
            ok: runtimeResult.ok,
            account: refreshed,
            state: refreshed.state,
            authState: refreshed.authState,
            message: runtimeResult.message,
            metadata: { providerRuntime: runtimeResult.status },
          };
        }
        return {
          ...base,
          ok: account.enabled,
          message: account.enabled
            ? 'Surface is enabled in the current daemon runtime.'
            : 'Surface is disabled; enable it in config before starting delivery.',
          metadata: { enabled: account.enabled },
        };
      case 'stop':
        if (providerSurface && this.deps.providerRuntime) {
          const runtimeResult = this.deps.providerRuntime.stop(providerSurface);
          const refreshed = await this.buildAccount(surface);
          return {
            ...base,
            ok: runtimeResult.ok,
            account: refreshed,
            state: refreshed.state,
            authState: refreshed.authState,
            message: runtimeResult.message,
            metadata: { providerRuntime: runtimeResult.status },
          };
        }
        return {
          ...base,
          ok: !account.enabled,
          message: account.enabled
            ? 'Stopping this built-in surface is daemon/config owned; disable it in config or stop the daemon.'
            : 'Surface is already disabled.',
          metadata: { enabled: account.enabled, configBacked: true },
        };
      case 'disconnect':
      case 'logout':
        if (providerSurface) {
          return this.runProviderLogoutAction(providerSurface, action, base, account, input);
        }
        return {
          ...base,
          ok: !account.linked,
          message: account.linked
            ? 'This built-in surface is config-backed; credentials were not removed by the runtime.'
            : 'Account is already unlinked.',
          metadata: { configBacked: true, linked: account.linked },
        };
    }
  }

  private async runProviderSetupAction(
    surface: ProviderRuntimeSurface,
    action: ChannelAccountLifecycleAction,
    base: Omit<ChannelAccountLifecycleResult, 'ok' | 'metadata'>,
    account: ChannelAccountRecord,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult> {
    if (surface === 'slack') {
      const clientId = this.readString(input?.clientId) ?? process.env.SLACK_CLIENT_ID;
      const clientSecret = this.readString(input?.clientSecret) ?? process.env.SLACK_CLIENT_SECRET;
      const code = this.readString(input?.code);
      const redirectUri = this.readString(input?.redirectUri);
      if (code && clientId && clientSecret) {
        const exchange = await new SlackIntegration().exchangeOAuthCode({ clientId, clientSecret, code, ...(redirectUri ? { redirectUri } : {}) });
        if (exchange.ok && exchange.access_token) {
          await getSecretsManager().set('SLACK_BOT_TOKEN', exchange.access_token, { scope: this.readSecretScope(input?.secretScope) });
          this.deps.configManager.set('surfaces.slack.enabled', true);
          if (exchange.team?.id) this.deps.configManager.set('surfaces.slack.workspaceId', exchange.team.id);
          const refreshed = await this.buildAccount('slack');
          return {
            ...base,
            ok: true,
            account: refreshed,
            state: refreshed.state,
            authState: refreshed.authState,
            login: { kind: 'none' },
            message: 'Slack OAuth code exchanged and bot token stored in the GoodVibes secret store.',
            metadata: { oauth: true, team: exchange.team ?? null },
          };
        }
        return {
          ...base,
          ok: false,
          login: { kind: 'none' },
          message: `Slack OAuth exchange failed: ${exchange.error ?? 'unknown error'}`,
          metadata: { oauth: true, exchange },
        };
      }
      if (clientId) {
        return {
          ...base,
          ok: true,
          login: {
            kind: 'browser',
            url: SlackIntegration.buildOAuthAuthorizeUrl({
              clientId,
              redirectUri,
              scopes: this.readStringList(input?.scopes) ?? ['commands', 'chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
              state: this.readString(input?.state),
              teamId: this.readString(input?.teamId),
            }),
            instructions: 'Open this Slack install URL, approve the app, then rerun login with the returned code plus clientSecret.',
          },
          message: 'Slack OAuth install URL generated.',
          metadata: { oauth: true, requiresCodeExchange: true },
        };
      }
    }

    if (surface === 'discord') {
      const botToken = this.readString(input?.botToken);
      if (botToken) {
        await getSecretsManager().set('DISCORD_BOT_TOKEN', botToken, { scope: this.readSecretScope(input?.secretScope) });
        this.deps.configManager.set('surfaces.discord.enabled', true);
      }
      const configuredApplicationId = String(this.deps.configManager.get('surfaces.discord.applicationId') || '');
      const applicationId = (this.readString(input?.applicationId) ?? configuredApplicationId) || process.env.DISCORD_APPLICATION_ID;
      const guildId = this.readString(input?.guildId);
      if (this.readString(input?.applicationId)) this.deps.configManager.set('surfaces.discord.applicationId', this.readString(input?.applicationId)!);
      if (guildId) this.deps.configManager.set('surfaces.discord.guildId', guildId);
      if (this.readString(input?.defaultChannelId)) this.deps.configManager.set('surfaces.discord.defaultChannelId', this.readString(input?.defaultChannelId)!);
      const refreshed = await this.buildAccount('discord');
      return {
        ...base,
        ok: Boolean(botToken || applicationId),
        account: refreshed,
        state: refreshed.state,
        authState: refreshed.authState,
        login: applicationId
          ? {
              kind: 'browser',
              url: DiscordIntegration.buildOAuthAuthorizeUrl({
                clientId: applicationId,
                guildId,
                permissions: this.readString(input?.permissions) ?? '2048',
                scopes: this.readStringList(input?.scopes) ?? ['bot', 'applications.commands'],
                disableGuildSelect: typeof input?.disableGuildSelect === 'boolean' ? input.disableGuildSelect : undefined,
                state: this.readString(input?.state),
              }),
              instructions: 'Open this Discord install URL to add the bot and slash commands to a server.',
            }
          : { kind: 'manual', instructions: 'Provide applicationId and botToken to complete Discord setup.' },
        message: botToken ? 'Discord bot token stored in the GoodVibes secret store.' : 'Discord install URL generated.',
        metadata: { oauth: true, applicationId: applicationId ?? null },
      };
    }

    if (surface === 'ntfy') {
      const topic = this.readString(input?.topic);
      const token = this.readString(input?.token);
      const baseUrl = this.readString(input?.baseUrl);
      if (topic) this.deps.configManager.set('surfaces.ntfy.topic', topic);
      if (baseUrl) this.deps.configManager.set('surfaces.ntfy.baseUrl', baseUrl);
      if (token) await getSecretsManager().set('NTFY_ACCESS_TOKEN', token, { scope: this.readSecretScope(input?.secretScope) });
      this.deps.configManager.set('surfaces.ntfy.enabled', true);
      const refreshed = await this.buildAccount('ntfy');
      return {
        ...base,
        ok: Boolean(topic || account.configured),
        account: refreshed,
        state: refreshed.state,
        authState: refreshed.authState,
        login: { kind: 'none' },
        message: token || topic ? 'ntfy configuration stored.' : 'ntfy is config-backed; provide topic and optional token to configure it.',
        metadata: { topic: topic ?? this.deps.configManager.get('surfaces.ntfy.topic') },
      };
    }

    return {
      ...base,
      ok: account.linked,
      login: { kind: 'manual', instructions: 'No provider-native setup flow is available for this surface.' },
      message: `${surface} provider setup is not supported.`,
      metadata: { providerNative: false, action },
    };
  }

  private async runProviderLogoutAction(
    surface: ProviderRuntimeSurface,
    action: ChannelAccountLifecycleAction,
    base: Omit<ChannelAccountLifecycleResult, 'ok' | 'metadata'>,
    account: ChannelAccountRecord,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult> {
    const confirmed = input?.confirm === true || input?.removeSecrets === true;
    if (!confirmed) {
      return {
        ...base,
        ok: false,
        message: 'Credential removal requires confirm:true or removeSecrets:true because environment-backed secrets cannot be restored by GoodVibes.',
        metadata: { requiresConfirmation: true, linked: account.linked },
      };
    }
    if (this.deps.providerRuntime) this.deps.providerRuntime.stop(surface);
    const secrets = getSecretsManager();
    if (surface === 'slack') {
      await secrets.delete('SLACK_BOT_TOKEN');
      await secrets.delete('SLACK_APP_TOKEN');
      this.deps.configManager.set('surfaces.slack.botToken', '');
      this.deps.configManager.set('surfaces.slack.appToken', '');
    } else if (surface === 'discord') {
      await secrets.delete('DISCORD_BOT_TOKEN');
      this.deps.configManager.set('surfaces.discord.botToken', '');
    } else {
      await secrets.delete('NTFY_ACCESS_TOKEN');
      this.deps.configManager.set('surfaces.ntfy.token', '');
    }
    const refreshed = await this.buildAccount(surface);
    return {
      ...base,
      ok: true,
      account: refreshed,
      state: refreshed.state,
      authState: refreshed.authState,
      message: `${surface} GoodVibes-managed credentials removed. Environment variables, if present, still take precedence.`,
      metadata: { action, envBacked: this.providerEnvBacked(surface) },
    };
  }

  private async authorizeActorAction(
    surface: ChannelSurface,
    request: ChannelActorAuthorizationRequest,
  ): Promise<ChannelActorAuthorizationResult> {
    const account = request.accountId ? await this.resolveAccount(surface, request.accountId) : await this.buildAccount(surface);
    const requestedAction = request.actionId.trim().toLowerCase();
    const matchingAction = account?.actions.find((entry) => entry.id === requestedAction || entry.kind === requestedAction);
    const actionAvailable = matchingAction?.available ?? Boolean(account?.configured);
    const allowed = Boolean(account?.enabled && actionAvailable);
    return {
      allowed,
      reason: allowed
        ? 'Account is enabled and the requested action is available.'
        : 'The account is disabled, unconfigured, or the requested action is unavailable.',
      account,
      actionAvailable,
      metadata: {
        actorId: request.actorId ?? null,
        actionId: request.actionId,
        target: request.target?.sessionTarget ?? request.target?.to ?? null,
      },
    };
  }

  private async runProviderApi(surface: ChannelSurface, input?: Record<string, unknown>): Promise<unknown> {
    const operation = this.readString(input?.operation)?.trim().toLowerCase();
    if (!operation) {
      return { surface, ok: false, error: 'provider-api requires operation.' };
    }
    if (operation === 'runtime_status') {
      const providerSurface = this.asProviderRuntimeSurface(surface);
      return providerSurface
        ? { surface, ok: true, status: this.providerRuntimeStatus(providerSurface) }
        : { surface, ok: false, error: 'No provider runtime for this surface.' };
    }
    if (operation === 'runtime_start') {
      const providerSurface = this.asProviderRuntimeSurface(surface);
      return providerSurface && this.deps.providerRuntime
        ? this.deps.providerRuntime.start(providerSurface)
        : { surface, ok: false, error: 'No provider runtime for this surface.' };
    }
    if (operation === 'runtime_stop') {
      const providerSurface = this.asProviderRuntimeSurface(surface);
      return providerSurface && this.deps.providerRuntime
        ? this.deps.providerRuntime.stop(providerSurface)
        : { surface, ok: false, error: 'No provider runtime for this surface.' };
    }
    if (operation === 'live_directory') {
      if (!this.isManagedSurface(surface)) return { surface, ok: false, error: 'Live provider directory is only available for managed external surfaces.' };
      const entries = await this.lookupProviderDirectory(surface, this.readString(input?.query) ?? '', {
        ...(this.readDirectoryScope(input?.scope) ? { scope: this.readDirectoryScope(input?.scope)! } : {}),
        ...(typeof input?.limit === 'number' ? { limit: input.limit } : {}),
        live: true,
      });
      return { surface, ok: true, entries };
    }
    if (operation === 'oauth_url') {
      if (surface === 'slack') {
        const clientId = this.readString(input?.clientId) ?? process.env.SLACK_CLIENT_ID;
        if (!clientId) return { surface, ok: false, error: 'clientId or SLACK_CLIENT_ID is required.' };
        return {
          surface,
          ok: true,
          url: SlackIntegration.buildOAuthAuthorizeUrl({
            clientId,
            redirectUri: this.readString(input?.redirectUri),
            scopes: this.readStringList(input?.scopes) ?? ['commands', 'chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
            state: this.readString(input?.state),
            teamId: this.readString(input?.teamId),
          }),
        };
      }
      if (surface === 'discord') {
        const configuredClientId = String(this.deps.configManager.get('surfaces.discord.applicationId') || '');
        const clientId = (this.readString(input?.clientId) ?? configuredClientId) || process.env.DISCORD_APPLICATION_ID;
        if (!clientId) return { surface, ok: false, error: 'clientId, applicationId, or DISCORD_APPLICATION_ID is required.' };
        return {
          surface,
          ok: true,
          url: DiscordIntegration.buildOAuthAuthorizeUrl({
            clientId,
            redirectUri: this.readString(input?.redirectUri),
            guildId: this.readString(input?.guildId),
            permissions: this.readString(input?.permissions) ?? '2048',
            scopes: this.readStringList(input?.scopes) ?? ['bot', 'applications.commands'],
            disableGuildSelect: typeof input?.disableGuildSelect === 'boolean' ? input.disableGuildSelect : undefined,
            state: this.readString(input?.state),
          }),
        };
      }
      return { surface, ok: false, error: 'OAuth URL generation is not available for this surface.' };
    }
    if (operation === 'register_command' && surface === 'discord') {
      const applicationId = this.readString(input?.applicationId) ?? String(this.deps.configManager.get('surfaces.discord.applicationId') || '');
      const guildId = this.readString(input?.guildId) ?? String(this.deps.configManager.get('surfaces.discord.guildId') || '');
      const token = await this.resolveDiscordBotToken();
      if (!applicationId || !guildId || !token) {
        return { surface, ok: false, error: 'applicationId, guildId, and bot token are required.' };
      }
      const discord = new DiscordIntegration(undefined, token);
      const command = typeof input?.command === 'object' && input.command !== null
        ? input.command as ReturnType<typeof DiscordIntegration.buildGoodVibesCommand>
        : DiscordIntegration.buildGoodVibesCommand();
      const registered = await discord.registerGuildCommand(applicationId, guildId, command);
      return { surface, ok: true, command: registered };
    }
    if (operation === 'subscribe_url' && surface === 'ntfy') {
      const topic = this.readString(input?.topic) ?? String(this.deps.configManager.get('surfaces.ntfy.topic') || '');
      if (!topic) return { surface, ok: false, error: 'topic is required.' };
      const ntfy = new NtfyIntegration(String(this.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'));
      return {
        surface,
        ok: true,
        urls: {
          json: ntfy.buildSubscribeUrl(topic, 'json', { since: this.readString(input?.since) }),
          websocket: ntfy.buildSubscribeUrl(topic, 'ws', { since: this.readString(input?.since) }),
          poll: ntfy.buildSubscribeUrl(topic, 'json', { poll: true, since: this.readString(input?.since) }),
        },
      };
    }
    if (operation === 'poll' && surface === 'ntfy') {
      const topic = this.readString(input?.topic) ?? String(this.deps.configManager.get('surfaces.ntfy.topic') || '');
      if (!topic) return { surface, ok: false, error: 'topic is required.' };
      const ntfy = new NtfyIntegration(
        String(this.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'),
        await this.resolveNtfyToken() ?? undefined,
      );
      const messages = await ntfy.poll(topic, { since: this.readString(input?.since) ?? 'latest' });
      return { surface, ok: true, messages };
    }
    return { surface, ok: false, error: `Unsupported provider operation: ${operation}` };
  }

  private parseExplicitTarget(
    surface: ChannelSurface,
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelResolvedTarget | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const surfacePrefix = `${surface}:`;
    if (trimmed.toLowerCase().startsWith(surfacePrefix)) {
      return this.parseExplicitTarget(surface, trimmed.slice(surfacePrefix.length), options);
    }

    const typedMatch = trimmed.match(/^(direct|dm|user|channel|group|thread|service):(.+)$/i);
    const hashMatch = trimmed.match(/^#([^/:]+)(?:[:/](.+))?$/);
    const atMatch = trimmed.match(/^@(.+)$/);
    const urlMatch = trimmed.match(/^https?:\/\//i);
    let kind: ChannelConversationKind | null = null;
    let to = trimmed;
    let channelId: string | undefined;
    let groupId: string | undefined;
    let threadId = options?.threadId;
    let display: string | undefined;

    if (typedMatch) {
      const prefix = typedMatch[1].toLowerCase();
      const value = typedMatch[2].trim();
      if (!value) return null;
      to = value;
      kind = prefix === 'direct' || prefix === 'dm' || prefix === 'user'
        ? 'direct'
        : prefix === 'channel'
          ? 'channel'
          : prefix === 'group'
            ? 'group'
            : prefix === 'thread'
              ? 'thread'
              : 'service';
    } else if (hashMatch) {
      to = hashMatch[1].trim();
      display = `#${to}`;
      if (hashMatch[2]?.trim()) {
        kind = 'thread';
        channelId = to;
        groupId = to;
        threadId = hashMatch[2].trim();
        to = threadId;
      } else {
        kind = 'channel';
        channelId = to;
        groupId = to;
      }
    } else if (atMatch) {
      to = atMatch[1].trim();
      display = `@${to}`;
      kind = 'direct';
    } else if (urlMatch) {
      kind = 'service';
    }

    if (!kind || !to.trim()) return null;
    const target: ChannelResolvedTarget = {
      surface,
      input,
      normalized: to.trim().toLowerCase(),
      kind,
      to: to.trim(),
      ...(display ? { display } : {}),
      ...(options?.accountId ? { accountId: options.accountId } : {}),
      ...(kind === 'channel' ? { channelId: channelId ?? to.trim(), groupId: groupId ?? to.trim() } : {}),
      ...(kind === 'group' ? { groupId: groupId ?? to.trim() } : {}),
      ...(kind === 'thread' ? { threadId, channelId, groupId } : {}),
      source: 'explicit',
      metadata: { explicitSyntax: true },
    };
    return {
      ...target,
      sessionTarget: this.resolveSessionTarget(target),
    };
  }

  private inferTargetConversationKind(
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelConversationKind {
    const trimmed = input.trim();
    if (trimmed.startsWith('@')) return 'direct';
    if (trimmed.startsWith('#')) return trimmed.includes('/') || trimmed.includes(':') ? 'thread' : 'channel';
    if (/^https?:\/\//i.test(trimmed)) return 'service';
    if (/^thread:/i.test(trimmed)) return 'thread';
    if (/^(direct|dm|user):/i.test(trimmed)) return 'direct';
    if (/^group:/i.test(trimmed)) return 'group';
    if (/^channel:/i.test(trimmed)) return 'channel';
    return options?.preferredKind ?? 'service';
  }

  private async resolveTarget(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<ChannelResolvedTarget | null> {
    const input = options.input.trim();
    if (!input) return null;
    const explicit = this.parseExplicitTarget(surface, input, options);
    const search = explicit?.to ?? input;
    const scope = this.scopeForTargetKind(explicit?.kind ?? options.preferredKind);
    const directoryEntries = await this.deps.channelPlugins.queryDirectory(surface, {
      query: search,
      limit: 5,
      ...(scope ? { scope } : {}),
      ...(options.live ? { live: true } : {}),
    });
    const directoryEntry = this.pickBestDirectoryEntry(directoryEntries, search);
    if (directoryEntry) {
      return this.resolveDirectoryEntryTarget(surface, options, directoryEntry, explicit);
    }
    if (explicit) return explicit;

    const kind = this.inferTargetConversationKind(input, options);
    const normalized = input.toLowerCase();
    const target: ChannelResolvedTarget = {
      surface,
      input: options.input,
      normalized,
      kind,
      to: input,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      source: options.createIfMissing ? 'synthetic' : 'miss',
      metadata: {
        fallback: true,
        createIfMissing: Boolean(options.createIfMissing),
      },
    };
    return {
      ...target,
      sessionTarget: this.resolveSessionTarget(target),
    };
  }

  private async resolveParentConversationCandidates(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<readonly ChannelResolvedTarget[]> {
    const resolved = await this.resolveTarget(surface, options);
    if (!resolved) return [];
    if (resolved.kind !== 'thread' || (!resolved.channelId && !resolved.groupId && !resolved.parentId)) {
      return [resolved];
    }
    const parentInput = resolved.channelId ?? resolved.groupId ?? resolved.parentId ?? resolved.to;
    const parent = await this.resolveTarget(surface, {
      ...options,
      input: parentInput,
      preferredKind: resolved.channelId ? 'channel' : 'group',
      threadId: undefined,
      createIfMissing: true,
    });
    return parent ? [parent, resolved] : [resolved];
  }

  private resolveDirectoryEntryTarget(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
    entry: ChannelDirectoryEntry,
    explicit?: ChannelResolvedTarget | null,
  ): ChannelResolvedTarget {
    const kind = explicit?.kind ?? this.kindForDirectoryEntry(entry);
    const metadataSessionId = typeof entry.metadata.sessionId === 'string' ? entry.metadata.sessionId : undefined;
    const routeBacked = typeof entry.metadata.externalId === 'string' || typeof entry.metadata.parentBindingId === 'string';
    const target: ChannelResolvedTarget = {
      surface,
      input: options.input,
      normalized: (explicit?.normalized ?? entry.handle ?? entry.id).toLowerCase(),
      kind,
      to: explicit?.to ?? entry.handle ?? entry.id,
      display: entry.label,
      accountId: entry.accountId ?? explicit?.accountId ?? options.accountId,
      workspaceId: entry.workspaceId,
      channelId: explicit?.channelId ?? (entry.kind === 'channel' || entry.kind === 'group' || entry.kind === 'thread' ? entry.groupId ?? entry.id : undefined),
      groupId: explicit?.groupId ?? entry.groupId,
      threadId: explicit?.threadId ?? options.threadId ?? entry.threadId,
      parentId: entry.parentId,
      sessionId: metadataSessionId,
      bindingId: routeBacked ? String(entry.metadata.parentBindingId ?? entry.id) : undefined,
      directoryEntryId: entry.id,
      source: routeBacked ? 'route' : 'directory',
      metadata: {
        directoryEntry: entry,
        explicit: explicit ?? null,
      },
    };
    return {
      ...target,
      sessionTarget: this.resolveSessionTarget(target),
    };
  }

  private resolveSessionTarget(target: ChannelResolvedTarget): string {
    if (target.sessionId) return `session:${target.sessionId}`;
    const stableId = target.threadId ?? target.channelId ?? target.groupId ?? target.to;
    return `channel:${target.surface}:${stableId.toLowerCase()}`;
  }

  private scopeForTargetKind(kind?: ChannelConversationKind): ChannelDirectoryScope | undefined {
    if (kind === 'direct') return 'users';
    if (kind === 'channel') return 'channels';
    if (kind === 'group') return 'groups';
    if (kind === 'thread') return 'threads';
    if (kind === 'service') return 'services';
    return undefined;
  }

  private kindForDirectoryEntry(entry: ChannelDirectoryEntry): ChannelConversationKind {
    if (entry.kind === 'self' || entry.kind === 'user' || entry.kind === 'member') return 'direct';
    if (entry.kind === 'thread') return 'thread';
    if (entry.kind === 'channel') return 'channel';
    if (entry.kind === 'group') return 'group';
    return 'service';
  }

  private pickBestDirectoryEntry(entries: readonly ChannelDirectoryEntry[], query: string): ChannelDirectoryEntry | undefined {
    const normalized = query.trim().replace(/^[@#]/, '').toLowerCase();
    return entries.find((entry) => [
      entry.id,
      entry.handle,
      entry.label,
      entry.groupId,
      entry.threadId,
      ...(entry.aliases ?? []),
    ].some((value) => typeof value === 'string' && value.replace(/^[@#]/, '').toLowerCase() === normalized)) ?? entries[0];
  }

  private readLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
    return value === 'inspect'
      || value === 'setup'
      || value === 'retest'
      || value === 'connect'
      || value === 'disconnect'
      || value === 'start'
      || value === 'stop'
      || value === 'login'
      || value === 'logout'
      || value === 'wait_login'
      ? value
      : null;
  }

  private readConversationKind(value: unknown): ChannelConversationKind | null {
    return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
      ? value
      : null;
  }

  private readDirectoryScope(value: unknown): ChannelDirectoryScope | null {
    return value === 'all'
      || value === 'self'
      || value === 'users'
      || value === 'peers'
      || value === 'groups'
      || value === 'channels'
      || value === 'threads'
      || value === 'services'
      || value === 'members'
      ? value
      : null;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private readStringList(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      const entries = value.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean);
      return entries.length > 0 ? entries : undefined;
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
    }
    return undefined;
  }

  private readSecretScope(value: unknown): 'project' | 'user' {
    return value === 'user' ? 'user' : 'project';
  }

  private asProviderRuntimeSurface(surface: ChannelSurface): ProviderRuntimeSurface | null {
    return surface === 'slack' || surface === 'discord' || surface === 'ntfy' ? surface : null;
  }

  private isManagedSurface(surface: ChannelSurface): surface is ManagedSurface {
    return surface === 'slack' || surface === 'discord' || surface === 'ntfy' || surface === 'webhook';
  }

  private providerRuntimeStatus(surface: ProviderRuntimeSurface): unknown {
    return this.deps.providerRuntime?.status(surface) ?? null;
  }

  private providerEnvBacked(surface: ProviderRuntimeSurface): boolean {
    if (surface === 'slack') return Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
    if (surface === 'discord') return Boolean(process.env.DISCORD_BOT_TOKEN);
    return Boolean(process.env.NTFY_ACCESS_TOKEN);
  }

  private async resolveSlackBotToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('slack', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.slack.botToken') || '')
      || process.env.SLACK_BOT_TOKEN
      || null;
  }

  private async resolveDiscordBotToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('discord', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.discord.botToken') || '')
      || process.env.DISCORD_BOT_TOKEN
      || null;
  }

  private async resolveNtfyToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('ntfy', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.ntfy.token') || '')
      || process.env.NTFY_ACCESS_TOKEN
      || null;
  }

  private hasConfiguredValue(value: unknown): boolean {
    return typeof value === 'string'
      ? value.trim().length > 0
      : Array.isArray(value)
        ? value.length > 0
        : Boolean(value);
  }

  private async describeSecret(
    field: string,
    label: string,
    configValue: unknown,
    envKeys: readonly string[] = [],
    serviceName?: 'slack' | 'discord' | 'ntfy',
    serviceField?: ServiceSecretField,
  ): Promise<ChannelSecretStatus> {
    const serviceValue = serviceName && serviceField
      ? await this.deps.serviceRegistry.resolveSecret(serviceName, serviceField)
      : null;
    const configPresent = this.hasConfiguredValue(configValue);
    const envPresent = envKeys.some((key) => this.hasConfiguredValue(process.env[key]));
    return {
      field,
      label,
      configured: Boolean(serviceValue || configPresent || envPresent),
      source: serviceValue
        ? 'service-registry'
        : configPresent
          ? 'config'
          : envPresent
            ? 'env'
            : 'missing',
    };
  }

  private buildAccountActions(configured: boolean, linked: boolean): readonly ChannelAccountAction[] {
    return [
      {
        id: 'inspect',
        label: 'Inspect account',
        kind: 'inspect',
        available: true,
      },
      {
        id: configured ? 'retest' : 'setup',
        label: configured ? 'Retest credentials' : 'Configure surface',
        kind: configured ? 'retest' : 'setup',
        available: true,
      },
      {
        id: linked ? 'disconnect' : 'connect',
        label: linked ? 'Disconnect surface' : 'Connect surface',
        kind: linked ? 'disconnect' : 'connect',
        available: configured,
      },
      {
        id: 'start',
        label: 'Start surface',
        kind: 'start',
        available: configured,
      },
      {
        id: 'stop',
        label: 'Stop surface',
        kind: 'stop',
        available: configured,
      },
      {
        id: linked ? 'logout' : 'login',
        label: linked ? 'Logout account' : 'Login account',
        kind: linked ? 'logout' : 'login',
        available: configured,
      },
      {
        id: 'wait_login',
        label: 'Wait for login',
        kind: 'wait_login',
        available: false,
      },
    ];
  }

  private finalizeChannelAccount(input: {
    surface: ChannelSurface;
    label: string;
    enabled: boolean;
    accountId?: string;
    workspaceId?: string;
    secrets: readonly ChannelSecretStatus[];
    metadata: Record<string, unknown>;
  }): ChannelAccountRecord {
    const configured = Boolean(input.accountId || input.workspaceId || input.secrets.some((entry) => entry.configured));
    const linked = input.secrets.some((entry) => entry.configured);
    const state = !configured
      ? input.enabled ? 'unconfigured' : 'disabled'
      : input.enabled
        ? linked ? 'healthy' : 'degraded'
        : 'disabled';
    const authState = !configured
      ? 'not-configured'
      : linked
        ? 'linked'
        : input.enabled
          ? 'degraded'
          : 'configured';
    const id = input.accountId || input.workspaceId || `surface:${input.surface}`;
    return {
      id,
      surface: input.surface,
      label: input.label,
      enabled: input.enabled,
      configured,
      linked,
      state,
      authState,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      secrets: input.secrets,
      actions: this.buildAccountActions(configured, linked),
      metadata: input.metadata,
    };
  }

  private async lookupDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    const routeEntries = await this.lookupRouteDirectory(surface, query, options);
    if (!options?.live || surface === 'webhook') return routeEntries;
    const providerEntries = await this.lookupProviderDirectory(surface, query, options).catch(() => [] as ChannelDirectoryEntry[]);
    const seen = new Set<string>();
    return [...routeEntries, ...providerEntries].filter((entry) => {
      const key = `${entry.surface}:${entry.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async lookupProviderDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    const needle = query.trim().replace(/^[@#]/, '').toLowerCase();
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const scope = options?.scope ?? 'all';
    if (surface === 'slack') {
      const token = await this.resolveSlackBotToken();
      if (!token) return [];
      const slack = new SlackIntegration(undefined, token);
      const entries: ChannelDirectoryEntry[] = [];
      if (scope === 'all' || scope === 'channels' || scope === 'groups' || scope === 'peers') {
        const page = await slack.listConversations({ token, limit, types: ['public_channel', 'private_channel', 'mpim', 'im'] });
        for (const channel of page.entries) {
          const label = channel.name ?? channel.id;
          entries.push({
            id: channel.id,
            surface,
            kind: channel.is_im ? 'user' : channel.is_mpim ? 'group' : channel.is_group ? 'group' : 'channel',
            label,
            handle: channel.name ? `#${channel.name}` : channel.id,
            workspaceId: String(this.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined,
            groupId: channel.id,
            memberCount: channel.num_members,
            isDirect: Boolean(channel.is_im),
            isGroupConversation: !channel.is_im,
            searchText: [channel.id, channel.name].filter(Boolean).join(' '),
            metadata: { provider: 'slack', raw: channel },
          });
        }
      }
      if (scope === 'all' || scope === 'users' || scope === 'members' || scope === 'peers') {
        const page = await slack.listUsers({ token, limit });
        for (const user of page.entries) {
          if (user.deleted) continue;
          const display = typeof user.profile?.display_name === 'string' && user.profile.display_name
            ? user.profile.display_name
            : user.real_name ?? user.name ?? user.id;
          entries.push({
            id: user.id,
            surface,
            kind: user.is_bot ? 'service' : 'user',
            label: display,
            handle: user.name ? `@${user.name}` : user.id,
            workspaceId: String(this.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined,
            isDirect: true,
            searchText: [user.id, user.name, user.real_name, display].filter(Boolean).join(' '),
            metadata: { provider: 'slack', raw: user },
          });
        }
      }
      return this.filterProviderDirectory(entries, needle, limit);
    }

    if (surface === 'discord') {
      const token = await this.resolveDiscordBotToken();
      const guildId = String(this.deps.configManager.get('surfaces.discord.guildId') || '');
      if (!token || !guildId) return [];
      const discord = new DiscordIntegration(undefined, token);
      const entries: ChannelDirectoryEntry[] = [];
      if (scope === 'all' || scope === 'channels' || scope === 'groups' || scope === 'peers') {
        const channels = await discord.listGuildChannels(guildId, token);
        for (const channel of channels) {
          const id = typeof channel.id === 'string' ? channel.id : '';
          if (!id) continue;
          const name = typeof channel.name === 'string' ? channel.name : id;
          const type = typeof channel.type === 'number' ? channel.type : -1;
          entries.push({
            id,
            surface,
            kind: type === 11 || type === 12 ? 'thread' : type === 3 ? 'group' : 'channel',
            label: name,
            handle: `#${name}`,
            workspaceId: guildId,
            groupId: id,
            parentId: typeof channel.parent_id === 'string' ? channel.parent_id : undefined,
            isGroupConversation: true,
            searchText: [id, name].join(' '),
            metadata: { provider: 'discord', raw: channel },
          });
        }
      }
      if (scope === 'all' || scope === 'users' || scope === 'members' || scope === 'peers') {
        const members = await discord.listGuildMembers(guildId, { token, limit }).catch(() => [] as Array<Record<string, unknown>>);
        for (const member of members) {
          const user = (member.user ?? {}) as Record<string, unknown>;
          const id = typeof user.id === 'string' ? user.id : '';
          if (!id) continue;
          const username = typeof user.username === 'string' ? user.username : id;
          const nick = typeof member.nick === 'string' ? member.nick : undefined;
          entries.push({
            id,
            surface,
            kind: 'user',
            label: nick ?? username,
            handle: `@${username}`,
            workspaceId: guildId,
            isDirect: true,
            searchText: [id, username, nick].filter(Boolean).join(' '),
            metadata: { provider: 'discord', raw: member },
          });
        }
      }
      return this.filterProviderDirectory(entries, needle, limit);
    }

    if (surface === 'ntfy') {
      const topic = String(this.deps.configManager.get('surfaces.ntfy.topic') || '');
      if (!topic) return [];
      const entry: ChannelDirectoryEntry = {
        id: topic,
        surface,
        kind: 'channel',
        label: topic,
        handle: topic,
        groupId: topic,
        isGroupConversation: true,
        searchText: topic,
        metadata: { provider: 'ntfy', baseUrl: this.deps.configManager.get('surfaces.ntfy.baseUrl') },
      };
      return this.filterProviderDirectory([entry], needle, limit);
    }

    return [];
  }

  private filterProviderDirectory(entries: readonly ChannelDirectoryEntry[], needle: string, limit: number): ChannelDirectoryEntry[] {
    return entries
      .filter((entry) => !needle
        || entry.id.toLowerCase().includes(needle)
        || entry.label.toLowerCase().includes(needle)
        || String(entry.handle ?? '').replace(/^[@#]/, '').toLowerCase().includes(needle)
        || String(entry.searchText ?? '').toLowerCase().includes(needle))
      .slice(0, limit);
  }

  private async lookupRouteDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    await this.deps.routeBindings.start();
    const needle = query.trim().toLowerCase();
    const scope = options?.scope ?? 'all';
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const entries = this.deps.routeBindings.listBindings()
      .filter((binding) => binding.surfaceKind === surface)
      .flatMap((binding) => {
        const metadata = binding.metadata ?? {};
        const configuredKind = typeof metadata.directoryKind === 'string' ? metadata.directoryKind : undefined;
        const memberEntries = Array.isArray(metadata.members)
          ? metadata.members
              .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
              .map((entry, index) => ({
                id: typeof entry.id === 'string' ? entry.id : `${binding.id}:member:${index}`,
                surface,
                kind: 'member' as const,
                label: typeof entry.label === 'string'
                  ? entry.label
                  : typeof entry.handle === 'string'
                    ? entry.handle
                    : `Member ${index + 1}`,
                handle: typeof entry.handle === 'string' ? entry.handle : undefined,
                accountId: typeof entry.accountId === 'string' ? entry.accountId : undefined,
                workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : undefined,
                groupId: binding.channelId ?? binding.externalId,
                parentId: binding.id,
                memberCount: undefined,
                memberIds: undefined,
                aliases: Array.isArray(entry.aliases)
                  ? entry.aliases.filter((value): value is string => typeof value === 'string')
                  : undefined,
                isSelf: Boolean(entry.isSelf),
                isDirect: Boolean(entry.isDirect),
                isGroupConversation: true,
                searchText: [
                  typeof entry.handle === 'string' ? entry.handle : '',
                  typeof entry.label === 'string' ? entry.label : '',
                ].filter(Boolean).join(' ').trim() || undefined,
                metadata: {
                  ...entry,
                  parentBindingId: binding.id,
                  sessionId: binding.sessionId,
                  jobId: binding.jobId,
                  runId: binding.runId,
                },
              }))
          : [];
        const baseKind = configuredKind === 'group' || configuredKind === 'member' || configuredKind === 'user' || configuredKind === 'self'
          ? configuredKind
          : binding.threadId
            ? 'thread'
            : binding.channelId
              ? 'group'
              : 'service';
        const mainEntry: ChannelDirectoryEntry = {
          id: binding.id,
          surface,
          kind: baseKind,
          label: binding.title ?? binding.externalId,
          handle: binding.channelId ?? binding.externalId,
          accountId: typeof metadata.accountId === 'string' ? metadata.accountId : undefined,
          workspaceId: typeof metadata.workspaceId === 'string' ? metadata.workspaceId : undefined,
          groupId: binding.channelId ?? binding.externalId,
          threadId: binding.threadId,
          parentId: binding.channelId && binding.threadId ? binding.channelId : undefined,
          memberCount: memberEntries.length > 0 ? memberEntries.length : undefined,
          memberIds: memberEntries.length > 0 ? memberEntries.map((entry) => entry.id) : undefined,
          aliases: Array.isArray(metadata.aliases)
            ? metadata.aliases.filter((value): value is string => typeof value === 'string')
            : undefined,
          isSelf: Boolean(metadata.isSelf),
          isDirect: Boolean(metadata.isDirect),
          isGroupConversation: baseKind === 'group' || baseKind === 'thread',
          searchText: [
            binding.externalId,
            String(binding.title ?? ''),
            String(binding.channelId ?? ''),
            ...(Array.isArray(metadata.aliases)
              ? metadata.aliases.filter((value): value is string => typeof value === 'string')
              : []),
          ].filter(Boolean).join(' ').trim() || undefined,
          metadata: {
            externalId: binding.externalId,
            channelId: binding.channelId,
            threadId: binding.threadId,
            sessionId: binding.sessionId,
            jobId: binding.jobId,
            runId: binding.runId,
            surfaceId: binding.surfaceId,
            ...metadata,
          },
        };
        return [mainEntry, ...memberEntries];
      });
    return entries
      .filter((entry) => !options?.groupId || entry.groupId === options.groupId || entry.parentId === options.groupId || entry.id === options.groupId)
      .filter((entry) => {
        if (scope === 'all') return true;
        if (scope === 'self') return entry.kind === 'self';
        if (scope === 'users') return entry.kind === 'user' || entry.kind === 'member';
        if (scope === 'peers') return entry.kind === 'user' || entry.kind === 'group' || entry.kind === 'channel';
        if (scope === 'groups') return entry.kind === 'group' || entry.kind === 'channel' || entry.kind === 'thread';
        if (scope === 'channels') return entry.kind === 'channel' || entry.kind === 'group';
        if (scope === 'threads') return entry.kind === 'thread';
        if (scope === 'services') return entry.kind === 'service';
        if (scope === 'members') return entry.kind === 'member';
        return false;
      })
      .filter((entry) => !needle
        || entry.id.toLowerCase().includes(needle)
        || entry.label.toLowerCase().includes(needle)
        || String(entry.handle ?? '').toLowerCase().includes(needle)
        || String(entry.searchText ?? '').toLowerCase().includes(needle))
      .slice(0, limit);
  }
}
