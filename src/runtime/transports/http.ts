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
import type { TelemetryFilter, TelemetryListResponse, TelemetrySnapshot } from '../telemetry/api.ts';
import type { ReadableSpan } from '../telemetry/types.ts';
import type { DistributedNodeHostContract, DistributedPendingWork, DistributedPeerKind, DistributedPeerRecord, DistributedRuntimePairRequest } from '../remote/distributed-runtime-types.ts';
import type { ControlPlaneClientRecord } from '../store/domains/control-plane.ts';
import type { UiLocalAuthSnapshot, UiSessionSnapshot, UiTasksSnapshot, UiControlPlaneSnapshot } from '../ui-read-models.ts';
import type { UiRuntimeEvents } from '../ui-events.ts';
import { createClientTransport } from './client-transport.ts';
import { createHttpJsonTransport } from './http-json-transport.ts';
import type { TransportPaths } from './transport-paths.ts';
import {
  createEventSourceConnector,
  requestJson,
} from './shared.ts';
import { createRemoteUiRuntimeEvents } from './ui-runtime-events.ts';
import {
  appendTelemetryQuery,
  buildSessionEnsureBody,
  buildSessionMessageBody,
  buildSteerSessionMessageBody,
  buildTaskSubmitBody,
  buildTransportUrl,
  connectTelemetryStream,
  createFetch,
  createJsonRequestInit,
  isRecord,
  maybeList,
  normalizeTelemetryQuery,
  readArrayResponse,
  readControlPlaneSnapshot,
  readNodeHostContract,
  requestJsonWithFallback,
} from './http-helpers.ts';
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
  HttpTaskSubmitInput,
  HttpTaskSubmitResponse,
  HttpTransport,
  HttpTransportOperatorClient,
  HttpTransportPeerClient,
  HttpTransportSnapshot,
  HttpTransportTelemetryMetricsSnapshot,
  HttpTransportOptions,
  HttpTransportTelemetryQuery,
  HttpTransportTelemetryStreamHandlers,
} from './http-types.ts';

function createOperatorClient(
  paths: TransportPaths,
  token: string | null | undefined,
  fetchImpl: typeof fetch,
  events: UiRuntimeEvents,
): HttpTransportOperatorClient {
  return {
    sessions: {
      current: async (): Promise<UiSessionSnapshot> => await requestJson(fetchImpl, buildTransportUrl(paths.controlPlaneUrl, '/api/session'), createJsonRequestInit(token)),
      list: async (): Promise<readonly SharedSessionRecord[]> => {
        const body = await requestJson<readonly SharedSessionRecord[] | { sessions?: SharedSessionRecord[] } | { session?: SharedSessionRecord[] }>(fetchImpl, paths.sessionsUrl, createJsonRequestInit(token));
        return readArrayResponse<SharedSessionRecord>(body, 'sessions').length > 0
          ? readArrayResponse<SharedSessionRecord>(body, 'sessions')
          : readArrayResponse<SharedSessionRecord>(body, 'session');
      },
      get: async (sessionId): Promise<SharedSessionRecord | null> => {
        const body = await requestJsonWithFallback<{ session?: SharedSessionRecord }>(
          fetchImpl,
          buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}`),
          createJsonRequestInit(token),
        );
        return body?.session ?? null;
      },
      messages: async (sessionId, limit = 100): Promise<readonly SharedSessionMessage[]> => {
        const url = new URL(buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/messages`));
        url.searchParams.set('limit', String(Math.max(1, Math.floor(limit))));
        const body = await requestJson<readonly SharedSessionMessage[] | { messages?: SharedSessionMessage[] }>(fetchImpl, url.toString(), createJsonRequestInit(token));
        return readArrayResponse<SharedSessionMessage>(body, 'messages');
      },
      inputs: async (sessionId, limit = 100): Promise<readonly SharedSessionInputRecord[]> => {
        const url = new URL(buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/inputs`));
        url.searchParams.set('limit', String(Math.max(1, Math.floor(limit))));
        const body = await requestJson<readonly SharedSessionInputRecord[] | { inputs?: SharedSessionInputRecord[] }>(fetchImpl, url.toString(), createJsonRequestInit(token));
        return readArrayResponse<SharedSessionInputRecord>(body, 'inputs');
      },
      ensureSession: async (input: HttpSessionEnsureInput = {}): Promise<SharedSessionRecord> => {
        const body = await requestJson<{ session: SharedSessionRecord }>(fetchImpl, paths.sessionsUrl, createJsonRequestInit(token, buildSessionEnsureBody(input), 'POST'));
        return body.session;
      },
      close: async (sessionId): Promise<SharedSessionRecord | null> => {
        const body = await requestJsonWithFallback<{ session?: SharedSessionRecord } | { session: SharedSessionRecord }>(fetchImpl, buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/close`), createJsonRequestInit(token, {}, 'POST'));
        return body ? ('session' in body ? body.session ?? null : null) : null;
      },
      reopen: async (sessionId): Promise<SharedSessionRecord | null> => {
        const body = await requestJsonWithFallback<{ session?: SharedSessionRecord } | { session: SharedSessionRecord }>(fetchImpl, buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/reopen`), createJsonRequestInit(token, {}, 'POST'));
        return body ? ('session' in body ? body.session ?? null : null) : null;
      },
      submitMessage: async (sessionId, input): Promise<SharedSessionSubmission> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/messages`),
        createJsonRequestInit(token, buildSessionMessageBody(input), 'POST'),
      ),
      steerMessage: async (sessionId, input): Promise<SharedSessionSubmission> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/steer`),
        createJsonRequestInit(token, buildSteerSessionMessageBody(input), 'POST'),
      ),
      followUpMessage: async (sessionId, input): Promise<SharedSessionSubmission> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/follow-up`),
        createJsonRequestInit(token, buildSessionMessageBody(input), 'POST'),
      ),
      cancelInput: async (sessionId, inputId): Promise<SharedSessionInputRecord | null> => await requestJsonWithFallback<{ input?: SharedSessionInputRecord } | SharedSessionInputRecord>(
        fetchImpl,
        buildTransportUrl(paths.sessionsUrl, `${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(inputId)}/cancel`),
        createJsonRequestInit(token, {}, 'POST'),
      ).then((body) => {
        if (!body) return null;
        if (isRecord(body) && 'input' in body) {
          return (body.input as SharedSessionInputRecord | undefined) ?? null;
        }
        return body as SharedSessionInputRecord;
      }),
    },
    tasks: {
      snapshot: async (): Promise<UiTasksSnapshot> => {
        const body = await requestJson<UiTasksSnapshot | { tasks?: RuntimeTask[] }>(fetchImpl, paths.tasksUrl, createJsonRequestInit(token));
        const tasks = isRecord(body) && Array.isArray(body.tasks) ? body.tasks as readonly RuntimeTask[] : [];
        return Array.isArray((body as UiTasksSnapshot).tasks) ? body as UiTasksSnapshot : { tasks };
      },
      list: async (limit = 100): Promise<readonly RuntimeTask[]> => {
        const snapshot = await requestJson<UiTasksSnapshot | { tasks?: RuntimeTask[] }>(fetchImpl, paths.tasksUrl, createJsonRequestInit(token));
        const tasks = isRecord(snapshot) && Array.isArray(snapshot.tasks) ? snapshot.tasks as readonly RuntimeTask[] : [];
        return tasks.slice(0, Math.max(1, Math.floor(limit)));
      },
      get: async (taskId): Promise<RuntimeTask | null> => await requestJsonWithFallback<{ task?: RuntimeTask } | { task: RuntimeTask }>(fetchImpl, buildTransportUrl(paths.tasksUrl, `${encodeURIComponent(taskId)}`), createJsonRequestInit(token)).then((body) => body ? ('task' in body ? body.task ?? null : null) : null),
      running: async (): Promise<readonly RuntimeTask[]> => {
        const snapshot = await requestJson<UiTasksSnapshot | { tasks?: RuntimeTask[] }>(fetchImpl, paths.tasksUrl, createJsonRequestInit(token));
        const tasks = isRecord(snapshot) && Array.isArray(snapshot.tasks) ? snapshot.tasks as readonly RuntimeTask[] : [];
        return tasks.filter((task) => task.status === 'running');
      },
      submit: async (input): Promise<HttpTaskSubmitResponse> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.baseUrl, '/task'),
        createJsonRequestInit(token, buildTaskSubmitBody(input), 'POST'),
      ),
      cancel: async (taskId): Promise<HttpTaskActionResponse> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.tasksUrl, `${encodeURIComponent(taskId)}/cancel`),
        createJsonRequestInit(token, {}, 'POST'),
      ),
      retry: async (taskId): Promise<HttpTaskRetryResponse> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.tasksUrl, `${encodeURIComponent(taskId)}/retry`),
        createJsonRequestInit(token, {}, 'POST'),
      ),
    },
    approvals: {
      list: async (limit = 100): Promise<readonly SharedApprovalRecord[]> => {
        const url = new URL(paths.approvalsUrl);
        url.searchParams.set('limit', String(Math.max(1, Math.floor(limit))));
        const body = await requestJson<readonly SharedApprovalRecord[] | { approvals?: SharedApprovalRecord[] }>(fetchImpl, url.toString(), createJsonRequestInit(token));
        return readArrayResponse<SharedApprovalRecord>(body, 'approvals');
      },
      get: async (approvalId): Promise<SharedApprovalRecord | null> => {
        const approvals = await requestJson<readonly SharedApprovalRecord[] | { approvals?: SharedApprovalRecord[] }>(fetchImpl, paths.approvalsUrl, createJsonRequestInit(token));
        const list = readArrayResponse<SharedApprovalRecord>(approvals, 'approvals');
        return list.find((entry) => entry.id === approvalId) ?? null;
      },
      claim: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => await requestJsonWithFallback<{ approval?: SharedApprovalRecord } | { approval: SharedApprovalRecord }>(fetchImpl, buildTransportUrl(paths.approvalsUrl, `${encodeURIComponent(approvalId)}/claim`), createJsonRequestInit(token, { actor, actorSurface, note }, 'POST')).then((body) => body ? ('approval' in body ? body.approval ?? null : null) : null),
      approve: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => await requestJsonWithFallback<{ approval?: SharedApprovalRecord } | { approval: SharedApprovalRecord }>(fetchImpl, buildTransportUrl(paths.approvalsUrl, `${encodeURIComponent(approvalId)}/approve`), createJsonRequestInit(token, { actor, actorSurface, note }, 'POST')).then((body) => body ? ('approval' in body ? body.approval ?? null : null) : null),
      deny: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => await requestJsonWithFallback<{ approval?: SharedApprovalRecord } | { approval: SharedApprovalRecord }>(fetchImpl, buildTransportUrl(paths.approvalsUrl, `${encodeURIComponent(approvalId)}/deny`), createJsonRequestInit(token, { actor, actorSurface, note }, 'POST')).then((body) => body ? ('approval' in body ? body.approval ?? null : null) : null),
      cancel: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => await requestJsonWithFallback<{ approval?: SharedApprovalRecord } | { approval: SharedApprovalRecord }>(fetchImpl, buildTransportUrl(paths.approvalsUrl, `${encodeURIComponent(approvalId)}/cancel`), createJsonRequestInit(token, { actor, actorSurface, note }, 'POST')).then((body) => body ? ('approval' in body ? body.approval ?? null : null) : null),
    },
    providers: {
      listIds: async (): Promise<readonly string[]> => {
        const body = await requestJson<{ providers?: Array<{ id: string }> }>(fetchImpl, paths.providersUrl, createJsonRequestInit(token));
        return (body.providers ?? []).map((provider) => provider.id);
      },
      runtimeSnapshots: async (): Promise<readonly ProviderRuntimeSnapshot[]> => {
        const body = await requestJson<readonly ProviderRuntimeSnapshot[] | { providers?: ProviderRuntimeSnapshot[] }>(fetchImpl, paths.providersUrl, createJsonRequestInit(token));
        return readArrayResponse<ProviderRuntimeSnapshot>(body, 'providers');
      },
      runtimeSnapshot: async (providerId): Promise<ProviderRuntimeSnapshot | null> => {
        const body = await requestJsonWithFallback<ProviderRuntimeSnapshot>(fetchImpl, buildTransportUrl(paths.providersUrl, `${encodeURIComponent(providerId)}`), createJsonRequestInit(token));
        return body ?? null;
      },
      usageSnapshot: async (providerId): Promise<ProviderUsageSnapshot | null> => {
        const body = await requestJsonWithFallback<ProviderUsageSnapshot>(fetchImpl, buildTransportUrl(paths.providersUrl, `${encodeURIComponent(providerId)}/usage`), createJsonRequestInit(token));
        return body ?? null;
      },
      accountSnapshot: async (): Promise<Record<string, unknown>> => await requestJson<Record<string, unknown>>(fetchImpl, paths.accountsUrl, createJsonRequestInit(token)),
      localAuthSnapshot: async (): Promise<UiLocalAuthSnapshot> => await requestJson<UiLocalAuthSnapshot>(fetchImpl, paths.localAuthUrl, createJsonRequestInit(token)),
      snapshot: async (): Promise<HttpProvidersSnapshot> => {
        const [providerResponse, accountSnapshot, localAuthSnapshot] = await Promise.all([
          requestJson<readonly ProviderRuntimeSnapshot[] | { providers?: ProviderRuntimeSnapshot[] }>(fetchImpl, paths.providersUrl, createJsonRequestInit(token)),
          requestJson<Record<string, unknown>>(fetchImpl, paths.accountsUrl, createJsonRequestInit(token)),
          requestJson<UiLocalAuthSnapshot>(fetchImpl, paths.localAuthUrl, createJsonRequestInit(token)),
        ]);
        const runtimeSnapshots = readArrayResponse<ProviderRuntimeSnapshot>(providerResponse, 'providers');
        return {
          providerIds: runtimeSnapshots.map((provider: ProviderRuntimeSnapshot) => provider.providerId).filter((value: string): value is string => typeof value === 'string'),
          runtimeSnapshots,
          accountSnapshot,
          localAuthSnapshot,
        };
      },
    },
    controlPlane: {
      snapshot: async (): Promise<UiControlPlaneSnapshot> => await readControlPlaneSnapshot(fetchImpl, paths, token),
      currentAuth: async (): Promise<import('./http-types.ts').HttpTransportControlPlaneAuthSnapshot> => await requestJson<import('./http-types.ts').HttpTransportControlPlaneAuthSnapshot>(fetchImpl, paths.controlPlaneAuthUrl, createJsonRequestInit(token)),
      recentEvents: async (limit = 6): Promise<readonly ControlPlaneRecentEvent[]> => {
        const url = new URL(paths.controlPlaneUrl + '/recent-events');
        url.searchParams.set('limit', String(Math.max(1, Math.floor(limit))));
        const body = await requestJson<readonly ControlPlaneRecentEvent[] | { events?: ControlPlaneRecentEvent[] }>(fetchImpl, url.toString(), createJsonRequestInit(token));
        return readArrayResponse<ControlPlaneRecentEvent>(body, 'events');
      },
    },
    telemetry: {
      snapshot: async (query: HttpTransportTelemetryQuery = 20): Promise<TelemetrySnapshot> => {
        const normalized = normalizeTelemetryQuery(query, 20);
        const url = new URL(paths.telemetryUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<TelemetrySnapshot>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      events: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<import('../telemetry/api.ts').TelemetryRecord>> => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryEventsUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<TelemetryListResponse<import('../telemetry/api.ts').TelemetryRecord>>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      errors: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<import('../telemetry/api.ts').TelemetryRecord>> => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryErrorsUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<TelemetryListResponse<import('../telemetry/api.ts').TelemetryRecord>>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      traces: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<ReadableSpan>> => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryTracesUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<TelemetryListResponse<ReadableSpan>>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      metrics: async (query: HttpTransportTelemetryQuery = 100): Promise<HttpTransportTelemetryMetricsSnapshot> => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryMetricsUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<HttpTransportTelemetryMetricsSnapshot>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      otlpTraces: async (query: HttpTransportTelemetryQuery = 100) => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryOtlpTracesUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<Record<string, unknown>>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      otlpLogs: async (query: HttpTransportTelemetryQuery = 100) => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryOtlpLogsUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<Record<string, unknown>>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
      otlpMetrics: async (query: HttpTransportTelemetryQuery = 100) => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryOtlpMetricsUrl);
        appendTelemetryQuery(url, normalized);
        return await requestJson<Record<string, unknown>>(fetchImpl, url.toString(), createJsonRequestInit(token));
      },
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
  paths: TransportPaths,
  token: string | null | undefined,
  fetchImpl: typeof fetch,
): HttpTransportPeerClient {
  return {
    pairing: {
      listRequests: async (limit = 100): Promise<readonly DistributedRuntimePairRequest[]> => {
        const body = await requestJson<readonly DistributedRuntimePairRequest[] | { requests?: DistributedRuntimePairRequest[] }>(fetchImpl, paths.peerRequestsUrl, createJsonRequestInit(token));
        const requests = readArrayResponse<DistributedRuntimePairRequest>(body, 'requests');
        return requests.slice(0, Math.max(1, Math.floor(limit)));
      },
      request: async (input): Promise<HttpRemotePairResponse> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.baseUrl, '/api/remote/pair/request'),
        createJsonRequestInit(token, input, 'POST'),
      ),
      approve: async (requestId, actor, note): Promise<HttpRemotePairApprovalResponse | null> => await requestJsonWithFallback<HttpRemotePairApprovalResponse>(fetchImpl, buildTransportUrl(paths.baseUrl, `/api/remote/pair/requests/${encodeURIComponent(requestId)}/approve`), createJsonRequestInit(token, { actor, note }, 'POST')).then((body) => body ?? null),
      reject: async (requestId, actor, note): Promise<DistributedRuntimePairRequest | null> => await requestJsonWithFallback<DistributedRuntimePairRequest>(fetchImpl, buildTransportUrl(paths.baseUrl, `/api/remote/pair/requests/${encodeURIComponent(requestId)}/reject`), createJsonRequestInit(token, { actor, note }, 'POST')).then((body) => body ?? null),
      verify: async (requestId, challenge, remoteAddress): Promise<HttpRemotePairVerificationResponse | null> => await requestJsonWithFallback<HttpRemotePairVerificationResponse>(fetchImpl, buildTransportUrl(paths.baseUrl, '/api/remote/pair/verify'), createJsonRequestInit(token, {
        requestId,
        challenge,
        ...(remoteAddress ? { remoteAddress } : {}),
      }, 'POST')).then((body) => body ?? null),
    },
    peers: {
      list: async (kind?: DistributedPeerKind, limit = 200): Promise<readonly DistributedPeerRecord[]> => {
        const url = new URL(paths.peerListUrl);
        if (kind) url.searchParams.set('kind', kind);
        url.searchParams.set('limit', String(Math.max(1, Math.floor(limit))));
        const body = await requestJson<readonly DistributedPeerRecord[] | { peers?: DistributedPeerRecord[] }>(fetchImpl, url.toString(), createJsonRequestInit(token));
        const peers = readArrayResponse<DistributedPeerRecord>(body, 'peers');
        return peers.slice(0, Math.max(1, Math.floor(limit)));
      },
      get: async (peerId): Promise<DistributedPeerRecord | null> => {
        const peers = await requestJson<readonly DistributedPeerRecord[] | { peers?: DistributedPeerRecord[] }>(fetchImpl, paths.peerListUrl, createJsonRequestInit(token));
        const list = readArrayResponse<DistributedPeerRecord>(peers, 'peers');
        return list.find((peer) => peer.id === peerId) ?? null;
      },
      getSnapshot: async (peerId): Promise<HttpPeerRecordSnapshot | null> => {
        const [snapshot, contract] = await Promise.all([
          requestJson<Record<string, unknown>>(fetchImpl, paths.remoteUrl, createJsonRequestInit(token)),
          requestJson<DistributedNodeHostContract>(fetchImpl, paths.remoteContractUrl, createJsonRequestInit(token)),
        ]);
        const peers = await requestJson<readonly DistributedPeerRecord[] | { peers?: DistributedPeerRecord[] }>(fetchImpl, paths.peerListUrl, createJsonRequestInit(token));
        const list = readArrayResponse<DistributedPeerRecord>(peers, 'peers');
        const pairRequests = maybeList<DistributedRuntimePairRequest>(snapshot, 'pairRequests').filter((entry) => entry.peerId === peerId || entry.requestedId === peerId);
        const work = maybeList<DistributedPendingWork>(snapshot, 'work').filter((entry) => entry.peerId === peerId);
        const peer = list.find((entry) => entry.id === peerId) ?? null;
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
      heartbeat: async (tokenValue, input = {}): Promise<{ peer: DistributedPeerRecord }> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.baseUrl, '/api/remote/heartbeat'),
        createJsonRequestInit(tokenValue, input, 'POST'),
      ),
      rotateToken: async (peerId, actor, label, scopes): Promise<HttpRemotePeerTokenResponse | null> => await requestJsonWithFallback<HttpRemotePeerTokenResponse>(fetchImpl, buildTransportUrl(paths.peerListUrl, `${encodeURIComponent(peerId)}/token/rotate`), createJsonRequestInit(token, {
        actor,
        ...(label ? { label } : {}),
        ...(scopes ? { scopes } : {}),
      }, 'POST')).then((body) => body ?? null),
      revokeToken: async (peerId, actor, tokenId, note): Promise<DistributedPeerRecord | null> => await requestJsonWithFallback<DistributedPeerRecord>(fetchImpl, buildTransportUrl(paths.peerListUrl, `${encodeURIComponent(peerId)}/token/revoke`), createJsonRequestInit(token, {
        actor,
        ...(tokenId ? { tokenId } : {}),
        ...(note ? { note } : {}),
      }, 'POST')).then((body) => body ?? null),
      disconnect: async (peerId, actor, note, requeueClaimedWork = true): Promise<DistributedPeerRecord | null> => await requestJsonWithFallback<DistributedPeerRecord>(fetchImpl, buildTransportUrl(paths.peerListUrl, `${encodeURIComponent(peerId)}/disconnect`), createJsonRequestInit(token, {
        actor,
        ...(note ? { note } : {}),
        requeueClaimedWork,
      }, 'POST')).then((body) => body ?? null),
    },
    work: {
      list: async (limit = 200, peerId?: string): Promise<readonly DistributedPendingWork[]> => {
        const body = await requestJson<readonly DistributedPendingWork[] | { work?: DistributedPendingWork[] }>(fetchImpl, paths.remoteWorkUrl, createJsonRequestInit(token));
        const work = readArrayResponse<DistributedPendingWork>(body, 'work');
        const filtered = peerId ? work.filter((entry) => entry.peerId === peerId) : work;
        return filtered.slice(0, Math.max(1, Math.floor(limit)));
      },
      invoke: async (input): Promise<HttpRemotePeerInvokeResponse> => await requestJson(
        fetchImpl,
        buildTransportUrl(paths.peerListUrl, `${encodeURIComponent(input.peerId)}/invoke`),
        createJsonRequestInit(token, {
          command: input.command,
          ...(input.payload !== undefined ? { payload: input.payload } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.routeId ? { routeId: input.routeId } : {}),
          ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
          ...(input.automationJobId ? { automationJobId: input.automationJobId } : {}),
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }, 'POST'),
      ),
      claim: async (tokenValue, input = {}): Promise<readonly DistributedPendingWork[]> => {
        const body = await requestJson<readonly DistributedPendingWork[] | { work?: DistributedPendingWork[] }>(fetchImpl, buildTransportUrl(paths.remoteUrl, 'work/pull'), createJsonRequestInit(tokenValue, input, 'POST'));
        return readArrayResponse<DistributedPendingWork>(body, 'work');
      },
      complete: async (tokenValue, workId, input = {}): Promise<DistributedPendingWork | null> => await requestJsonWithFallback<DistributedPendingWork | { work?: DistributedPendingWork }>(fetchImpl, buildTransportUrl(paths.remoteUrl, `work/${encodeURIComponent(workId)}/complete`), createJsonRequestInit(tokenValue, input, 'POST')).then((body) => {
        if (!body) return null;
        if (isRecord(body) && 'work' in body) {
          return (body.work as DistributedPendingWork | undefined) ?? null;
        }
        return body as DistributedPendingWork;
      }),
      cancel: async (workId, actor, note): Promise<DistributedPendingWork | null> => await requestJsonWithFallback<DistributedPendingWork | { work?: DistributedPendingWork }>(fetchImpl, buildTransportUrl(paths.remoteWorkUrl, `${encodeURIComponent(workId)}/cancel`), createJsonRequestInit(token, {
        actor,
        ...(note ? { reason: note } : {}),
      }, 'POST')).then((body) => {
        if (!body) return null;
        if (isRecord(body) && 'work' in body) {
          return (body.work as DistributedPendingWork | undefined) ?? null;
        }
        return body as DistributedPendingWork;
      }),
    },
    getSnapshot: async (): Promise<HttpPeerSnapshot> => {
      const [remoteSnapshot, contract, peers] = await Promise.all([
        requestJson<Record<string, unknown>>(fetchImpl, paths.remoteUrl, createJsonRequestInit(token)),
        requestJson<DistributedNodeHostContract>(fetchImpl, paths.remoteContractUrl, createJsonRequestInit(token)),
        requestJson<readonly DistributedPeerRecord[] | { peers?: DistributedPeerRecord[] }>(fetchImpl, paths.peerListUrl, createJsonRequestInit(token)),
      ]);
      const peerList = readArrayResponse<DistributedPeerRecord>(peers, 'peers');
      const pairRequests = maybeList<DistributedRuntimePairRequest>(remoteSnapshot, 'pairRequests');
      const work = maybeList<DistributedPendingWork>(remoteSnapshot, 'work');
      return {
        capturedAt: Date.now(),
        nodeHostContract: contract,
        remoteSnapshot,
        pairRequests,
        peers: peerList,
        work,
      };
    },
    getNodeHostContract: async (): Promise<DistributedNodeHostContract> => {
      const body = await requestJson<{ contract?: DistributedNodeHostContract } | DistributedNodeHostContract>(fetchImpl, paths.remoteContractUrl, createJsonRequestInit(token));
      return readNodeHostContract(body);
    },
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
  const operator = createOperatorClient(paths, options.authToken, fetchImpl, events);
  const peer = createPeerClient(paths, options.authToken, fetchImpl);
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
