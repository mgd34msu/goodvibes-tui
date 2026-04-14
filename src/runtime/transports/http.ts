import { getOperatorContract, getPeerContract } from '@pellux/goodvibes-sdk-beta/contracts';
import type { AutomationSurfaceKind } from '../../automation/types.ts';
import type {
  ControlPlaneRecentEvent,
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionSubmission,
} from '../../control-plane/index.ts';
import type { RuntimeTask } from '../store/domains/tasks.ts';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '../../providers/runtime-snapshot.ts';
import type { TelemetryFilter, TelemetryListResponse, TelemetryRecord, TelemetrySnapshot } from '../telemetry/api.ts';
import type { ReadableSpan } from '../telemetry/types.ts';
import type {
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedRuntimePairRequest,
} from '../remote/distributed-runtime-types.ts';
import type {
  UiControlPlaneSnapshot,
  UiLocalAuthSnapshot,
  UiSessionSnapshot,
  UiTasksSnapshot,
} from '../ui-read-models.ts';
import type { UiRuntimeEvents } from '../ui-events.ts';
import { createClientTransport } from './client-transport.ts';
import { createHttpJsonTransport, type HttpJsonTransport } from './http-json-transport.ts';
import {
  appendTelemetryQuery,
  buildSessionEnsureBody,
  buildSessionMessageBody,
  buildSteerSessionMessageBody,
  buildTaskSubmitBody,
  buildTransportUrl,
  connectTelemetryStream,
  createJsonRequestInit,
  normalizeTelemetryQuery,
  readControlPlaneSnapshot,
} from './http-helpers.ts';
import { createOperatorRemoteClient } from './operator-remote-client.ts';
import { createPeerRemoteClient } from './peer-remote-client.ts';
import {
  createEventSourceConnector,
  requestJson,
} from './shared.ts';
import type { TransportPaths } from './transport-paths.ts';
import type {
  HttpPeerRecordSnapshot,
  HttpPeerSnapshot,
  HttpProvidersSnapshot,
  HttpRemotePairApprovalResponse,
  HttpRemotePairRequestInput,
  HttpRemotePairResponse,
  HttpRemotePairVerificationResponse,
  HttpRemotePeerClaimInput,
  HttpRemotePeerCompleteInput,
  HttpRemotePeerHeartbeatInput,
  HttpRemotePeerInvokeInput,
  HttpRemotePeerInvokeResponse,
  HttpRemotePeerTokenResponse,
  HttpSessionEnsureInput,
  HttpSessionMessageInput,
  HttpSteerSessionMessageInput,
  HttpTaskActionResponse,
  HttpTaskRetryResponse,
  HttpTaskSubmitResponse,
  HttpTransport,
  HttpTransportOperatorClient,
  HttpTransportOptions,
  HttpTransportPeerClient,
  HttpTransportSnapshot,
  HttpTransportTelemetryMetricsSnapshot,
  HttpTransportTelemetryQuery,
} from './http-types.ts';
import { createRemoteUiRuntimeEvents } from './ui-runtime-events.ts';

type SdkTelemetryQuery = {
  readonly limit?: number;
  readonly since?: number;
  readonly until?: number;
  readonly domains?: string;
  readonly types?: string;
  readonly severity?: 'debug' | 'error' | 'info' | 'warn';
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly cursor?: string;
  readonly view?: 'raw' | 'safe';
};

interface RemoteSnapshotResponse extends Record<string, unknown> {
  readonly distributed?: {
    readonly pairRequests?: readonly DistributedRuntimePairRequest[];
    readonly peers?: readonly DistributedPeerRecord[];
    readonly work?: readonly DistributedPendingWork[];
  };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    typeof error === 'object'
      && error !== null
      && 'transport' in error
      && typeof (error as { transport?: { readonly status?: number } }).transport?.status === 'number'
      && (error as { transport?: { readonly status?: number } }).transport?.status === 404,
  );
}

async function withNullOnNotFound<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function asContractInput(input: object | undefined): Record<string, unknown> | undefined {
  return input as unknown as Record<string, unknown> | undefined;
}

function normalizeSharedSessionRecord(record: SharedSessionRecord | Record<string, unknown>): SharedSessionRecord {
  const candidate = record as SharedSessionRecord & {
    readonly surfaceKinds?: readonly string[];
    readonly participants?: ReadonlyArray<{
      readonly surfaceKind: string;
      readonly surfaceId: string;
      readonly externalId?: string;
      readonly userId?: string;
      readonly displayName?: string;
      readonly routeId?: string;
      readonly lastSeenAt: number;
    }>;
  };
  return {
    ...candidate,
    surfaceKinds: (candidate.surfaceKinds ?? []) as readonly AutomationSurfaceKind[],
    participants: (candidate.participants ?? []).map((participant) => ({
      ...participant,
      surfaceKind: participant.surfaceKind as AutomationSurfaceKind,
    })),
  } as SharedSessionRecord;
}

function normalizeSharedSessionMessage(
  message: SharedSessionMessage | Record<string, unknown> | null | undefined,
  fallbackInput?: SharedSessionInputRecord,
): SharedSessionMessage {
  if (message && typeof message === 'object') {
    const candidate = message as SharedSessionMessage & { readonly surfaceKind?: string };
    return {
      ...candidate,
      surfaceKind: candidate.surfaceKind as AutomationSurfaceKind | undefined,
    };
  }
  if (!fallbackInput) {
    throw new Error('Shared session submission did not include a message');
  }
  return {
    id: fallbackInput.causationId ?? `msg-${fallbackInput.id}`,
    sessionId: fallbackInput.sessionId,
    role: 'user',
    body: fallbackInput.body,
    createdAt: fallbackInput.createdAt,
    surfaceKind: fallbackInput.surfaceKind,
    surfaceId: fallbackInput.surfaceId,
    routeId: fallbackInput.routeId,
    userId: fallbackInput.userId,
    displayName: fallbackInput.displayName,
    metadata: fallbackInput.metadata,
  };
}

function normalizeSharedSessionInput(record: SharedSessionInputRecord | Record<string, unknown>): SharedSessionInputRecord {
  const candidate = record as SharedSessionInputRecord & { readonly surfaceKind?: string };
  return {
    ...candidate,
    surfaceKind: candidate.surfaceKind as AutomationSurfaceKind | undefined,
  };
}

function normalizeSharedSessionSubmission(record: Record<string, unknown>): SharedSessionSubmission {
  const sessionValue = record.session;
  if (!sessionValue || typeof sessionValue !== 'object') {
    throw new Error('Shared session submission did not include a session');
  }
  const inputValue = record.input;
  if (!inputValue || typeof inputValue !== 'object') {
    throw new Error('Shared session submission did not include an input');
  }
  const session = normalizeSharedSessionRecord(sessionValue as Record<string, unknown>);
  const input = normalizeSharedSessionInput(inputValue as Record<string, unknown>);
  return {
    session,
    userMessage: normalizeSharedSessionMessage(
      (record.message as Record<string, unknown> | null | undefined) ?? (record.userMessage as Record<string, unknown> | null | undefined),
      input,
    ),
    routeBinding: record.routeBinding as SharedSessionSubmission['routeBinding'],
    input,
    intent: input.intent,
    mode: record.mode as SharedSessionSubmission['mode'],
    state: input.state,
    task: typeof record.task === 'string' ? record.task : undefined,
    activeAgentId: typeof record.agentId === 'string'
      ? record.agentId
      : typeof record.activeAgentId === 'string'
        ? record.activeAgentId
        : undefined,
    created: Boolean(record.created),
  };
}

function normalizeTelemetryQueryForSdk(
  query: HttpTransportTelemetryQuery | undefined,
  defaultLimit: number,
): SdkTelemetryQuery {
  const normalized = normalizeTelemetryQuery(query, defaultLimit);
  return {
    ...(normalized.limit !== undefined ? { limit: normalized.limit } : {}),
    ...(normalized.since !== undefined ? { since: normalized.since } : {}),
    ...(normalized.until !== undefined ? { until: normalized.until } : {}),
    ...(normalized.domains?.length ? { domains: normalized.domains.join(',') } : {}),
    ...(normalized.eventTypes?.length ? { types: normalized.eventTypes.join(',') } : {}),
    ...(normalized.severity ? { severity: normalized.severity } : {}),
    ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
    ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
    ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
    ...(normalized.agentId ? { agentId: normalized.agentId } : {}),
    ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
    ...(normalized.cursor ? { cursor: normalized.cursor } : {}),
    ...(normalized.view ? { view: normalized.view } : {}),
  };
}

function createOperatorClient(
  transport: HttpJsonTransport,
  events: UiRuntimeEvents,
): HttpTransportOperatorClient {
  const paths = transport.paths;
  const token = transport.authToken ?? null;
  const fetchImpl = transport.fetchImpl;
  const operatorApi = createOperatorRemoteClient(transport, getOperatorContract());

  return {
    sessions: {
      current: async (): Promise<UiSessionSnapshot> =>
        await requestJson(fetchImpl, buildTransportUrl(paths.controlPlaneUrl, '/api/session'), createJsonRequestInit(token)),
      list: async (limit = 100): Promise<readonly SharedSessionRecord[]> =>
        (await operatorApi.sessions.list({ limit })).sessions.map((entry) => normalizeSharedSessionRecord(entry as unknown as Record<string, unknown>)),
      get: async (sessionId): Promise<SharedSessionRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.get(sessionId));
        return response?.session ? normalizeSharedSessionRecord(response.session as unknown as Record<string, unknown>) : null;
      },
      messages: async (sessionId, limit = 100): Promise<readonly SharedSessionMessage[]> =>
        (await operatorApi.sessions.messages.list(sessionId, { limit })).messages.map((entry) =>
          normalizeSharedSessionMessage(entry as unknown as Record<string, unknown>),
        ),
      inputs: async (sessionId, limit = 100): Promise<readonly SharedSessionInputRecord[]> => {
        const response = await operatorApi.invoke<{ inputs: readonly Record<string, unknown>[] }>('sessions.inputs.list', { sessionId, limit });
        return (response.inputs ?? []).map((entry) => normalizeSharedSessionInput(entry));
      },
      ensureSession: async (input: HttpSessionEnsureInput = {}): Promise<SharedSessionRecord> =>
        normalizeSharedSessionRecord((await operatorApi.sessions.create(buildSessionEnsureBody(input))).session as unknown as Record<string, unknown>),
      close: async (sessionId): Promise<SharedSessionRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.close(sessionId));
        return response?.session ? normalizeSharedSessionRecord(response.session as unknown as Record<string, unknown>) : null;
      },
      reopen: async (sessionId): Promise<SharedSessionRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.reopen(sessionId));
        return response?.session ? normalizeSharedSessionRecord(response.session as unknown as Record<string, unknown>) : null;
      },
      submitMessage: async (sessionId, input): Promise<SharedSessionSubmission> =>
        normalizeSharedSessionSubmission(await operatorApi.invoke<Record<string, unknown>>(
          'sessions.messages.create',
          { sessionId, ...buildSessionMessageBody(input) },
        )),
      steerMessage: async (sessionId, input): Promise<SharedSessionSubmission> =>
        normalizeSharedSessionSubmission(await operatorApi.invoke<Record<string, unknown>>(
          'sessions.steer',
          { sessionId, ...buildSteerSessionMessageBody(input) },
        )),
      followUpMessage: async (sessionId, input): Promise<SharedSessionSubmission> =>
        normalizeSharedSessionSubmission(await operatorApi.invoke<Record<string, unknown>>(
          'sessions.followUp',
          { sessionId, ...buildSessionMessageBody(input) },
        )),
      cancelInput: async (sessionId, inputId): Promise<SharedSessionInputRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.inputs.cancel(sessionId, inputId));
        return response?.input ? normalizeSharedSessionInput(response.input as unknown as Record<string, unknown>) : null;
      },
    },
    tasks: {
      snapshot: async (): Promise<UiTasksSnapshot> => {
        const { tasks } = await operatorApi.tasks.list();
        return { tasks: tasks as unknown as readonly RuntimeTask[] };
      },
      list: async (limit = 100): Promise<readonly RuntimeTask[]> =>
        (await operatorApi.tasks.list({ limit })).tasks as unknown as readonly RuntimeTask[],
      get: async (taskId): Promise<RuntimeTask | null> => {
        const response = await withNullOnNotFound(() => operatorApi.tasks.get(taskId));
        return (response?.task ?? null) as unknown as RuntimeTask | null;
      },
      running: async (): Promise<readonly RuntimeTask[]> =>
        ((await operatorApi.tasks.list()).tasks as unknown as readonly RuntimeTask[]).filter((task) => task.status === 'running'),
      submit: async (input): Promise<HttpTaskSubmitResponse> =>
        await operatorApi.invoke<HttpTaskSubmitResponse>('tasks.create', buildTaskSubmitBody(input)),
      cancel: async (taskId): Promise<HttpTaskActionResponse> =>
        await operatorApi.invoke<HttpTaskActionResponse>('tasks.cancel', { taskId }),
      retry: async (taskId): Promise<HttpTaskRetryResponse> =>
        await operatorApi.invoke<HttpTaskRetryResponse>('tasks.retry', { taskId }),
    },
    approvals: {
      list: async (limit = 100): Promise<readonly SharedApprovalRecord[]> =>
        (await operatorApi.approvals.list({ limit })).approvals as unknown as readonly SharedApprovalRecord[],
      get: async (approvalId): Promise<SharedApprovalRecord | null> => {
        const approvals = await operatorApi.approvals.list({ limit: 200 });
        return ((approvals.approvals as unknown as readonly SharedApprovalRecord[]).find((entry) => entry.id === approvalId) ?? null);
      },
      claim: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.claim',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
      approve: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.approve',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
      deny: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.deny',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
      cancel: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.cancel',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
    },
    providers: {
      listIds: async (): Promise<readonly string[]> =>
        (await operatorApi.providers.list()).providers.map((provider) => provider.providerId),
      runtimeSnapshots: async (): Promise<readonly ProviderRuntimeSnapshot[]> =>
        (await operatorApi.providers.list()).providers as unknown as readonly ProviderRuntimeSnapshot[],
      runtimeSnapshot: async (providerId): Promise<ProviderRuntimeSnapshot | null> =>
        await withNullOnNotFound(() => operatorApi.providers.get(providerId)) as unknown as ProviderRuntimeSnapshot | null,
      usageSnapshot: async (providerId): Promise<ProviderUsageSnapshot | null> =>
        await withNullOnNotFound(() => operatorApi.providers.usage(providerId)) as unknown as ProviderUsageSnapshot | null,
      accountSnapshot: async (): Promise<Record<string, unknown>> =>
        await operatorApi.accounts.snapshot() as Record<string, unknown>,
      localAuthSnapshot: async (): Promise<UiLocalAuthSnapshot> =>
        await operatorApi.localAuth.status() as UiLocalAuthSnapshot,
      snapshot: async (): Promise<HttpProvidersSnapshot> => {
        const [providerResponse, accountSnapshot, localAuthSnapshot] = await Promise.all([
          operatorApi.providers.list(),
          operatorApi.accounts.snapshot(),
          operatorApi.localAuth.status(),
        ]);
        const runtimeSnapshots = providerResponse.providers as unknown as readonly ProviderRuntimeSnapshot[];
        return {
          providerIds: runtimeSnapshots.map((provider: ProviderRuntimeSnapshot) => provider.providerId),
          runtimeSnapshots,
          accountSnapshot,
          localAuthSnapshot: localAuthSnapshot as UiLocalAuthSnapshot,
        };
      },
    },
    controlPlane: {
      snapshot: async (): Promise<UiControlPlaneSnapshot> => await readControlPlaneSnapshot(fetchImpl, paths, token),
      currentAuth: async (): Promise<import('./http-types.ts').HttpTransportControlPlaneAuthSnapshot> =>
        await operatorApi.control.auth.current(),
      recentEvents: async (limit = 6): Promise<readonly ControlPlaneRecentEvent[]> =>
        (await operatorApi.invoke<{ messages: readonly ControlPlaneRecentEvent[] }>('control.messages.list', { limit })).messages ?? [],
    },
    telemetry: {
      snapshot: async (query: HttpTransportTelemetryQuery = 20): Promise<TelemetrySnapshot> =>
        await operatorApi.telemetry.snapshot(normalizeTelemetryQueryForSdk(query, 20)) as unknown as TelemetrySnapshot,
      events: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<TelemetryRecord>> =>
        await operatorApi.telemetry.events(normalizeTelemetryQueryForSdk(query, 100)) as unknown as TelemetryListResponse<TelemetryRecord>,
      errors: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<TelemetryRecord>> =>
        await operatorApi.telemetry.errors(normalizeTelemetryQueryForSdk(query, 100)) as unknown as TelemetryListResponse<TelemetryRecord>,
      traces: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<ReadableSpan>> =>
        await operatorApi.telemetry.traces(normalizeTelemetryQueryForSdk(query, 100)) as unknown as TelemetryListResponse<ReadableSpan>,
      metrics: async (query: HttpTransportTelemetryQuery = 100): Promise<HttpTransportTelemetryMetricsSnapshot> =>
        await operatorApi.telemetry.metrics(normalizeTelemetryQueryForSdk(query, 100)) as unknown as HttpTransportTelemetryMetricsSnapshot,
      otlpTraces: async (query: HttpTransportTelemetryQuery = 100) =>
        await operatorApi.telemetry.otlp.traces(normalizeTelemetryQueryForSdk(query, 100)) as Record<string, unknown>,
      otlpLogs: async (query: HttpTransportTelemetryQuery = 100) =>
        await operatorApi.telemetry.otlp.logs(normalizeTelemetryQueryForSdk(query, 100)) as Record<string, unknown>,
      otlpMetrics: async (query: HttpTransportTelemetryQuery = 100) =>
        await operatorApi.telemetry.otlp.metrics(normalizeTelemetryQueryForSdk(query, 100)) as Record<string, unknown>,
      stream: async (handlers, query: HttpTransportTelemetryQuery = 100) => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryStreamUrl);
        appendTelemetryQuery(url, normalized);
        return await connectTelemetryStream(fetchImpl, url.toString(), token, handlers);
      },
    },
    events,
    shellPaths: paths,
  };
}

function createPeerClient(
  transport: HttpJsonTransport,
): HttpTransportPeerClient {
  const operatorApi = createOperatorRemoteClient(transport, getOperatorContract());
  const peerApi = createPeerRemoteClient(transport, getPeerContract());

  function createPeerTokenClient(tokenValue: string) {
    return createPeerRemoteClient(createHttpJsonTransport({
      baseUrl: transport.baseUrl,
      authToken: tokenValue,
      fetchImpl: transport.fetchImpl,
    }), getPeerContract());
  }

  async function readRemoteSnapshot(): Promise<RemoteSnapshotResponse> {
    return await operatorApi.invoke<RemoteSnapshotResponse>('remote.snapshot');
  }

  async function readNodeHostContractValue(): Promise<DistributedNodeHostContract> {
    return (await operatorApi.invoke<{ contract: DistributedNodeHostContract }>('remote.node_host.contract')).contract;
  }

  async function readPeers(limit = 500): Promise<readonly DistributedPeerRecord[]> {
    return (await operatorApi.invoke<{ peers: readonly DistributedPeerRecord[] }>('remote.peers.list', { limit })).peers ?? [];
  }

  return {
    pairing: {
      listRequests: async (limit = 100): Promise<readonly DistributedRuntimePairRequest[]> =>
        (await operatorApi.invoke<{ requests: readonly DistributedRuntimePairRequest[] }>('remote.pair.requests.list', { limit })).requests ?? [],
      request: async (input): Promise<HttpRemotePairResponse> =>
        await peerApi.invoke<HttpRemotePairResponse>('pair.request', asContractInput(input)),
      approve: async (requestId, actor, note): Promise<HttpRemotePairApprovalResponse | null> =>
        await withNullOnNotFound(() => operatorApi.invoke<HttpRemotePairApprovalResponse>(
          'remote.pair.requests.approve',
          { requestId, actor, ...(note ? { note } : {}) },
        )),
      reject: async (requestId, actor, note): Promise<DistributedRuntimePairRequest | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ request?: DistributedRuntimePairRequest | null }>(
          'remote.pair.requests.reject',
          { requestId, actor, ...(note ? { note } : {}) },
        ));
        return response?.request ?? null;
      },
      verify: async (requestId, challenge, remoteAddress): Promise<HttpRemotePairVerificationResponse | null> =>
        await withNullOnNotFound(() => peerApi.invoke<HttpRemotePairVerificationResponse>(
          'pair.verify',
          { requestId, challenge, ...(remoteAddress ? { remoteAddress } : {}) },
        )),
    },
    peers: {
      list: async (kind?: DistributedPeerKind, limit = 200): Promise<readonly DistributedPeerRecord[]> =>
        (await operatorApi.invoke<{ peers: readonly DistributedPeerRecord[] }>('remote.peers.list', {
          ...(kind ? { kind } : {}),
          limit,
        })).peers ?? [],
      get: async (peerId): Promise<DistributedPeerRecord | null> => {
        const response = await operatorApi.invoke<{ peers: readonly DistributedPeerRecord[] }>('remote.peers.list', { limit: 500 });
        return (response.peers ?? []).find((peer) => peer.id === peerId) ?? null;
      },
      getSnapshot: async (peerId): Promise<HttpPeerRecordSnapshot | null> => {
        const [snapshot, contract, peers] = await Promise.all([
          readRemoteSnapshot(),
          readNodeHostContractValue(),
          readPeers(),
        ]);
        const pairRequests = (snapshot.distributed?.pairRequests ?? []).filter((entry) => entry.peerId === peerId || entry.requestedId === peerId);
        const work = (snapshot.distributed?.work ?? []).filter((entry) => entry.peerId === peerId);
        const peer = peers.find((entry) => entry.id === peerId) ?? null;
        if (!peer && pairRequests.length === 0 && work.length === 0) {
          return null;
        }
        return {
          peerId,
          peer,
          pairRequests,
          work,
          nodeHostContract: contract,
        };
      },
      heartbeat: async (tokenValue, input = {}): Promise<{ peer: DistributedPeerRecord }> =>
        await createPeerTokenClient(tokenValue).invoke<{ peer: DistributedPeerRecord }>('peer.heartbeat', asContractInput(input)),
      rotateToken: async (peerId, actor, label, scopes): Promise<HttpRemotePeerTokenResponse | null> =>
        await withNullOnNotFound(() => operatorApi.invoke<HttpRemotePeerTokenResponse>(
          'remote.peers.token.rotate',
          {
            peerId,
            actor,
            ...(label ? { label } : {}),
            ...(scopes ? { scopes } : {}),
          },
        )),
      revokeToken: async (peerId, actor, tokenId, note): Promise<DistributedPeerRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ peer?: DistributedPeerRecord | null }>(
          'remote.peers.token.revoke',
          {
            peerId,
            actor,
            ...(tokenId ? { tokenId } : {}),
            ...(note ? { note } : {}),
          },
        ));
        return response?.peer ?? null;
      },
      disconnect: async (peerId, actor, note, requeueClaimedWork = true): Promise<DistributedPeerRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ peer?: DistributedPeerRecord | null }>(
          'remote.peers.disconnect',
          {
            peerId,
            actor,
            ...(note ? { note } : {}),
            requeueClaimedWork,
          },
        ));
        return response?.peer ?? null;
      },
    },
    work: {
      list: async (limit = 200, peerId?: string): Promise<readonly DistributedPendingWork[]> =>
        (await operatorApi.invoke<{ work: readonly DistributedPendingWork[] }>('remote.work.list', {
          ...(peerId ? { peerId } : {}),
          limit,
        })).work ?? [],
      invoke: async (input): Promise<HttpRemotePeerInvokeResponse> =>
        await operatorApi.invoke<HttpRemotePeerInvokeResponse>('remote.peers.invoke', asContractInput(input)),
      claim: async (tokenValue, input = {}): Promise<readonly DistributedPendingWork[]> =>
        (await createPeerTokenClient(tokenValue).invoke<{ work: readonly DistributedPendingWork[] }>('work.pull', asContractInput(input))).work ?? [],
      complete: async (tokenValue, workId, input = {}): Promise<DistributedPendingWork | null> => {
        const response = await withNullOnNotFound(() => createPeerTokenClient(tokenValue).invoke<{ work?: DistributedPendingWork | null }>(
          'work.complete',
          { workId, ...(input as object) },
        ));
        return response?.work ?? null;
      },
      cancel: async (workId, actor, note): Promise<DistributedPendingWork | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ work?: DistributedPendingWork | null }>(
          'remote.work.cancel',
          {
            workId,
            actor,
            ...(note ? { reason: note } : {}),
          },
        ));
        return response?.work ?? null;
      },
    },
    getSnapshot: async (): Promise<HttpPeerSnapshot> => {
      const [remoteSnapshot, contract, peers] = await Promise.all([
        readRemoteSnapshot(),
        readNodeHostContractValue(),
        readPeers(),
      ]);
      return {
        capturedAt: Date.now(),
        nodeHostContract: contract,
        remoteSnapshot,
        pairRequests: remoteSnapshot.distributed?.pairRequests ?? [],
        peers,
        work: remoteSnapshot.distributed?.work ?? [],
      };
    },
    getNodeHostContract: async (): Promise<DistributedNodeHostContract> => await readNodeHostContractValue(),
  };
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const httpClient = createHttpJsonTransport({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    fetchImpl: options.fetchImpl,
  });
  const fetchImpl = httpClient.fetchImpl;
  const paths = httpClient.paths;
  const events = createRemoteUiRuntimeEvents(createEventSourceConnector(httpClient.baseUrl, options.authToken, fetchImpl));
  const operator = createOperatorClient(httpClient, events);
  const peer = createPeerClient(httpClient);
  const transport = createClientTransport('http', operator, peer);

  return Object.freeze({
    ...transport,
    async snapshot(): Promise<HttpTransportSnapshot> {
      const [currentSession, tasks, approvals, sessions, controlPlane, providers, remoteSnapshot, nodeHostContract, peerSnapshot] = await Promise.all([
        operator.sessions.current(),
        operator.tasks.snapshot(),
        operator.approvals.list(),
        operator.sessions.list(),
        operator.controlPlane.snapshot(),
        operator.providers.snapshot(),
        requestJson<Record<string, unknown>>(fetchImpl, paths.remoteUrl, createJsonRequestInit(options.authToken)),
        peer.getNodeHostContract(),
        peer.getSnapshot(),
      ]);
      return {
        kind: 'http',
        operator: {
          currentSession,
          tasks,
          approvals,
          sessions,
          controlPlane,
          providers,
          shellPaths: paths,
        },
        peer: {
          ...peerSnapshot,
          nodeHostContract,
          remoteSnapshot,
        },
      };
    },
  });
}
