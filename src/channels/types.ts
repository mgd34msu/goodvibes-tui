/**
 * Shared channel and route-binding contracts for omnichannel control surfaces.
 */

export type ChannelSurface = 'tui' | 'web' | 'slack' | 'discord' | 'ntfy' | 'webhook';
export type ChannelCapability =
  | 'ingress'
  | 'egress'
  | 'threaded_reply'
  | 'interactive_actions'
  | 'session_binding'
  | 'delivery_only'
  | 'account_lifecycle'
  | 'target_resolution'
  | 'agent_tools';
export type ChannelConversationKind = 'direct' | 'group' | 'channel' | 'thread' | 'service';
export type ChannelDirectoryKind = 'self' | 'user' | 'channel' | 'group' | 'thread' | 'member' | 'service';
export type ChannelDirectoryScope = 'all' | 'self' | 'users' | 'peers' | 'groups' | 'channels' | 'threads' | 'services' | 'members';
export type ChannelPolicyMatchScope = 'surface' | 'group';
export type ChannelConversationPolicy = 'allow' | 'deny' | 'inherit';
export type ChannelAccountState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';
export type ChannelAuthState = 'linked' | 'configured' | 'not-configured' | 'degraded';
export type ChannelSecretSource = 'service-registry' | 'config' | 'env' | 'derived' | 'missing';
export type ChannelCapabilityScope = 'surface' | 'accounts' | 'directory' | 'delivery' | 'interaction' | 'tooling';
export type ChannelAccountLifecycleAction =
  | 'inspect'
  | 'setup'
  | 'retest'
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'stop'
  | 'login'
  | 'logout'
  | 'wait_login';
export type ChannelTargetSource = 'explicit' | 'directory' | 'route' | 'normalized' | 'synthetic' | 'miss';

export interface ChannelIdentity {
  surface: ChannelSurface;
  accountId?: string;
  workspaceId?: string;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  userId?: string;
}

export interface ChannelRouteBinding {
  id: string;
  surface: ChannelSurface;
  identity: ChannelIdentity;
  sessionId?: string;
  automationJobId?: string;
  replyTarget?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelAdapterDescriptor {
  id: string;
  surface: ChannelSurface;
  displayName: string;
  capabilities: ChannelCapability[];
}

export interface ChannelDirectoryEntry {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly kind: ChannelDirectoryKind;
  readonly label: string;
  readonly handle?: string;
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly parentId?: string;
  readonly memberCount?: number;
  readonly memberIds?: readonly string[];
  readonly aliases?: readonly string[];
  readonly isSelf?: boolean;
  readonly isDirect?: boolean;
  readonly isGroupConversation?: boolean;
  readonly searchText?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDirectoryQueryOptions {
  readonly query?: string;
  readonly scope?: ChannelDirectoryScope;
  readonly groupId?: string;
  readonly limit?: number;
  readonly live?: boolean;
}

export interface ChannelTargetResolveOptions {
  readonly input: string;
  readonly accountId?: string;
  readonly preferredKind?: ChannelConversationKind;
  readonly threadId?: string;
  readonly createIfMissing?: boolean;
  readonly live?: boolean;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelResolvedTarget {
  readonly surface: ChannelSurface;
  readonly input: string;
  readonly normalized: string;
  readonly kind: ChannelConversationKind;
  readonly to: string;
  readonly display?: string;
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly parentId?: string;
  readonly sessionId?: string;
  readonly sessionTarget?: string;
  readonly bindingId?: string;
  readonly directoryEntryId?: string;
  readonly source: ChannelTargetSource;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelStatusSnapshot {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly state: 'healthy' | 'degraded' | 'disabled';
  readonly enabled: boolean;
  readonly accountId?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelSecretStatus {
  readonly field: string;
  readonly label: string;
  readonly configured: boolean;
  readonly source: ChannelSecretSource;
}

export interface ChannelAccountAction {
  readonly id: string;
  readonly label: string;
  readonly kind: ChannelAccountLifecycleAction;
  readonly available: boolean;
}

export interface ChannelAccountRecord {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly linked: boolean;
  readonly state: ChannelAccountState;
  readonly authState: ChannelAuthState;
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly secrets: readonly ChannelSecretStatus[];
  readonly actions: readonly ChannelAccountAction[];
  readonly metadata: Record<string, unknown>;
}

export interface ChannelCapabilityDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly scope: ChannelCapabilityScope;
  readonly supported: boolean;
  readonly detail: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelToolDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly name: string;
  readonly description: string;
  readonly actionIds: readonly string[];
  readonly inputSchema?: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelOperatorActionDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly description: string;
  readonly dangerous: boolean;
  readonly inputSchema?: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelAccountLifecycleResult {
  readonly surface: ChannelSurface;
  readonly accountId?: string;
  readonly action: ChannelAccountLifecycleAction;
  readonly ok: boolean;
  readonly state?: ChannelAccountState;
  readonly authState?: ChannelAuthState;
  readonly account?: ChannelAccountRecord | null;
  readonly message?: string;
  readonly login?: {
    readonly kind: 'none' | 'browser' | 'qr' | 'manual';
    readonly url?: string;
    readonly qr?: string;
    readonly expiresAt?: number;
    readonly instructions?: string;
  };
  readonly metadata: Record<string, unknown>;
}

export interface ChannelActorAuthorizationRequest {
  readonly actorId?: string;
  readonly actionId: string;
  readonly accountId?: string;
  readonly target?: ChannelResolvedTarget;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelActorAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly account?: ChannelAccountRecord | null;
  readonly actionAvailable?: boolean;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelPolicyRecord {
  readonly surface: ChannelSurface;
  readonly enabled: boolean;
  readonly requireMention: boolean;
  readonly allowDirectMessages: boolean;
  readonly allowGroupMessages: boolean;
  readonly allowThreadMessages: boolean;
  readonly dmPolicy: ChannelConversationPolicy;
  readonly groupPolicy: ChannelConversationPolicy;
  readonly allowTextCommandsWithoutMention: boolean;
  readonly allowlistUserIds: readonly string[];
  readonly allowlistChannelIds: readonly string[];
  readonly allowlistGroupIds: readonly string[];
  readonly allowedCommands: readonly string[];
  readonly groupPolicies: readonly ChannelGroupPolicyRecord[];
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelGroupPolicyRecord {
  readonly id: string;
  readonly label?: string;
  readonly groupId?: string;
  readonly channelId?: string;
  readonly workspaceId?: string;
  readonly requireMention?: boolean;
  readonly allowGroupMessages?: boolean;
  readonly allowThreadMessages?: boolean;
  readonly allowTextCommandsWithoutMention?: boolean;
  readonly allowlistUserIds?: readonly string[];
  readonly allowlistChannelIds?: readonly string[];
  readonly allowlistGroupIds?: readonly string[];
  readonly allowedCommands?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelPolicyAuditRecord {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly createdAt: number;
  readonly allowed: boolean;
  readonly reason: string;
  readonly userId?: string;
  readonly channelId?: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly conversationKind?: ChannelConversationKind;
  readonly matchedGroupPolicyId?: string;
  readonly text?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelIngressPolicyInput {
  readonly surface: ChannelSurface;
  readonly userId?: string;
  readonly channelId?: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly conversationKind?: ChannelConversationKind;
  readonly hasAnyMention?: boolean;
  readonly text?: string;
  readonly mentioned?: boolean;
  readonly controlCommand?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly policy: ChannelPolicyRecord;
  readonly matchedGroupPolicy?: ChannelGroupPolicyRecord;
  readonly matchedScope?: ChannelPolicyMatchScope;
  readonly effectiveRequireMention?: boolean;
  readonly effectiveAllowedCommands?: readonly string[];
}
