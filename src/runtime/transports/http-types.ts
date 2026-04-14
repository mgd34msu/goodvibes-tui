import type {
  ControlPlaneRecentEvent,
  ControlPlaneAuthSnapshot,
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionSubmission,
} from '../../control-plane/index.ts';
import type { SteerSharedSessionMessageInput } from '../../control-plane/index.ts';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '../../providers/runtime-snapshot.ts';
import type {
  TelemetryAggregates,
  TelemetryCapabilities,
  TelemetryFilter,
  TelemetryListResponse,
  TelemetryRecord,
  TelemetryRuntimeSnapshot,
  TelemetrySnapshot,
  TelemetryViewMode,
} from '../telemetry/api.ts';
import type {
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimePairRequest,
  DistributedWorkPriority,
} from '../remote/distributed-runtime-types.ts';
import type { UiControlPlaneSnapshot, UiLocalAuthSnapshot, UiSessionSnapshot, UiTasksSnapshot } from '../ui-read-models.ts';
import type { UiRuntimeEvents } from '../ui-events.ts';
import type { TransportPaths } from './shared.ts';

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly authToken?: string | null;
  readonly fetchImpl?: typeof fetch;
}

export interface HttpProvidersSnapshot {
  readonly providerIds: readonly string[];
  readonly runtimeSnapshots: readonly ProviderRuntimeSnapshot[];
  readonly accountSnapshot: Record<string, unknown>;
  readonly localAuthSnapshot: UiLocalAuthSnapshot;
}

export interface HttpTransportOperatorSnapshot {
  readonly currentSession: UiSessionSnapshot;
  readonly tasks: UiTasksSnapshot;
  readonly approvals: readonly SharedApprovalRecord[];
  readonly sessions: readonly SharedSessionRecord[];
  readonly controlPlane: UiControlPlaneSnapshot;
  readonly providers: HttpProvidersSnapshot;
  readonly shellPaths: TransportPaths;
}

export interface HttpPeerSnapshot {
  readonly capturedAt: number;
  readonly nodeHostContract: DistributedNodeHostContract;
  readonly remoteSnapshot: Record<string, unknown>;
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly peers: readonly DistributedPeerRecord[];
  readonly work: readonly DistributedPendingWork[];
}

export interface HttpTransportSnapshot {
  readonly kind: 'http';
  readonly operator: HttpTransportOperatorSnapshot;
  readonly peer: HttpPeerSnapshot;
}

export interface HttpTransportSessionsClient {
  current(): Promise<UiSessionSnapshot>;
  list(limit?: number): Promise<readonly SharedSessionRecord[]>;
  get(sessionId: string): Promise<SharedSessionRecord | null>;
  messages(sessionId: string, limit?: number): Promise<readonly SharedSessionMessage[]>;
  inputs(sessionId: string, limit?: number): Promise<readonly SharedSessionInputRecord[]>;
  ensureSession(input?: HttpSessionEnsureInput): Promise<SharedSessionRecord>;
  close(sessionId: string): Promise<SharedSessionRecord | null>;
  reopen(sessionId: string): Promise<SharedSessionRecord | null>;
  submitMessage(sessionId: string, input: HttpSessionMessageInput): Promise<SharedSessionSubmission>;
  steerMessage(sessionId: string, input: HttpSteerSessionMessageInput): Promise<SharedSessionSubmission>;
  followUpMessage(sessionId: string, input: HttpSessionMessageInput): Promise<SharedSessionSubmission>;
  cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null>;
}

export interface HttpTransportTasksClient {
  snapshot(): Promise<UiTasksSnapshot>;
  list(limit?: number): Promise<readonly import('../store/domains/tasks.ts').RuntimeTask[]>;
  get(taskId: string): Promise<import('../store/domains/tasks.ts').RuntimeTask | null>;
  running(): Promise<readonly import('../store/domains/tasks.ts').RuntimeTask[]>;
  submit(input: HttpTaskSubmitInput): Promise<HttpTaskSubmitResponse>;
  cancel(taskId: string): Promise<HttpTaskActionResponse>;
  retry(taskId: string): Promise<HttpTaskRetryResponse>;
}

export interface HttpTransportApprovalsClient {
  list(limit?: number): Promise<readonly SharedApprovalRecord[]>;
  get(approvalId: string): Promise<SharedApprovalRecord | null>;
  claim(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  approve(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  deny(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  cancel(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
}

export interface HttpTransportProvidersClient {
  listIds(): Promise<readonly string[]>;
  runtimeSnapshots(): Promise<readonly ProviderRuntimeSnapshot[]>;
  runtimeSnapshot(providerId: string): Promise<ProviderRuntimeSnapshot | null>;
  usageSnapshot(providerId: string): Promise<ProviderUsageSnapshot | null>;
  accountSnapshot(): Promise<Record<string, unknown>>;
  localAuthSnapshot(): Promise<UiLocalAuthSnapshot>;
  snapshot(): Promise<HttpProvidersSnapshot>;
}

export interface HttpTransportControlPlaneClient {
  snapshot(): Promise<UiControlPlaneSnapshot>;
  recentEvents(limit?: number): Promise<readonly ControlPlaneRecentEvent[]>;
  currentAuth(): Promise<HttpTransportControlPlaneAuthSnapshot>;
}

export interface HttpTransportControlPlaneAuthSnapshot extends ControlPlaneAuthSnapshot {}

export interface HttpTransportTelemetryMetricsSnapshot {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly generatedAt: number;
  readonly runtime: TelemetryRuntimeSnapshot;
  readonly sessionMetrics: TelemetrySnapshot['sessionMetrics'];
  readonly aggregates: TelemetryAggregates;
}

export type HttpTransportTelemetryQuery = TelemetryFilter | number;

export interface HttpTransportTelemetryStreamReady {
  readonly version: 1;
  readonly capabilities: TelemetryCapabilities;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly resumedFrom?: string;
}

export interface HttpTransportTelemetryStreamHandlers {
  readonly onRecord: (record: TelemetryRecord) => void;
  readonly onReady?: (payload: HttpTransportTelemetryStreamReady) => void;
}

export interface HttpTransportTelemetryClient {
  snapshot(query?: HttpTransportTelemetryQuery): Promise<TelemetrySnapshot>;
  events(query?: HttpTransportTelemetryQuery): Promise<TelemetryListResponse<TelemetryRecord>>;
  errors(query?: HttpTransportTelemetryQuery): Promise<TelemetryListResponse<TelemetryRecord>>;
  traces(query?: HttpTransportTelemetryQuery): Promise<TelemetryListResponse<import('../telemetry/types.ts').ReadableSpan>>;
  metrics(query?: HttpTransportTelemetryQuery): Promise<HttpTransportTelemetryMetricsSnapshot>;
  otlpTraces(query?: HttpTransportTelemetryQuery): Promise<Record<string, unknown>>;
  otlpLogs(query?: HttpTransportTelemetryQuery): Promise<Record<string, unknown>>;
  otlpMetrics(query?: HttpTransportTelemetryQuery): Promise<Record<string, unknown>>;
  stream(handlers: HttpTransportTelemetryStreamHandlers, query?: HttpTransportTelemetryQuery): Promise<() => void>;
}

export interface HttpTransportOperatorClient {
  readonly sessions: HttpTransportSessionsClient;
  readonly tasks: HttpTransportTasksClient;
  readonly approvals: HttpTransportApprovalsClient;
  readonly providers: HttpTransportProvidersClient;
  readonly controlPlane: HttpTransportControlPlaneClient;
  readonly telemetry: HttpTransportTelemetryClient;
  readonly events: UiRuntimeEvents;
  readonly shellPaths: TransportPaths;
}

export interface HttpTransportPeerPairingClient {
  listRequests(limit?: number): Promise<readonly DistributedRuntimePairRequest[]>;
  request(input: HttpRemotePairRequestInput): Promise<HttpRemotePairResponse>;
  approve(requestId: string, actor: string, note?: string): Promise<HttpRemotePairApprovalResponse | null>;
  reject(requestId: string, actor: string, note?: string): Promise<DistributedRuntimePairRequest | null>;
  verify(requestId: string, challenge: string, remoteAddress?: string): Promise<HttpRemotePairVerificationResponse | null>;
}

export interface HttpTransportPeerPeersClient {
  list(kind?: DistributedPeerKind, limit?: number): Promise<readonly DistributedPeerRecord[]>;
  get(peerId: string): Promise<DistributedPeerRecord | null>;
  getSnapshot(peerId: string): Promise<HttpPeerRecordSnapshot | null>;
  heartbeat(tokenValue: string, input?: HttpRemotePeerHeartbeatInput): Promise<{ peer: DistributedPeerRecord }>;
  rotateToken(peerId: string, actor: string, label?: string, scopes?: readonly string[]): Promise<HttpRemotePeerTokenResponse | null>;
  revokeToken(peerId: string, actor: string, tokenId?: string, note?: string): Promise<DistributedPeerRecord | null>;
  disconnect(peerId: string, actor: string, note?: string, requeueClaimedWork?: boolean): Promise<DistributedPeerRecord | null>;
}

export interface HttpTransportPeerWorkClient {
  list(limit?: number, peerId?: string): Promise<readonly DistributedPendingWork[]>;
  invoke(input: HttpRemotePeerInvokeInput): Promise<HttpRemotePeerInvokeResponse>;
  claim(tokenValue: string, input?: HttpRemotePeerClaimInput): Promise<readonly DistributedPendingWork[]>;
  complete(tokenValue: string, workId: string, input?: HttpRemotePeerCompleteInput): Promise<DistributedPendingWork | null>;
  cancel(workId: string, actor: string, note?: string): Promise<DistributedPendingWork | null>;
}

export interface HttpTransportPeerClient {
  readonly pairing: HttpTransportPeerPairingClient;
  readonly peers: HttpTransportPeerPeersClient;
  readonly work: HttpTransportPeerWorkClient;
  getSnapshot(): Promise<HttpPeerSnapshot>;
  getNodeHostContract(): Promise<DistributedNodeHostContract>;
}

export interface HttpTransport {
  readonly kind: 'http';
  readonly operator: HttpTransportOperatorClient;
  readonly peer: HttpTransportPeerClient;
  getOperatorClient(): HttpTransportOperatorClient;
  getPeerClient(): HttpTransportPeerClient;
  snapshot(): Promise<HttpTransportSnapshot>;
}

export interface HttpSessionEnsureInput {
  readonly sessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly routeId?: string;
  readonly participant?: {
    readonly surfaceKind: string;
    readonly surfaceId: string;
    readonly externalId?: string;
    readonly userId?: string;
    readonly displayName?: string;
  };
}

export interface HttpSessionMessageInput {
  readonly body: string;
  readonly surfaceKind?: string;
  readonly surfaceId?: string;
  readonly externalId?: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly title?: string;
  readonly routeId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly routing?: SteerSharedSessionMessageInput['routing'];
}

export interface HttpSteerSessionMessageInput extends HttpSessionMessageInput {
  readonly allowSpawnFallback?: boolean;
}

export interface HttpTaskSubmitInput {
  readonly task: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly routing?: HttpSessionMessageInput['routing'];
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceKind?: string;
  readonly surfaceId?: string;
  readonly externalId?: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HttpTaskSubmitResponse {
  readonly acknowledged: boolean;
  readonly mode?: string;
  readonly sessionId?: string | null;
  readonly agentId?: string | null;
  readonly status?: string;
  readonly task?: string;
}

export interface HttpTaskActionResponse {
  readonly task: import('../store/domains/tasks.ts').RuntimeTask | null;
}

export interface HttpTaskRetryResponse {
  readonly retried?: boolean;
  readonly task: import('../store/domains/tasks.ts').RuntimeTask | null;
  readonly agentId?: string;
}

export interface HttpRemotePairRequestInput {
  readonly peerKind: DistributedPeerKind;
  readonly label: string;
  readonly requestedId?: string;
  readonly platform?: string;
  readonly deviceFamily?: string;
  readonly version?: string;
  readonly clientMode?: string;
  readonly capabilities?: readonly string[];
  readonly commands?: readonly string[];
  readonly ttlMs?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface HttpRemotePairResponse {
  readonly request: DistributedRuntimePairRequest;
  readonly challenge: string;
}

export interface HttpRemotePairApprovalResponse {
  readonly request: DistributedRuntimePairRequest;
  readonly peer: DistributedPeerRecord;
}

export interface HttpRemotePairVerificationResponse {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord & { readonly value: string };
}

export interface HttpRemotePeerHeartbeatInput {
  readonly capabilities?: readonly string[];
  readonly commands?: readonly string[];
  readonly version?: string;
  readonly clientMode?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HttpRemotePeerTokenResponse {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord & { readonly value: string };
}

export interface HttpRemotePeerInvokeInput {
  readonly peerId: string;
  readonly command: string;
  readonly payload?: unknown;
  readonly priority?: DistributedWorkPriority;
  readonly waitMs?: number;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly automationRunId?: string;
  readonly automationJobId?: string;
  readonly approvalId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HttpRemotePeerInvokeResponse {
  readonly work: DistributedPendingWork;
  readonly completed: boolean;
}

export interface HttpRemotePeerClaimInput {
  readonly maxItems?: number;
  readonly leaseMs?: number;
}

export interface HttpRemotePeerCompleteInput {
  readonly status?: 'completed' | 'failed' | 'cancelled';
  readonly result?: unknown;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HttpPeerRecordSnapshot {
  readonly peerId: string;
  readonly peer: DistributedPeerRecord | null;
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly work: readonly DistributedPendingWork[];
  readonly nodeHostContract: DistributedNodeHostContract;
}
