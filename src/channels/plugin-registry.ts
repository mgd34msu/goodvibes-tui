import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { SharedApprovalRecord } from '../control-plane/index.ts';
import type { Tool } from '../types/tools.ts';
import type {
  ChannelAdapterDescriptor,
  ChannelAllowlistEditInput,
  ChannelAllowlistEditResult,
  ChannelAllowlistResolution,
  ChannelAccountRecord,
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapabilityDescriptor,
  ChannelCapability,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelDoctorReport,
  ChannelLifecycleState,
  ChannelOperatorActionDescriptor,
  ChannelRenderPolicy,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelResolvedTarget,
  ChannelRepairAction,
  ChannelSetupSchema,
  ChannelStatusSnapshot,
  ChannelSurface,
  ChannelTargetResolveOptions,
  ChannelToolDescriptor,
} from './types.ts';

export interface ChannelPlugin {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly displayName: string;
  readonly capabilities: readonly ChannelCapability[];
  readonly setupVersion?: number;
  readonly webhookPath?: string;
  readonly handleInbound?: (req: Request) => Promise<Response>;
  readonly renderPolicy?: () => ChannelRenderPolicy | Promise<ChannelRenderPolicy>;
  readonly renderEvent?: (request: ChannelRenderRequest) => Promise<ChannelRenderResult | void>;
  readonly deliverReply?: (pending: unknown, message: string) => Promise<void>;
  readonly deliverProgress?: (pending: unknown, progress: string) => Promise<void>;
  readonly notifyApproval?: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly getSetupSchema?: (accountId?: string) => Promise<ChannelSetupSchema> | ChannelSetupSchema;
  readonly doctor?: (accountId?: string) => Promise<ChannelDoctorReport> | ChannelDoctorReport;
  readonly listRepairActions?: (accountId?: string) => Promise<readonly ChannelRepairAction[]> | readonly ChannelRepairAction[];
  readonly getLifecycleState?: (accountId?: string) => Promise<ChannelLifecycleState> | ChannelLifecycleState;
  readonly migrateLifecycle?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelLifecycleState> | ChannelLifecycleState;
  readonly resolveAllowlist?: (input: ChannelAllowlistEditInput) => Promise<ChannelAllowlistResolution> | ChannelAllowlistResolution;
  readonly editAllowlist?: (input: ChannelAllowlistEditInput) => Promise<ChannelAllowlistEditResult> | ChannelAllowlistEditResult;
  readonly getStatus?: () => Promise<ChannelStatusSnapshot>;
  readonly listAccounts?: () => Promise<readonly ChannelAccountRecord[]>;
  readonly getAccount?: (accountId: string) => Promise<ChannelAccountRecord | null>;
  readonly startAccount?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelAccountLifecycleResult>;
  readonly stopAccount?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelAccountLifecycleResult>;
  readonly loginAccount?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelAccountLifecycleResult>;
  readonly loginWithQrStart?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelAccountLifecycleResult>;
  readonly loginWithQrWait?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelAccountLifecycleResult>;
  readonly logoutAccount?: (accountId?: string, input?: Record<string, unknown>) => Promise<ChannelAccountLifecycleResult>;
  readonly runAccountAction?: (
    action: ChannelAccountLifecycleAction,
    accountId?: string,
    input?: Record<string, unknown>,
  ) => Promise<ChannelAccountLifecycleResult>;
  readonly authorizeActorAction?: (request: ChannelActorAuthorizationRequest) => Promise<ChannelActorAuthorizationResult>;
  readonly getActionAvailabilityState?: (request: ChannelActorAuthorizationRequest) => Promise<ChannelActorAuthorizationResult>;
  readonly listCapabilities?: () => Promise<readonly ChannelCapabilityDescriptor[]> | readonly ChannelCapabilityDescriptor[];
  readonly listTools?: () => Promise<readonly ChannelToolDescriptor[]> | readonly ChannelToolDescriptor[];
  readonly runTool?: (toolId: string, input?: Record<string, unknown>) => Promise<unknown>;
  readonly listOperatorActions?: () => Promise<readonly ChannelOperatorActionDescriptor[]> | readonly ChannelOperatorActionDescriptor[];
  readonly runOperatorAction?: (actionId: string, input?: Record<string, unknown>) => Promise<unknown>;
  readonly lookupDirectory?: (query: string, options?: ChannelDirectoryQueryOptions) => Promise<readonly ChannelDirectoryEntry[]>;
  readonly queryDirectory?: (query: ChannelDirectoryQueryOptions) => Promise<readonly ChannelDirectoryEntry[]>;
  readonly listGroupMembers?: (groupId: string, options?: ChannelDirectoryQueryOptions) => Promise<readonly ChannelDirectoryEntry[]>;
  readonly parseExplicitTarget?: (input: string, options?: ChannelTargetResolveOptions) => Promise<ChannelResolvedTarget | null> | ChannelResolvedTarget | null;
  readonly inferTargetConversationKind?: (input: string, options?: ChannelTargetResolveOptions) => Promise<ChannelConversationKind | null> | ChannelConversationKind | null;
  readonly resolveTarget?: (options: ChannelTargetResolveOptions) => Promise<ChannelResolvedTarget | null>;
  readonly resolveSessionTarget?: (target: ChannelResolvedTarget, options?: ChannelTargetResolveOptions) => Promise<string | null> | string | null;
  readonly resolveParentConversationCandidates?: (options: ChannelTargetResolveOptions) => Promise<readonly ChannelResolvedTarget[]>;
  readonly listAgentTools?: () => readonly Tool[];
}

export class ChannelPluginRegistry {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly pluginsBySurface = new Map<ChannelSurface, ChannelPlugin>();
  private readonly pluginsByPath = new Map<string, ChannelPlugin>();
  private version = 0;

  register(plugin: ChannelPlugin): void {
    const existingById = this.plugins.get(plugin.id);
    if (existingById?.webhookPath) {
      this.pluginsByPath.delete(existingById.webhookPath);
    }
    if (existingById && this.pluginsBySurface.get(existingById.surface)?.id === existingById.id) {
      this.pluginsBySurface.delete(existingById.surface);
    }
    const existingBySurface = this.pluginsBySurface.get(plugin.surface);
    if (existingBySurface && existingBySurface.id !== plugin.id) {
      this.plugins.delete(existingBySurface.id);
      if (existingBySurface.webhookPath) this.pluginsByPath.delete(existingBySurface.webhookPath);
    }
    this.plugins.set(plugin.id, plugin);
    this.pluginsBySurface.set(plugin.surface, plugin);
    if (plugin.webhookPath) {
      this.pluginsByPath.set(plugin.webhookPath, plugin);
    }
    this.version += 1;
  }

  unregister(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    this.plugins.delete(pluginId);
    if (this.pluginsBySurface.get(plugin.surface)?.id === pluginId) {
      this.pluginsBySurface.delete(plugin.surface);
    }
    if (plugin.webhookPath && this.pluginsByPath.get(plugin.webhookPath)?.id === pluginId) {
      this.pluginsByPath.delete(plugin.webhookPath);
    }
    this.version += 1;
    return true;
  }

  getVersion(): number {
    return this.version;
  }

  list(): ChannelPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  listDescriptors(): ChannelAdapterDescriptor[] {
    return this.list().map((plugin) => ({
      id: plugin.id,
      surface: plugin.surface,
      displayName: plugin.displayName,
      capabilities: [...plugin.capabilities],
      ...(plugin.setupVersion ? { setupVersion: plugin.setupVersion } : {}),
    }));
  }

  getBySurface(surface: ChannelSurface): ChannelPlugin | null {
    return this.pluginsBySurface.get(surface) ?? null;
  }

  get(pluginId: string): ChannelPlugin | null {
    return this.plugins.get(pluginId) ?? null;
  }

  getByPath(pathname: string): ChannelPlugin | null {
    return this.pluginsByPath.get(pathname) ?? null;
  }

  async handleInbound(pathname: string, req: Request): Promise<Response | null> {
    const plugin = this.getByPath(pathname);
    if (!plugin?.handleInbound) return null;
    return plugin.handleInbound(req);
  }

  async deliverReply(surface: ChannelSurface, pending: unknown, message: string): Promise<boolean> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.deliverReply) return false;
    await plugin.deliverReply(pending, message);
    return true;
  }

  async deliverProgress(surface: ChannelSurface, pending: unknown, progress: string): Promise<boolean> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.deliverProgress) return false;
    await plugin.deliverProgress(pending, progress);
    return true;
  }

  async notifyApproval(surface: ChannelSurface, approval: SharedApprovalRecord, binding: AutomationRouteBinding): Promise<boolean> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.notifyApproval) return false;
    await plugin.notifyApproval(approval, binding);
    return true;
  }

  async getRenderPolicy(surface: ChannelSurface): Promise<ChannelRenderPolicy | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.renderPolicy) return null;
    return plugin.renderPolicy();
  }

  async render(surface: ChannelSurface, request: ChannelRenderRequest): Promise<ChannelRenderResult | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return null;
    if (plugin.renderEvent) {
      const result = await plugin.renderEvent(request);
      if (result) return result;
      return { delivered: true, metadata: { surface, pluginId: plugin.id } };
    }
    if (request.phase === 'final' && plugin.deliverReply) {
      await plugin.deliverReply(request.pending, request.text);
      return { delivered: true, metadata: { surface, pluginId: plugin.id, fallback: 'deliverReply' } };
    }
    if (request.phase === 'progress' && plugin.deliverProgress) {
      await plugin.deliverProgress(request.pending, request.text);
      return { delivered: true, metadata: { surface, pluginId: plugin.id, fallback: 'deliverProgress' } };
    }
    return null;
  }

  async getSetupSchema(surface: ChannelSurface, accountId?: string): Promise<ChannelSetupSchema | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.getSetupSchema) return null;
    return plugin.getSetupSchema(accountId);
  }

  async doctor(surface: ChannelSurface, accountId?: string): Promise<ChannelDoctorReport | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.doctor) return null;
    return plugin.doctor(accountId);
  }

  async listRepairActions(surface: ChannelSurface, accountId?: string): Promise<readonly ChannelRepairAction[]> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.listRepairActions) return [];
    return plugin.listRepairActions(accountId);
  }

  async getLifecycleState(surface: ChannelSurface, accountId?: string): Promise<ChannelLifecycleState | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.getLifecycleState) return null;
    return plugin.getLifecycleState(accountId);
  }

  async migrateLifecycle(
    surface: ChannelSurface,
    accountId?: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelLifecycleState | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.migrateLifecycle) return null;
    return plugin.migrateLifecycle(accountId, input);
  }

  async resolveAllowlist(surface: ChannelSurface, input: ChannelAllowlistEditInput): Promise<ChannelAllowlistResolution | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.resolveAllowlist) return null;
    return plugin.resolveAllowlist(input);
  }

  async editAllowlist(surface: ChannelSurface, input: ChannelAllowlistEditInput): Promise<ChannelAllowlistEditResult | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.editAllowlist) return null;
    return plugin.editAllowlist(input);
  }

  async listStatus(): Promise<ChannelStatusSnapshot[]> {
    const snapshots: ChannelStatusSnapshot[] = [];
    for (const plugin of this.list()) {
      if (!plugin.getStatus) continue;
      snapshots.push(await plugin.getStatus());
    }
    return snapshots.sort((a, b) => a.label.localeCompare(b.label));
  }

  async listAccounts(surface?: ChannelSurface): Promise<ChannelAccountRecord[]> {
    const plugins = surface ? [this.getBySurface(surface)].filter((value): value is ChannelPlugin => value !== null) : this.list();
    const accounts: ChannelAccountRecord[] = [];
    for (const plugin of plugins) {
      if (!plugin.listAccounts) continue;
      accounts.push(...await plugin.listAccounts());
    }
    return accounts.sort((a, b) => a.surface.localeCompare(b.surface) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async getAccount(surface: ChannelSurface, accountId: string): Promise<ChannelAccountRecord | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return null;
    if (plugin.getAccount) {
      return plugin.getAccount(accountId);
    }
    if (plugin.listAccounts) {
      const accounts = await plugin.listAccounts();
      return accounts.find((entry) => entry.id === accountId || entry.accountId === accountId) ?? null;
    }
    return null;
  }

  async runAccountAction(
    surface: ChannelSurface,
    action: ChannelAccountLifecycleAction,
    accountId?: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return null;
    if (plugin.runAccountAction) return plugin.runAccountAction(action, accountId, input);
    if (action === 'start' && plugin.startAccount) return plugin.startAccount(accountId, input);
    if (action === 'stop' && plugin.stopAccount) return plugin.stopAccount(accountId, input);
    if ((action === 'login' || action === 'connect') && plugin.loginAccount) return plugin.loginAccount(accountId, input);
    if (action === 'setup' && plugin.loginWithQrStart) return plugin.loginWithQrStart(accountId, input);
    if (action === 'wait_login' && plugin.loginWithQrWait) return plugin.loginWithQrWait(accountId, input);
    if ((action === 'logout' || action === 'disconnect') && plugin.logoutAccount) return plugin.logoutAccount(accountId, input);
    if (action === 'inspect') {
      const account = accountId ? await this.getAccount(surface, accountId) : (await this.listAccounts(surface))[0] ?? null;
      return {
        surface,
        ...(accountId ? { accountId } : account?.accountId ? { accountId: account.accountId } : {}),
        action,
        ok: account !== null,
        ...(account ? { state: account.state, authState: account.authState } : {}),
        account,
        message: account ? 'Account posture inspected.' : 'No matching channel account was found.',
        metadata: {},
      };
    }
    return null;
  }

  async authorizeActorAction(
    surface: ChannelSurface,
    request: ChannelActorAuthorizationRequest,
  ): Promise<ChannelActorAuthorizationResult | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return null;
    if (plugin.authorizeActorAction) return plugin.authorizeActorAction(request);
    if (plugin.getActionAvailabilityState) return plugin.getActionAvailabilityState(request);
    const account = request.accountId ? await this.getAccount(surface, request.accountId) : (await this.listAccounts(surface))[0] ?? null;
    const allowed = Boolean(account?.enabled && account.configured);
    return {
      allowed,
      reason: allowed ? 'Account is configured and enabled.' : 'No configured enabled account is available for this surface.',
      account,
      actionAvailable: allowed,
      metadata: { fallback: true },
    };
  }

  async listCapabilities(surface?: ChannelSurface): Promise<ChannelCapabilityDescriptor[]> {
    const plugins = surface ? [this.getBySurface(surface)].filter((value): value is ChannelPlugin => value !== null) : this.list();
    const capabilities: ChannelCapabilityDescriptor[] = [];
    for (const plugin of plugins) {
      if (!plugin.listCapabilities) continue;
      capabilities.push(...await plugin.listCapabilities());
    }
    return capabilities.sort((a, b) => a.surface.localeCompare(b.surface) || a.scope.localeCompare(b.scope) || a.label.localeCompare(b.label));
  }

  async listTools(surface?: ChannelSurface): Promise<ChannelToolDescriptor[]> {
    const plugins = surface ? [this.getBySurface(surface)].filter((value): value is ChannelPlugin => value !== null) : this.list();
    const tools: ChannelToolDescriptor[] = [];
    for (const plugin of plugins) {
      if (!plugin.listTools) continue;
      tools.push(...await plugin.listTools());
    }
    return tools.sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
  }

  async runTool(
    surface: ChannelSurface,
    toolId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.runTool) return null;
    return plugin.runTool(toolId, input);
  }

  async listOperatorActions(surface?: ChannelSurface): Promise<ChannelOperatorActionDescriptor[]> {
    const plugins = surface ? [this.getBySurface(surface)].filter((value): value is ChannelPlugin => value !== null) : this.list();
    const actions: ChannelOperatorActionDescriptor[] = [];
    for (const plugin of plugins) {
      if (!plugin.listOperatorActions) continue;
      actions.push(...await plugin.listOperatorActions());
    }
    return actions.sort((a, b) => a.surface.localeCompare(b.surface) || a.label.localeCompare(b.label));
  }

  async runOperatorAction(
    surface: ChannelSurface,
    actionId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.runOperatorAction) return null;
    return plugin.runOperatorAction(actionId, input);
  }

  listAgentTools(surface?: ChannelSurface): Tool[] {
    const plugins = surface ? [this.getBySurface(surface)].filter((value): value is ChannelPlugin => value !== null) : this.list();
    const tools: Tool[] = [];
    const seen = new Set<string>();
    for (const plugin of plugins) {
      if (!plugin.listAgentTools) continue;
      for (const tool of plugin.listAgentTools()) {
        if (seen.has(tool.definition.name)) continue;
        seen.add(tool.definition.name);
        tools.push(tool);
      }
    }
    return tools.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  async resolveTarget(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<ChannelResolvedTarget | null> {
    const plugin = this.getBySurface(surface);
    const input = options.input.trim();
    if (!plugin || input.length === 0) return null;
    if (plugin.resolveTarget) {
      const resolved = await plugin.resolveTarget(options);
      if (resolved) return resolved;
    }
    const explicit = plugin.parseExplicitTarget ? await plugin.parseExplicitTarget(input, options) : null;
    if (explicit) return explicit;
    const directory = await this.queryDirectory(surface, {
      query: input,
      limit: 1,
      ...(options.preferredKind === 'direct' ? { scope: 'users' as const } : {}),
      ...(options.preferredKind === 'group' || options.preferredKind === 'channel' ? { scope: 'groups' as const } : {}),
      ...(options.threadId ? { scope: 'threads' as const } : {}),
    });
    const entry = directory[0];
    if (entry) {
      const kind = entry.kind === 'user' || entry.kind === 'self' || entry.kind === 'member'
        ? 'direct'
        : entry.kind === 'thread'
          ? 'thread'
          : entry.kind === 'channel'
            ? 'channel'
            : entry.kind === 'group'
              ? 'group'
              : 'service';
      const target: ChannelResolvedTarget = {
        surface,
        input: options.input,
        normalized: input.toLowerCase(),
        kind,
        to: entry.handle ?? entry.id,
        display: entry.label,
        accountId: entry.accountId ?? options.accountId,
        workspaceId: entry.workspaceId,
        channelId: entry.kind === 'channel' || entry.kind === 'group' ? entry.groupId ?? entry.id : undefined,
        groupId: entry.groupId,
        threadId: options.threadId ?? entry.threadId,
        parentId: entry.parentId,
        directoryEntryId: entry.id,
        source: 'directory',
        sessionTarget: `channel:${surface}:${entry.id}`,
        metadata: { directoryEntry: entry },
      };
      const sessionTarget = plugin.resolveSessionTarget ? await plugin.resolveSessionTarget(target, options) : null;
      return sessionTarget ? { ...target, sessionTarget } : target;
    }
    const inferredKind = plugin.inferTargetConversationKind
      ? await plugin.inferTargetConversationKind(input, options)
      : options.preferredKind ?? 'service';
    if (!options.createIfMissing) {
      return {
        surface,
        input: options.input,
        normalized: input.toLowerCase(),
        kind: inferredKind ?? options.preferredKind ?? 'service',
        to: input,
        accountId: options.accountId,
        threadId: options.threadId,
        sessionTarget: `channel:${surface}:${input.toLowerCase()}`,
        source: 'miss',
        metadata: { fallback: true },
      };
    }
    return {
      surface,
      input: options.input,
      normalized: input.toLowerCase(),
      kind: inferredKind ?? options.preferredKind ?? 'service',
      to: input,
      accountId: options.accountId,
      threadId: options.threadId,
      sessionTarget: `channel:${surface}:${input.toLowerCase()}`,
      source: 'synthetic',
      metadata: { fallback: true },
    };
  }

  async resolveSessionTarget(
    surface: ChannelSurface,
    target: ChannelResolvedTarget,
    options?: ChannelTargetResolveOptions,
  ): Promise<string | null> {
    const plugin = this.getBySurface(surface);
    if (!plugin?.resolveSessionTarget) return target.sessionTarget ?? null;
    return plugin.resolveSessionTarget(target, options);
  }

  async resolveParentConversationCandidates(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<readonly ChannelResolvedTarget[]> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return [];
    if (plugin.resolveParentConversationCandidates) return plugin.resolveParentConversationCandidates(options);
    const resolved = await this.resolveTarget(surface, options);
    return resolved ? [resolved] : [];
  }

  async lookupDirectory(
    surface: ChannelSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<readonly ChannelDirectoryEntry[]> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return [];
    if (plugin.lookupDirectory) return plugin.lookupDirectory(query, options);
    if (plugin.queryDirectory) return plugin.queryDirectory({ ...options, query });
    return [];
  }

  async queryDirectory(
    surface: ChannelSurface,
    options: ChannelDirectoryQueryOptions,
  ): Promise<readonly ChannelDirectoryEntry[]> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return [];
    if (options.scope === 'members' && options.groupId && plugin.listGroupMembers) {
      return plugin.listGroupMembers(options.groupId, options);
    }
    if (plugin.queryDirectory) return plugin.queryDirectory(options);
    if (plugin.lookupDirectory) return plugin.lookupDirectory(options.query ?? '', options);
    return [];
  }

  async listGroupMembers(
    surface: ChannelSurface,
    groupId: string,
    options: ChannelDirectoryQueryOptions = {},
  ): Promise<readonly ChannelDirectoryEntry[]> {
    const plugin = this.getBySurface(surface);
    if (!plugin) return [];
    if (plugin.listGroupMembers) {
      return plugin.listGroupMembers(groupId, options);
    }
    if (plugin.queryDirectory) {
      return plugin.queryDirectory({
        ...options,
        scope: 'members',
        groupId,
      });
    }
    return [];
  }
}
