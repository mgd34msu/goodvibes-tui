import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { SurfacesConfig } from '../config/schema.ts';
import type { ServiceSecretField } from '../config/service-registry.ts';
import type { SharedApprovalRecord } from '../control-plane/index.ts';
import { getSecretsManager } from '../config/secrets.ts';
import { DiscordIntegration, NtfyIntegration, SlackIntegration } from '../integrations/index.ts';
import type { Tool } from '../types/tools.ts';
import { ChannelDeliveryRouter, type ChannelDeliveryRequest, type ChannelDeliveryRouteBinding } from './delivery-router.ts';
import { ChannelPolicyManager } from './policy-manager.ts';
import type {
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelAccountAction,
  ChannelAccountRecord,
  ChannelAllowlistEditInput,
  ChannelAllowlistEditResult,
  ChannelAllowlistResolution,
  ChannelAllowlistTarget,
  ChannelAllowlistTargetKind,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapability,
  ChannelCapabilityDescriptor,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelDirectoryScope,
  ChannelDoctorCheck,
  ChannelDoctorReport,
  ChannelDoctorStatus,
  ChannelLifecycleMigrationRecord,
  ChannelLifecycleState,
  ChannelOperatorActionDescriptor,
  ChannelResolvedTarget,
  ChannelRenderRequest,
  ChannelRenderPolicy,
  ChannelRenderResult,
  ChannelRepairAction,
  ChannelSecretStatus,
  ChannelSecretTargetDescriptor,
  ChannelSetupFieldDescriptor,
  ChannelSetupSchema,
  ChannelSurface,
  ChannelTargetResolveOptions,
  ChannelToolDescriptor,
} from './types.ts';
import type { ChannelPlugin } from './plugin-registry.ts';
import type { ProviderRuntimeSurface } from './provider-runtime.ts';
import { buildBuiltinAccount, resolveBuiltinAccount } from './builtin/accounts.ts';
import {
  buildBuiltinContractHooks,
  editBuiltinAllowlist,
  getBuiltinDoctorReport,
  getBuiltinLifecycleState,
  getBuiltinSetupSchema,
  listBuiltinRepairActions,
  migrateBuiltinLifecycle,
  resolveBuiltinAllowlist,
} from './builtin/contracts.ts';
import { registerBuiltinChannelPlugins } from './builtin/plugins.ts';
import {
  CHANNEL_SETUP_VERSION,
  DEFAULT_SECRET_BACKENDS,
  configSectionForSurface,
  type BuiltinChannelRuntimeDeps,
  type ManagedSurface,
} from './builtin/shared.ts';

export class BuiltinChannelRuntime {
  private readonly channelPolicy = ChannelPolicyManager.getInstance();

  constructor(private readonly deps: BuiltinChannelRuntimeDeps) {}

  registerPlugins(): void {
    registerBuiltinChannelPlugins({
      deps: this.deps,
      buildAccount: (surface) => this.buildAccount(surface),
      resolveAccount: (surface, accountId) => this.resolveAccount(surface, accountId),
      listCapabilities: (surface) => this.listCapabilities(surface),
      listTools: (surface) => this.listTools(surface),
      runTool: (surface, toolId, input) => this.runTool(surface, toolId, input),
      listOperatorActions: (surface) => this.listOperatorActions(surface),
      runOperatorAction: (surface, actionId, input) => this.runOperatorAction(surface, actionId, input),
      buildContractHooks: (surface) => this.buildContractHooks(surface),
      buildProductHooks: (surface) => this.buildProductHooks(surface),
      lookupDirectory: (surface, query, options) => this.lookupDirectory(surface, query, options),
      lookupRouteDirectory: (surface, query, options) => this.lookupRouteDirectory(surface, query, options),
      notifyApprovalViaRouter: (surface, approval, binding) => this.notifyApprovalViaRouter(surface, approval, binding),
      providerRuntimeStatus: (surface) => this.providerRuntimeStatus(surface),
    });
  }

  private accountContext() {
    return {
      deps: this.deps,
      providerRuntimeStatus: (surface: ProviderRuntimeSurface) => this.providerRuntimeStatus(surface),
    };
  }

  async buildAccount(surface: ChannelSurface): Promise<ChannelAccountRecord> {
    return buildBuiltinAccount(this.accountContext(), surface);
  }

  async resolveAccount(surface: ChannelSurface, accountId: string): Promise<ChannelAccountRecord | null> {
    return resolveBuiltinAccount(this.accountContext(), surface, accountId);
  }

  private contractContext() {
    return {
      deps: this.deps,
      channelPolicy: this.channelPolicy,
      buildAccount: (surface: ChannelSurface) => this.buildAccount(surface),
      resolveAccount: (surface: ChannelSurface, accountId: string) => this.resolveAccount(surface, accountId),
      resolveTarget: (surface: ChannelSurface, options: ChannelTargetResolveOptions) => this.resolveTarget(surface, options),
    };
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
        id: 'setup-schema',
        surface,
        label: 'Get setup schema',
        description: 'Return the versioned setup contract, secret targets, and external steps for this surface.',
        dangerous: false,
        metadata: {},
      },
      {
        id: 'doctor',
        surface,
        label: 'Run doctor',
        description: 'Return doctor checks and repair actions for this surface.',
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
        id: 'repair-actions',
        surface,
        label: 'List repair actions',
        description: 'Return repair actions for this surface.',
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
        id: 'lifecycle-state',
        surface,
        label: 'Get lifecycle state',
        description: 'Return lifecycle migration posture for this surface.',
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
        id: 'migrate-lifecycle',
        surface,
        label: 'Apply lifecycle migration',
        description: 'Apply lifecycle migrations for this surface.',
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
        id: 'resolve-allowlist',
        surface,
        label: 'Resolve allowlist entries',
        description: 'Resolve allowlist candidates into stable user, channel, or group identifiers.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            add: { type: 'array', items: { type: 'string' } },
            remove: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string' },
          },
          additionalProperties: true,
        },
        metadata: {},
      },
      {
        id: 'edit-allowlist',
        surface,
        label: 'Edit allowlist',
        description: 'Apply allowlist additions or removals at the surface or scoped group/channel level.',
        dangerous: false,
        inputSchema: {
          type: 'object',
          properties: {
            add: { type: 'array', items: { type: 'string' } },
            remove: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string' },
            groupId: { type: 'string' },
            channelId: { type: 'string' },
            workspaceId: { type: 'string' },
          },
          additionalProperties: true,
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
        id: `${surface}:setup_schema`,
        surface,
        name: `${surface}_setup_schema`,
        description: `Return the setup contract for the ${surface} surface.`,
        actionIds: ['setup-schema'],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
        metadata: {},
      },
      {
        id: `${surface}:doctor`,
        surface,
        name: `${surface}_doctor`,
        description: `Run doctor checks for the ${surface} surface.`,
        actionIds: ['doctor'],
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
        id: `${surface}:lifecycle`,
        surface,
        name: `${surface}_lifecycle`,
        description: `Return lifecycle migration posture for the ${surface} surface.`,
        actionIds: ['lifecycle-state'],
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
        id: `${surface}:allowlist_resolve`,
        surface,
        name: `${surface}_allowlist_resolve`,
        description: `Resolve allowlist candidates for the ${surface} surface.`,
        actionIds: ['resolve-allowlist'],
        inputSchema: {
          type: 'object',
          properties: {
            add: { type: 'array', items: { type: 'string' } },
            remove: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string' },
          },
          additionalProperties: true,
        },
        metadata: {},
      },
      {
        id: `${surface}:allowlist_edit`,
        surface,
        name: `${surface}_allowlist_edit`,
        description: `Edit allowlists for the ${surface} surface.`,
        actionIds: ['edit-allowlist'],
        inputSchema: {
          type: 'object',
          properties: {
            add: { type: 'array', items: { type: 'string' } },
            remove: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string' },
            groupId: { type: 'string' },
            channelId: { type: 'string' },
            workspaceId: { type: 'string' },
          },
          additionalProperties: true,
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
    if (actionId === 'setup-schema') {
      return this.getSetupSchema(surface);
    }
    if (actionId === 'doctor') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.getDoctorReport(surface, accountId);
    }
    if (actionId === 'repair-actions') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.listRepairActions(surface, accountId);
    }
    if (actionId === 'lifecycle-state') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.getLifecycleState(surface, accountId);
    }
    if (actionId === 'migrate-lifecycle') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.migrateLifecycle(surface, accountId, input);
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
    if (actionId === 'resolve-allowlist') {
      return this.resolveAllowlist(surface, {
        ...(Array.isArray(input?.add) ? { add: input.add.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(Array.isArray(input?.remove) ? { remove: input.remove.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(input?.kind === 'user' || input?.kind === 'channel' || input?.kind === 'group' ? { kind: input.kind } : {}),
      });
    }
    if (actionId === 'edit-allowlist') {
      return this.editAllowlist(surface, {
        ...(Array.isArray(input?.add) ? { add: input.add.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(Array.isArray(input?.remove) ? { remove: input.remove.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(typeof input?.groupId === 'string' ? { groupId: input.groupId } : {}),
        ...(typeof input?.channelId === 'string' ? { channelId: input.channelId } : {}),
        ...(typeof input?.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
        ...(input?.kind === 'user' || input?.kind === 'channel' || input?.kind === 'group' ? { kind: input.kind } : {}),
        ...(typeof input?.metadata === 'object' && input.metadata !== null ? { metadata: input.metadata as Record<string, unknown> } : {}),
      });
    }
    if (actionId === 'provider-api') {
      return this.runProviderApi(surface, input);
    }
    return null;
  }

  private buildContractHooks(surface: ChannelSurface): Pick<
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
  > {
    return buildBuiltinContractHooks(this.contractContext(), surface);
  }

  private getSetupSchema(surface: ChannelSurface) {
    return getBuiltinSetupSchema(surface);
  }

  private async listRepairActions(surface: ChannelSurface, accountId?: string) {
    return listBuiltinRepairActions(this.contractContext(), surface, accountId);
  }

  private async getDoctorReport(surface: ChannelSurface, accountId?: string) {
    return getBuiltinDoctorReport(this.contractContext(), surface, accountId);
  }

  private async getLifecycleState(surface: ChannelSurface, accountId?: string) {
    return getBuiltinLifecycleState(this.contractContext(), surface, accountId);
  }

  private async migrateLifecycle(
    surface: ChannelSurface,
    accountId?: string,
    input?: Record<string, unknown>,
  ) {
    return migrateBuiltinLifecycle(this.contractContext(), surface, accountId, input);
  }

  private async resolveAllowlist(surface: ChannelSurface, input: Parameters<typeof resolveBuiltinAllowlist>[2]) {
    return resolveBuiltinAllowlist(this.contractContext(), surface, input);
  }

  private async editAllowlist(surface: ChannelSurface, input: Parameters<typeof editBuiltinAllowlist>[2]) {
    return editBuiltinAllowlist(this.contractContext(), surface, input);
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
    | 'renderEvent'
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
      renderEvent: (request) => this.renderChannelEvent(surface, request),
      listAgentTools: () => this.listAgentTools(surface),
    };
  }

  private async renderChannelEvent(surface: ChannelSurface, request: ChannelRenderRequest): Promise<ChannelRenderResult> {
    const router = ChannelDeliveryRouter.getActive();
    if (!router) throw new Error('Channel delivery router is not active');
    const binding = request.routeId ? this.deps.routeBindings.getBinding(request.routeId) : undefined;
    const responseId = await router.deliver({
      target: this.buildDeliveryTarget(surface, request, binding),
      body: request.text,
      title: request.title,
      jobId: binding?.jobId ?? request.routeId ?? `channel:${surface}`,
      runId: binding?.runId ?? request.agentId ?? request.sessionId ?? `${surface}:${Date.now()}`,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      status: this.renderStatus(request),
      includeLinks: request.phase !== 'progress',
      ...(binding ? { binding: this.toDeliveryRouteBinding(binding) } : {}),
    });
    return {
      delivered: true,
      ...(responseId ? { responseId } : {}),
      ...(binding?.threadId ? { threadId: binding.threadId } : {}),
      metadata: {
        surface,
        phase: request.phase,
        via: 'channel-delivery-router',
      },
    };
  }

  private async notifyApprovalViaRouter(
    surface: ChannelSurface,
    approval: SharedApprovalRecord,
    binding: AutomationRouteBinding,
  ): Promise<void> {
    const router = ChannelDeliveryRouter.getActive();
    if (!router) throw new Error('Channel delivery router is not active');
    const status = approval.status === 'approved'
      ? 'completed'
      : approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired'
        ? 'failed'
        : 'running';
    await router.deliver({
      target: this.buildDeliveryTarget(surface, { pending: {} }, binding),
      body: this.formatApprovalMessage(approval),
      title: `Approval ${approval.status}: ${approval.request.tool}`,
      jobId: binding.jobId ?? `approval:${approval.id}`,
      runId: binding.runId ?? approval.id,
      status,
      includeLinks: true,
      binding: this.toDeliveryRouteBinding(binding),
    });
  }

  private buildDeliveryTarget(
    surface: ChannelSurface,
    request: { readonly pending?: Record<string, unknown> },
    binding?: AutomationRouteBinding,
  ): ChannelDeliveryRequest['target'] {
    const pending = request.pending ?? {};
    const address = surface === 'webhook'
      ? this.readPendingString(pending, 'callbackUrl')
        ?? this.readMetadataString(binding?.metadata, 'callbackUrl')
      : this.readPendingString(pending, 'targetAddress')
        ?? this.readPendingString(pending, 'responseUrl')
        ?? this.readPendingString(pending, 'channelId')
        ?? this.readPendingString(pending, 'topic')
        ?? binding?.channelId
        ?? binding?.externalId;
    if (surface === 'webhook') {
      return {
        kind: 'webhook',
        surfaceKind: 'webhook',
        ...(address ? { address } : {}),
      };
    }
    return {
      kind: 'surface',
      surfaceKind: surface,
      ...(address ? { address } : {}),
    };
  }

  private toDeliveryRouteBinding(binding: AutomationRouteBinding): ChannelDeliveryRouteBinding {
    return {
      id: binding.id,
      surfaceKind: binding.surfaceKind,
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(binding.channelId ? { channelId: binding.channelId } : {}),
      ...(binding.title ? { title: binding.title } : {}),
      metadata: { ...binding.metadata },
    };
  }

  private renderStatus(request: ChannelRenderRequest): string {
    if (request.events.some((event) => event.kind === 'error')) return 'failed';
    if (request.phase === 'final') return 'completed';
    if (request.phase === 'approval') return 'running';
    return 'running';
  }

  private formatApprovalMessage(approval: SharedApprovalRecord): string {
    const lines = [
      `Approval ${approval.status}: ${approval.id}`,
      `Tool: ${approval.request.tool}`,
      approval.request.analysis.summary,
      approval.request.analysis.target ? `Target: ${approval.request.analysis.target}` : '',
      approval.resolvedBy ? `Resolved by: ${approval.resolvedBy}` : '',
    ].filter((line) => line.trim().length > 0);
    return lines.join('\n');
  }

  private readPendingString(pending: Record<string, unknown>, key: string): string | undefined {
    const value = pending[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
    if (!metadata) return undefined;
    const value = metadata[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

    if (surface === 'telegram') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      const candidates: ChannelDirectoryEntry[] = [];
      if (surfaces.telegram.defaultChatId) {
        candidates.push({
          id: surfaces.telegram.defaultChatId,
          surface,
          kind: 'channel',
          label: surfaces.telegram.defaultChatId,
          handle: surfaces.telegram.defaultChatId,
          groupId: surfaces.telegram.defaultChatId,
          isGroupConversation: true,
          searchText: [surfaces.telegram.defaultChatId, surfaces.telegram.botUsername].filter(Boolean).join(' '),
          metadata: { provider: 'telegram', mode: surfaces.telegram.mode },
        });
      }
      if (surfaces.telegram.botUsername) {
        candidates.push({
          id: surfaces.telegram.botUsername.replace(/^@/, ''),
          surface,
          kind: 'service',
          label: `@${surfaces.telegram.botUsername.replace(/^@/, '')}`,
          handle: `@${surfaces.telegram.botUsername.replace(/^@/, '')}`,
          searchText: surfaces.telegram.botUsername,
          metadata: { provider: 'telegram', bot: true },
        });
      }
      return this.filterProviderDirectory(candidates, needle, limit);
    }

    if (surface === 'google-chat') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.googleChat.spaceId && !surfaces.googleChat.appId) return [];
      return this.filterProviderDirectory([{
        id: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
        surface,
        kind: 'channel',
        label: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
        handle: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
        groupId: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
        isGroupConversation: true,
        searchText: [surfaces.googleChat.spaceId, surfaces.googleChat.appId].filter(Boolean).join(' '),
        metadata: { provider: 'google-chat' },
      }], needle, limit);
    }

    if (surface === 'signal') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.signal.defaultRecipient && !surfaces.signal.account) return [];
      return this.filterProviderDirectory([{
        id: surfaces.signal.defaultRecipient || surfaces.signal.account,
        surface,
        kind: 'user',
        label: surfaces.signal.defaultRecipient || surfaces.signal.account,
        handle: surfaces.signal.defaultRecipient || surfaces.signal.account,
        isDirect: true,
        searchText: [surfaces.signal.defaultRecipient, surfaces.signal.account].filter(Boolean).join(' '),
        metadata: { provider: 'signal', bridgeUrl: surfaces.signal.bridgeUrl },
      }], needle, limit);
    }

    if (surface === 'whatsapp') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.whatsapp.defaultRecipient && !surfaces.whatsapp.phoneNumberId) return [];
      return this.filterProviderDirectory([{
        id: surfaces.whatsapp.defaultRecipient || surfaces.whatsapp.phoneNumberId,
        surface,
        kind: 'user',
        label: surfaces.whatsapp.defaultRecipient || surfaces.whatsapp.phoneNumberId,
        handle: surfaces.whatsapp.defaultRecipient || surfaces.whatsapp.phoneNumberId,
        isDirect: true,
        searchText: [
          surfaces.whatsapp.defaultRecipient,
          surfaces.whatsapp.phoneNumberId,
          surfaces.whatsapp.businessAccountId,
        ].filter(Boolean).join(' '),
        metadata: { provider: 'whatsapp', mode: surfaces.whatsapp.provider },
      }], needle, limit);
    }

    if (surface === 'imessage') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.imessage.defaultChatId && !surfaces.imessage.account) return [];
      return this.filterProviderDirectory([{
        id: surfaces.imessage.defaultChatId || surfaces.imessage.account,
        surface,
        kind: 'user',
        label: surfaces.imessage.defaultChatId || surfaces.imessage.account,
        handle: surfaces.imessage.defaultChatId || surfaces.imessage.account,
        isDirect: true,
        searchText: [surfaces.imessage.defaultChatId, surfaces.imessage.account].filter(Boolean).join(' '),
        metadata: { provider: 'imessage', bridgeUrl: surfaces.imessage.bridgeUrl },
      }], needle, limit);
    }

    if (surface === 'msteams') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      const candidates: ChannelDirectoryEntry[] = [];
      if (surfaces.msteams.defaultConversationId) {
        candidates.push({
          id: surfaces.msteams.defaultConversationId,
          surface,
          kind: 'channel',
          label: surfaces.msteams.defaultConversationId,
          handle: surfaces.msteams.defaultConversationId,
          groupId: surfaces.msteams.defaultChannelId || surfaces.msteams.defaultConversationId,
          isGroupConversation: true,
          searchText: [
            surfaces.msteams.defaultConversationId,
            surfaces.msteams.defaultChannelId,
            surfaces.msteams.botId,
          ].filter(Boolean).join(' '),
          metadata: { provider: 'msteams', serviceUrl: surfaces.msteams.serviceUrl },
        });
      }
      if (surfaces.msteams.botId) {
        candidates.push({
          id: surfaces.msteams.botId,
          surface,
          kind: 'service',
          label: surfaces.msteams.botId,
          handle: surfaces.msteams.botId,
          searchText: [surfaces.msteams.botId, surfaces.msteams.appId].filter(Boolean).join(' '),
          metadata: { provider: 'msteams', bot: true },
        });
      }
      return this.filterProviderDirectory(candidates, needle, limit);
    }

    if (surface === 'bluebubbles') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.bluebubbles.defaultChatGuid && !surfaces.bluebubbles.account) return [];
      return this.filterProviderDirectory([{
        id: surfaces.bluebubbles.defaultChatGuid || surfaces.bluebubbles.account,
        surface,
        kind: 'user',
        label: surfaces.bluebubbles.defaultChatGuid || surfaces.bluebubbles.account,
        handle: surfaces.bluebubbles.defaultChatGuid || surfaces.bluebubbles.account,
        isDirect: !(surfaces.bluebubbles.defaultChatGuid || '').includes(';+;'),
        searchText: [surfaces.bluebubbles.defaultChatGuid, surfaces.bluebubbles.account].filter(Boolean).join(' '),
        metadata: { provider: 'bluebubbles', serverUrl: surfaces.bluebubbles.serverUrl },
      }], needle, limit);
    }

    if (surface === 'mattermost') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.mattermost.defaultChannelId && !surfaces.mattermost.teamId) return [];
      return this.filterProviderDirectory([{
        id: surfaces.mattermost.defaultChannelId || surfaces.mattermost.teamId,
        surface,
        kind: 'channel',
        label: surfaces.mattermost.defaultChannelId || surfaces.mattermost.teamId,
        handle: surfaces.mattermost.defaultChannelId || surfaces.mattermost.teamId,
        groupId: surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId,
        isGroupConversation: true,
        searchText: [surfaces.mattermost.defaultChannelId, surfaces.mattermost.teamId].filter(Boolean).join(' '),
        metadata: { provider: 'mattermost', baseUrl: surfaces.mattermost.baseUrl },
      }], needle, limit);
    }

    if (surface === 'matrix') {
      const surfaces = this.deps.configManager.getCategory('surfaces');
      if (!surfaces.matrix.defaultRoomId && !surfaces.matrix.userId) return [];
      return this.filterProviderDirectory([{
        id: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
        surface,
        kind: 'channel',
        label: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
        handle: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
        groupId: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
        isGroupConversation: true,
        searchText: [surfaces.matrix.defaultRoomId, surfaces.matrix.userId].filter(Boolean).join(' '),
        metadata: { provider: 'matrix', homeserverUrl: surfaces.matrix.homeserverUrl },
      }], needle, limit);
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
