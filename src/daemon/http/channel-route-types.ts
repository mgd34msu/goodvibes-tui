import type { ChannelConversationKind, ChannelLifecycleAction, JsonRecord } from './route-helpers.ts';

export type ChannelSurface = string;
export type ChannelDirectoryScope = string;

export interface ChannelAgentToolDefinitionLike {
  readonly definition: unknown;
}

export interface ChannelTargetResolutionInput {
  readonly input: string;
  readonly accountId?: string;
  readonly preferredKind?: ChannelConversationKind;
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly createIfMissing?: boolean;
  readonly live?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelAuthorizeActionInput {
  readonly actionId: string;
  readonly actorId?: string;
  readonly accountId?: string;
  readonly target?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelAllowlistInput {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
  readonly groupId?: string;
  readonly channelId?: string;
  readonly workspaceId?: string;
  readonly kind?: 'user' | 'channel' | 'group';
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelDirectoryQuery {
  readonly query: string;
  readonly scope?: ChannelDirectoryScope;
  readonly groupId?: string;
  readonly limit?: number;
  readonly live?: boolean;
}

export interface ChannelPluginServiceLike {
  listAccounts(surface?: ChannelSurface): Promise<readonly unknown[]>;
  getAccount(surface: ChannelSurface, accountId: string): Promise<unknown | null>;
  getSetupSchema(surface: ChannelSurface, accountId?: string): Promise<unknown | null>;
  doctor(surface: ChannelSurface, accountId?: string): Promise<unknown | null>;
  listRepairActions(surface: ChannelSurface, accountId?: string): Promise<readonly unknown[]>;
  getLifecycleState(surface: ChannelSurface, accountId?: string): Promise<unknown | null>;
  migrateLifecycle(
    surface: ChannelSurface,
    accountId?: string,
    input?: JsonRecord | null,
  ): Promise<unknown | null>;
  runAccountAction(
    surface: ChannelSurface,
    action: ChannelLifecycleAction,
    accountId: string | undefined,
    input?: JsonRecord,
  ): Promise<unknown | null>;
  listCapabilities(surface?: ChannelSurface): Promise<readonly unknown[]>;
  listTools(surface?: ChannelSurface): Promise<readonly unknown[]>;
  listAgentTools(surface?: ChannelSurface): readonly ChannelAgentToolDefinitionLike[];
  runTool(surface: ChannelSurface, toolId: string, input?: JsonRecord): Promise<unknown | null>;
  listOperatorActions(surface?: ChannelSurface): Promise<readonly unknown[]>;
  runOperatorAction(surface: ChannelSurface, actionId: string, input?: JsonRecord): Promise<unknown | null>;
  resolveTarget(surface: ChannelSurface, input: ChannelTargetResolutionInput): Promise<unknown | null>;
  authorizeActorAction(surface: ChannelSurface, input: ChannelAuthorizeActionInput): Promise<unknown | null>;
  resolveAllowlist(surface: ChannelSurface, input: ChannelAllowlistInput): Promise<unknown | null>;
  editAllowlist(surface: ChannelSurface, input: ChannelAllowlistInput): Promise<unknown | null>;
  listStatus(): Promise<readonly unknown[]>;
  queryDirectory(surface: ChannelSurface, query: ChannelDirectoryQuery): Promise<readonly unknown[]>;
}

export interface ChannelPolicyServiceLike {
  listPolicies(): readonly unknown[];
  upsertPolicy(surface: ChannelSurface, input: Record<string, unknown>): Promise<unknown>;
  listAudit(limit: number): readonly unknown[];
}

export interface SurfaceRegistryLike {
  list(): readonly unknown[];
}

export interface DaemonChannelRouteContext {
  readonly channelPlugins: ChannelPluginServiceLike;
  readonly channelPolicy: ChannelPolicyServiceLike;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly surfaceRegistry: SurfaceRegistryLike;
}
