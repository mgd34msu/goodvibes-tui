import {
  type SurfaceAdapterContext,
  handleBlueBubblesSurfaceWebhook,
  handleDiscordSurfaceWebhook,
  handleGenericWebhookSurface,
  handleGoogleChatSurfaceWebhook,
  handleIMessageSurfaceWebhook,
  handleMSTeamsSurfaceWebhook,
  handleMattermostSurfaceWebhook,
  handleMatrixSurfaceWebhook,
  handleNtfySurfaceWebhook,
  handleSignalSurfaceWebhook,
  handleSlackSurfaceWebhook,
  handleTelegramSurfaceWebhook,
  handleWhatsAppSurfaceWebhook,
} from '@pellux/goodvibes-sdk/platform/adapters/index';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { SharedApprovalRecord } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { ProviderRuntimeSurface } from '@pellux/goodvibes-sdk/platform/channels/provider-runtime';
import type {
  ChannelAccountRecord,
  ChannelCapabilityDescriptor,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelOperatorActionDescriptor,
  ChannelSurface,
  ChannelToolDescriptor,
} from '@pellux/goodvibes-sdk/platform/channels/types';
import type { ChannelPlugin } from '@pellux/goodvibes-sdk/platform/channels/plugin-registry';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from '@pellux/goodvibes-sdk/platform/channels/builtin/shared';

interface BuiltinPluginRegistrationContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly buildAccount: (surface: ChannelSurface) => Promise<ChannelAccountRecord>;
  readonly resolveAccount: (surface: ChannelSurface, accountId: string) => Promise<ChannelAccountRecord | null>;
  readonly listCapabilities: (surface: ChannelSurface) => Promise<ChannelCapabilityDescriptor[]>;
  readonly listTools: (surface: ChannelSurface) => ChannelToolDescriptor[];
  readonly runTool: (surface: ChannelSurface, toolId: string, input?: Record<string, unknown>) => Promise<unknown>;
  readonly listOperatorActions: (surface: ChannelSurface) => ChannelOperatorActionDescriptor[];
  readonly runOperatorAction: (surface: ChannelSurface, actionId: string, input?: Record<string, unknown>) => Promise<unknown>;
  readonly buildContractHooks: (surface: ChannelSurface) => Pick<
    ChannelPlugin,
    | 'setupVersion'
    | 'renderPolicy'
    | 'getSetupSchema'
    | 'doctor'
    | 'listRepairActions'
    | 'getLifecycleState'
    | 'migrateLifecycle'
    | 'resolveAllowlist'
    | 'editAllowlist'
  >;
  readonly buildProductHooks: (surface: ChannelSurface) => Pick<
    ChannelPlugin,
    | 'runAccountAction'
    | 'authorizeActorAction'
    | 'parseExplicitTarget'
    | 'inferTargetConversationKind'
    | 'resolveTarget'
    | 'resolveSessionTarget'
    | 'resolveParentConversationCandidates'
    | 'renderEvent'
    | 'listAgentTools'
  >;
  readonly lookupDirectory: (surface: ManagedSurface, query: string, options?: ChannelDirectoryQueryOptions) => Promise<ChannelDirectoryEntry[]>;
  readonly lookupRouteDirectory: (surface: ManagedSurface, query: string, options?: ChannelDirectoryQueryOptions) => Promise<ChannelDirectoryEntry[]>;
  readonly notifyApprovalViaRouter: (surface: ChannelSurface, approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly providerRuntimeStatus: (surface: ProviderRuntimeSurface) => unknown;
}

export function registerBuiltinChannelPlugins(context: BuiltinPluginRegistrationContext): void {
  context.deps.channelPlugins.register({
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
    listAccounts: async () => [await context.buildAccount('tui')],
    getAccount: async (accountId) => context.resolveAccount('tui', accountId),
    listCapabilities: async () => context.listCapabilities('tui'),
    listTools: async () => context.listTools('tui'),
    runTool: (toolId, input) => context.runTool('tui', toolId, input),
    listOperatorActions: async () => context.listOperatorActions('tui'),
    runOperatorAction: (actionId, input) => context.runOperatorAction('tui', actionId, input),
    ...context.buildContractHooks('tui'),
    ...context.buildProductHooks('tui'),
    lookupDirectory: async (query) => query.trim()
      ? [{ id: 'surface:tui', surface: 'tui', kind: 'service', label: 'Terminal UI', metadata: {} }]
      : [],
  });

  context.deps.channelPlugins.register({
    id: 'surface:web',
    surface: 'web',
    displayName: 'Web control plane',
    capabilities: ['ingress', 'egress', 'threaded_reply', 'account_lifecycle', 'target_resolution', 'agent_tools'],
    getStatus: async () => ({
      id: 'surface:web',
      surface: 'web',
      label: 'Web control plane',
      state: context.deps.configManager.get('web.enabled') || context.deps.configManager.get('controlPlane.enabled') ? 'healthy' : 'disabled',
      enabled: Boolean(context.deps.configManager.get('web.enabled') || context.deps.configManager.get('controlPlane.enabled')),
      metadata: {
        baseUrl: context.deps.configManager.get('web.publicBaseUrl'),
      },
    }),
    listAccounts: async () => [await context.buildAccount('web')],
    getAccount: async (accountId) => context.resolveAccount('web', accountId),
    listCapabilities: async () => context.listCapabilities('web'),
    listTools: async () => context.listTools('web'),
    runTool: (toolId, input) => context.runTool('web', toolId, input),
    listOperatorActions: async () => context.listOperatorActions('web'),
    runOperatorAction: (actionId, input) => context.runOperatorAction('web', actionId, input),
    ...context.buildContractHooks('web'),
    ...context.buildProductHooks('web'),
    lookupDirectory: async () => [{ id: 'surface:web', surface: 'web', kind: 'service', label: 'Web control plane', metadata: {} }],
  });

  context.deps.channelPlugins.register({
    id: 'surface:slack',
    surface: 'slack',
    displayName: 'Slack',
    capabilities: ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'],
    webhookPath: '/webhook/slack',
    handleInbound: (req) => handleSlackSurfaceWebhook(req, context.deps.buildSurfaceAdapterContext()),
    deliverReply: (pending, message) => context.deps.deliverSlackAgentReply(pending, message),
    deliverProgress: (pending, progress) => context.deps.deliverSurfaceProgress(pending, progress),
    notifyApproval: (approval, binding) => context.deps.deliverSlackApprovalUpdate(approval, binding),
    getStatus: async () => ({
      id: 'surface:slack',
      surface: 'slack',
      label: 'Slack',
      state: context.deps.surfaceDeliveryEnabled('slack') ? 'healthy' : 'disabled',
      enabled: context.deps.surfaceDeliveryEnabled('slack'),
      accountId: String(context.deps.configManager.get('surfaces.slack.workspaceId') || ''),
      metadata: {
        defaultChannel: context.deps.configManager.get('surfaces.slack.defaultChannel'),
        providerRuntime: context.providerRuntimeStatus('slack'),
      },
    }),
    listAccounts: async () => [await context.buildAccount('slack')],
    getAccount: async (accountId) => context.resolveAccount('slack', accountId),
    listCapabilities: async () => context.listCapabilities('slack'),
    listTools: async () => context.listTools('slack'),
    runTool: (toolId, input) => context.runTool('slack', toolId, input),
    listOperatorActions: async () => context.listOperatorActions('slack'),
    runOperatorAction: (actionId, input) => context.runOperatorAction('slack', actionId, input),
    ...context.buildContractHooks('slack'),
    ...context.buildProductHooks('slack'),
    lookupDirectory: async (query, options) => context.lookupDirectory('slack', query, options),
  });

  context.deps.channelPlugins.register({
    id: 'surface:discord',
    surface: 'discord',
    displayName: 'Discord',
    capabilities: ['ingress', 'egress', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'],
    webhookPath: '/webhook/discord',
    handleInbound: (req) => handleDiscordSurfaceWebhook(req, context.deps.buildSurfaceAdapterContext()),
    deliverReply: (pending, message) => context.deps.deliverDiscordAgentReply(pending, message),
    deliverProgress: (pending, progress) => context.deps.deliverSurfaceProgress(pending, progress),
    notifyApproval: (approval, binding) => context.deps.deliverDiscordApprovalUpdate(approval, binding),
    getStatus: async () => ({
      id: 'surface:discord',
      surface: 'discord',
      label: 'Discord',
      state: context.deps.surfaceDeliveryEnabled('discord') ? 'healthy' : 'disabled',
      enabled: context.deps.surfaceDeliveryEnabled('discord'),
      accountId: String(context.deps.configManager.get('surfaces.discord.applicationId') || ''),
      metadata: {
        defaultChannelId: context.deps.configManager.get('surfaces.discord.defaultChannelId'),
        providerRuntime: context.providerRuntimeStatus('discord'),
      },
    }),
    listAccounts: async () => [await context.buildAccount('discord')],
    getAccount: async (accountId) => context.resolveAccount('discord', accountId),
    listCapabilities: async () => context.listCapabilities('discord'),
    listTools: async () => context.listTools('discord'),
    runTool: (toolId, input) => context.runTool('discord', toolId, input),
    listOperatorActions: async () => context.listOperatorActions('discord'),
    runOperatorAction: (actionId, input) => context.runOperatorAction('discord', actionId, input),
    ...context.buildContractHooks('discord'),
    ...context.buildProductHooks('discord'),
    lookupDirectory: async (query, options) => context.lookupDirectory('discord', query, options),
  });

  context.deps.channelPlugins.register({
    id: 'surface:ntfy',
    surface: 'ntfy',
    displayName: 'ntfy',
    capabilities: ['ingress', 'egress', 'delivery_only', 'account_lifecycle', 'target_resolution', 'agent_tools'],
    webhookPath: '/webhook/ntfy',
    handleInbound: (req) => handleNtfySurfaceWebhook(req, context.deps.buildSurfaceAdapterContext()),
    deliverReply: (pending, message) => context.deps.deliverNtfyAgentReply(pending, message),
    notifyApproval: (approval, binding) => context.deps.deliverNtfyApprovalUpdate(approval, binding),
    getStatus: async () => ({
      id: 'surface:ntfy',
      surface: 'ntfy',
      label: 'ntfy',
      state: context.deps.surfaceDeliveryEnabled('ntfy') ? 'healthy' : 'disabled',
      enabled: context.deps.surfaceDeliveryEnabled('ntfy'),
      metadata: {
        topic: context.deps.configManager.get('surfaces.ntfy.topic'),
        baseUrl: context.deps.configManager.get('surfaces.ntfy.baseUrl'),
        providerRuntime: context.providerRuntimeStatus('ntfy'),
      },
    }),
    listAccounts: async () => [await context.buildAccount('ntfy')],
    getAccount: async (accountId) => context.resolveAccount('ntfy', accountId),
    listCapabilities: async () => context.listCapabilities('ntfy'),
    listTools: async () => context.listTools('ntfy'),
    runTool: (toolId, input) => context.runTool('ntfy', toolId, input),
    listOperatorActions: async () => context.listOperatorActions('ntfy'),
    runOperatorAction: (actionId, input) => context.runOperatorAction('ntfy', actionId, input),
    ...context.buildContractHooks('ntfy'),
    ...context.buildProductHooks('ntfy'),
    lookupDirectory: async (query, options) => context.lookupDirectory('ntfy', query, options),
  });

  context.deps.channelPlugins.register({
    id: 'surface:webhook',
    surface: 'webhook',
    displayName: 'Generic webhook',
    capabilities: ['ingress', 'egress', 'delivery_only', 'account_lifecycle', 'target_resolution', 'agent_tools'],
    webhookPath: '/webhook/generic',
    handleInbound: (req) => handleGenericWebhookSurface(req, context.deps.buildGenericWebhookAdapterContext()),
    deliverReply: (pending, message) => context.deps.deliverWebhookAgentReply(pending, message),
    notifyApproval: (approval, binding) => context.deps.deliverWebhookApprovalUpdate(approval, binding),
    getStatus: async () => ({
      id: 'surface:webhook',
      surface: 'webhook',
      label: 'Generic webhook',
      state: context.deps.surfaceDeliveryEnabled('webhook') ? 'healthy' : 'disabled',
      enabled: context.deps.surfaceDeliveryEnabled('webhook'),
      metadata: {
        defaultTarget: context.deps.configManager.get('surfaces.webhook.defaultTarget'),
      },
    }),
    listAccounts: async () => [await context.buildAccount('webhook')],
    getAccount: async (accountId) => context.resolveAccount('webhook', accountId),
    listCapabilities: async () => context.listCapabilities('webhook'),
    listTools: async () => context.listTools('webhook'),
    runTool: (toolId, input) => context.runTool('webhook', toolId, input),
    listOperatorActions: async () => context.listOperatorActions('webhook'),
    runOperatorAction: (actionId, input) => context.runOperatorAction('webhook', actionId, input),
    ...context.buildContractHooks('webhook'),
    ...context.buildProductHooks('webhook'),
    lookupDirectory: async (query, options) => context.lookupRouteDirectory('webhook', query, options),
  });

  registerRouterBackedPlugin(context, 'telegram', 'Telegram', ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/telegram', handleTelegramSurfaceWebhook);
  registerRouterBackedPlugin(context, 'google-chat', 'Google Chat', ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/google-chat', handleGoogleChatSurfaceWebhook);
  registerRouterBackedPlugin(context, 'signal', 'Signal', ['ingress', 'egress', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/signal', handleSignalSurfaceWebhook);
  registerRouterBackedPlugin(context, 'whatsapp', 'WhatsApp', ['ingress', 'egress', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/whatsapp', handleWhatsAppSurfaceWebhook);
  registerRouterBackedPlugin(context, 'imessage', 'iMessage', ['ingress', 'egress', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/imessage', handleIMessageSurfaceWebhook);
  registerRouterBackedPlugin(context, 'msteams', 'Microsoft Teams', ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/msteams', handleMSTeamsSurfaceWebhook);
  registerRouterBackedPlugin(context, 'bluebubbles', 'BlueBubbles', ['ingress', 'egress', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/bluebubbles', handleBlueBubblesSurfaceWebhook);
  registerRouterBackedPlugin(context, 'mattermost', 'Mattermost', ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/mattermost', handleMattermostSurfaceWebhook);
  registerRouterBackedPlugin(context, 'matrix', 'Matrix', ['ingress', 'egress', 'threaded_reply', 'interactive_actions', 'account_lifecycle', 'target_resolution', 'agent_tools'], '/webhook/matrix', handleMatrixSurfaceWebhook);
}

function registerRouterBackedPlugin(
  context: BuiltinPluginRegistrationContext,
  surface: ManagedSurface,
  displayName: string,
  capabilities: ChannelPlugin['capabilities'],
  webhookPath: string,
  handleInbound: (req: Request, context: SurfaceAdapterContext) => Promise<Response>,
): void {
  context.deps.channelPlugins.register({
    id: `surface:${surface}`,
    surface,
    displayName,
    capabilities,
    webhookPath,
    handleInbound: (req) => handleInbound(req, context.deps.buildSurfaceAdapterContext()),
    getStatus: async () => {
      const account = await context.buildAccount(surface);
      return {
        id: `surface:${surface}`,
        surface,
        label: displayName,
        state: account.state === 'healthy' ? 'healthy' : account.state === 'disabled' ? 'disabled' : 'degraded',
        enabled: context.deps.surfaceDeliveryEnabled(surface),
        accountId: account.accountId,
        metadata: account.metadata,
      };
    },
    listAccounts: async () => [await context.buildAccount(surface)],
    getAccount: async (accountId) => context.resolveAccount(surface, accountId),
    listCapabilities: async () => context.listCapabilities(surface),
    listTools: async () => context.listTools(surface),
    runTool: (toolId, input) => context.runTool(surface, toolId, input),
    listOperatorActions: async () => context.listOperatorActions(surface),
    runOperatorAction: (actionId, input) => context.runOperatorAction(surface, actionId, input),
    notifyApproval: (approval, binding) => context.notifyApprovalViaRouter(surface, approval, binding),
    ...context.buildContractHooks(surface),
    ...context.buildProductHooks(surface),
    lookupDirectory: async (query, options) => context.lookupDirectory(surface, query, options),
  });
}
