import type { Tool } from '@pellux/goodvibes-sdk/platform/types/tools';
import type {
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelAccountRecord,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapabilityDescriptor,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelOperatorActionDescriptor,
  ChannelResolvedTarget,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelSurface,
  ChannelTargetResolveOptions,
  ChannelToolDescriptor,
} from '@pellux/goodvibes-sdk/platform/channels/types';
import type { ChannelPlugin } from '@pellux/goodvibes-sdk/platform/channels/plugin-registry';
import type { ProviderRuntimeSurface } from '@pellux/goodvibes-sdk/platform/channels/provider-runtime';
import { buildBuiltinAccount, resolveBuiltinAccount } from '@pellux/goodvibes-sdk/platform/channels/builtin/accounts';
import {
  buildBuiltinContractHooks,
  editBuiltinAllowlist,
  getBuiltinDoctorReport,
  getBuiltinLifecycleState,
  listBuiltinRepairActions,
  migrateBuiltinLifecycle,
  resolveBuiltinAllowlist,
} from '@pellux/goodvibes-sdk/platform/channels/builtin/contracts';
import {
  listBuiltinCapabilities,
  listBuiltinOperatorActions,
  listBuiltinTools,
} from '@pellux/goodvibes-sdk/platform/channels/builtin/descriptors';
import { getBuiltinSetupSchema } from '@pellux/goodvibes-sdk/platform/channels/builtin/setup-schema';
import { registerBuiltinChannelPlugins } from '@pellux/goodvibes-sdk/platform/channels/builtin/plugins';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from '@pellux/goodvibes-sdk/platform/channels/builtin/shared';
import {
  authorizeBuiltinActorAction,
  runBuiltinAccountAction,
  runBuiltinProviderApi,
} from '@pellux/goodvibes-sdk/platform/channels/builtin/account-actions';
import {
  readConversationKind,
  readDirectoryScope,
  readLifecycleAction,
} from '@pellux/goodvibes-sdk/platform/channels/builtin/parsing';
import {
  listBuiltinAgentTools,
  notifyBuiltinApprovalViaRouter,
  renderBuiltinChannelEvent,
} from '@pellux/goodvibes-sdk/platform/channels/builtin/rendering';
import { providerRuntimeStatus as providerRuntimeStatusForSurface } from '@pellux/goodvibes-sdk/platform/channels/builtin/surfaces';
import {
  inferBuiltinTargetConversationKind,
  lookupBuiltinDirectory,
  parseBuiltinExplicitTarget,
  resolveBuiltinParentConversationCandidates,
  resolveBuiltinSessionTarget,
  resolveBuiltinTarget,
} from '@pellux/goodvibes-sdk/platform/channels/builtin/targets';

export class BuiltinChannelRuntime {
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
      channelPolicy: this.deps.channelPolicy,
      buildAccount: (surface: ChannelSurface) => this.buildAccount(surface),
      resolveAccount: (surface: ChannelSurface, accountId: string) => this.resolveAccount(surface, accountId),
      resolveTarget: (surface: ChannelSurface, options: ChannelTargetResolveOptions) => this.resolveTarget(surface, options),
    };
  }

  async listCapabilities(surface: ChannelSurface): Promise<ChannelCapabilityDescriptor[]> {
    const account = await this.buildAccount(surface);
    const plugin = this.deps.channelPlugins.getBySurface(surface);
    return listBuiltinCapabilities(surface, account, plugin?.capabilities ?? []);
  }

  listOperatorActions(surface: ChannelSurface): ChannelOperatorActionDescriptor[] {
    return listBuiltinOperatorActions(surface);
  }

  listTools(surface: ChannelSurface): ChannelToolDescriptor[] {
    return listBuiltinTools(surface);
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
      return accountId ? this.resolveAccount(surface, accountId) : this.buildAccount(surface);
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
      const scope = readDirectoryScope(input?.scope);
      return this.deps.channelPlugins.queryDirectory(surface, {
        query: typeof input?.query === 'string' ? input.query : undefined,
        ...(scope ? { scope } : {}),
        groupId: typeof input?.groupId === 'string' ? input.groupId : undefined,
        limit: typeof input?.limit === 'number' ? input.limit : undefined,
      });
    }
    if (actionId === 'list-capabilities') {
      return this.listCapabilities(surface);
    }
    if (actionId === 'account-action') {
      const action = readLifecycleAction(input?.action ?? input?.accountAction);
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
      const preferredKind = readConversationKind(input?.preferredKind);
      return this.resolveTarget(surface, {
        input: targetInput,
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
        ...(preferredKind ? { preferredKind } : {}),
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
    return renderBuiltinChannelEvent({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      runTool: (currentSurface, toolId, input) => this.runTool(currentSurface, toolId, input),
    }, surface, request);
  }

  private async notifyApprovalViaRouter(
    surface: ChannelSurface,
    approval: Parameters<typeof notifyBuiltinApprovalViaRouter>[2],
    binding: Parameters<typeof notifyBuiltinApprovalViaRouter>[3],
  ): Promise<void> {
    await notifyBuiltinApprovalViaRouter({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      runTool: (currentSurface, toolId, input) => this.runTool(currentSurface, toolId, input),
    }, surface, approval, binding);
  }

  private listAgentTools(surface: ChannelSurface): readonly Tool[] {
    return listBuiltinAgentTools({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      runTool: (currentSurface, toolId, input) => this.runTool(currentSurface, toolId, input),
    }, surface);
  }

  private async runAccountAction(
    surface: ChannelSurface,
    action: ChannelAccountLifecycleAction,
    accountId?: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult> {
    return runBuiltinAccountAction({
      deps: this.deps,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, action, accountId, input);
  }

  private async authorizeActorAction(
    surface: ChannelSurface,
    request: ChannelActorAuthorizationRequest,
  ): Promise<ChannelActorAuthorizationResult> {
    return authorizeBuiltinActorAction({
      deps: this.deps,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, request);
  }

  private async runProviderApi(surface: ChannelSurface, input?: Record<string, unknown>): Promise<unknown> {
    return runBuiltinProviderApi({
      deps: this.deps,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, input);
  }

  private parseExplicitTarget(
    surface: ChannelSurface,
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelResolvedTarget | null {
    return parseBuiltinExplicitTarget(surface, input, options);
  }

  private inferTargetConversationKind(
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelConversationKind {
    return inferBuiltinTargetConversationKind(input, options);
  }

  private async resolveTarget(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<ChannelResolvedTarget | null> {
    return resolveBuiltinTarget({ deps: this.deps }, surface, options);
  }

  private async resolveParentConversationCandidates(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<readonly ChannelResolvedTarget[]> {
    return resolveBuiltinParentConversationCandidates({ deps: this.deps }, surface, options);
  }

  private resolveSessionTarget(target: ChannelResolvedTarget): string {
    return resolveBuiltinSessionTarget(target);
  }

  private providerRuntimeStatus(surface: ProviderRuntimeSurface): unknown {
    return providerRuntimeStatusForSurface(this.deps, surface);
  }

  private async lookupDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    return lookupBuiltinDirectory({ deps: this.deps }, surface, query, options);
  }

  private async lookupRouteDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    return lookupBuiltinDirectory({ deps: this.deps }, surface, query, { ...options, live: false });
  }
}
