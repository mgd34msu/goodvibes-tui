import type { JsonRecord } from './route-helpers.ts';

export type DaemonApiClientKind =
  | 'web'
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
  | 'matrix'
  | 'daemon';

export type AutomationRouteBindingKind = string;
export type AutomationSurfaceKind = string;
export type AutomationSessionPolicy = string;
export type AutomationThreadPolicy = string;
export type AutomationDeliveryGuarantee = string;
export type WatcherKind = string;

export interface ConfigManagerLike {
  get(key: string): unknown;
  getAll(): Record<string, unknown>;
  setDynamic(key: string, value: unknown): void;
}

export interface IntegrationApprovalSnapshotSourceLike {
  getApprovalSnapshot(): unknown;
}

export interface PlatformServiceManagerLike {
  status(): Record<string, unknown>;
  install(): unknown;
  start(): unknown;
  stop(): unknown;
  restart(): unknown;
  uninstall(): unknown;
}

export interface RouteBindingRecordInput {
  readonly id?: string;
  readonly kind: AutomationRouteBindingKind;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: AutomationSessionPolicy;
  readonly threadPolicy?: AutomationThreadPolicy;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly sessionId?: string | null;
  readonly jobId?: string | null;
  readonly runId?: string | null;
  readonly title?: string;
  readonly metadata: Record<string, unknown>;
}

export interface RouteBindingPatchInput {
  readonly sessionPolicy?: AutomationSessionPolicy;
  readonly threadPolicy?: AutomationThreadPolicy;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly sessionId?: string | null;
  readonly jobId?: string | null;
  readonly runId?: string | null;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RouteBindingManagerLike {
  listBindings(): readonly unknown[];
  upsertBinding(input: RouteBindingRecordInput): Promise<unknown>;
  patchBinding(bindingId: string, input: RouteBindingPatchInput): Promise<unknown | null>;
  removeBinding(bindingId: string): Promise<boolean>;
}

export interface WatcherSourceRecord {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface WatcherRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: WatcherKind;
  readonly source: WatcherSourceRecord;
  readonly intervalMs?: number;
  readonly metadata: Record<string, unknown>;
}

export interface WatcherRegistryLike {
  list(): readonly unknown[];
  removeWatcher(watcherId: string): boolean;
  registerWatcher(input: {
    readonly id: string;
    readonly label: string;
    readonly kind: WatcherKind;
    readonly source: WatcherSourceRecord;
    readonly intervalMs: number;
    readonly metadata: Record<string, unknown>;
    readonly run?: () => string;
  }): WatcherRecord;
  getWatcher(watcherId: string): WatcherRecord | null;
  startWatcher(watcherId: string): WatcherRecord | null;
  stopWatcher(watcherId: string, reason: string): WatcherRecord | null;
  runWatcherNow(watcherId: string): Promise<WatcherRecord | null>;
}

export interface ApprovalBrokerLike {
  claimApproval(approvalId: string, actor: string, actorSurface: string, note?: string): Promise<unknown | null>;
  cancelApproval(approvalId: string, actor: string, actorSurface: string, note?: string): Promise<unknown | null>;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember: boolean;
      readonly actor: string;
      readonly actorSurface: string;
      readonly note?: string;
    },
  ): Promise<unknown | null>;
}

export interface DaemonSystemRouteContext {
  readonly approvalBroker: ApprovalBrokerLike;
  readonly configManager: ConfigManagerLike;
  readonly integrationHelpers: IntegrationApprovalSnapshotSourceLike | null;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly isValidConfigKey: (key: string) => boolean;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly platformServiceManager: PlatformServiceManagerLike;
  readonly recordApiResponse: (
    req: Request,
    path: string,
    response: Response,
    clientKind?: DaemonApiClientKind,
  ) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly routeBindings: RouteBindingManagerLike;
  readonly watcherRegistry: WatcherRegistryLike;
}
