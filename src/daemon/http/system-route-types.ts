import type { JsonRecord } from './route-helpers.ts';
import type {
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  WatcherKind,
} from '@pellux/goodvibes-sdk-beta/daemon';

export type {
  ApprovalBrokerLike,
  DaemonApiClientKind,
  DaemonSystemConfigManagerLike as ConfigManagerLike,
  DaemonSystemRouteContext,
  PlatformServiceManagerLike,
  RouteBindingManagerLike,
  WatcherRegistryLike,
} from '@pellux/goodvibes-sdk-beta/daemon';

export interface IntegrationApprovalSnapshotSourceLike {
  getApprovalSnapshot(): unknown;
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
