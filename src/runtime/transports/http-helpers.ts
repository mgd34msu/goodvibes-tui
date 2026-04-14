import type {
  ControlPlaneRecentEvent,
  SharedApprovalRecord,
  SharedSessionRecord,
} from '../../control-plane/index.ts';
import type { DistributedNodeHostContract } from '../remote/distributed-runtime-types.ts';
import type { ControlPlaneClientRecord } from '../store/domains/control-plane.ts';
import type { TelemetryFilter, TelemetryRecord } from '../telemetry/api.ts';
import type { UiControlPlaneSnapshot } from '../ui-read-models.ts';
import type { TransportPaths } from './shared.ts';
import { createJsonInit, requestJson } from './shared.ts';
import type {
  HttpSessionEnsureInput,
  HttpSessionMessageInput,
  HttpSteerSessionMessageInput,
  HttpTaskSubmitInput,
  HttpTransportTelemetryQuery,
  HttpTransportTelemetryStreamHandlers,
  HttpTransportTelemetryStreamReady,
} from './http-types.ts';

export function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new Error('Transport baseUrl is required');
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function createFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? globalThis.fetch.bind(globalThis);
}

export function createJsonRequestInit(token: string | null | undefined, body?: unknown, method = 'GET'): RequestInit {
  return createJsonInit(token, body, method);
}

export function maybeList<T>(value: unknown, key: string): readonly T[] {
  if (Array.isArray(value)) return value as readonly T[];
  if (typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)[key])) {
    return (value as Record<string, unknown>)[key] as readonly T[];
  }
  return [];
}

export function maybeObject<T extends object>(value: unknown): T | null {
  return typeof value === 'object' && value !== null ? value as T : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readArrayResponse<T>(body: unknown, key: string): readonly T[] {
  if (Array.isArray(body)) return body as readonly T[];
  if (isRecord(body)) {
    const maybeEntries = body[key];
    if (Array.isArray(maybeEntries)) return maybeEntries as readonly T[];
  }
  return [];
}

function readControlPlaneClients(body: unknown): readonly ControlPlaneClientRecord[] {
  if (!isRecord(body)) return [];
  return Array.isArray(body.clients) ? body.clients as readonly ControlPlaneClientRecord[] : [];
}

function readControlPlaneEvents(body: unknown): readonly ControlPlaneRecentEvent[] {
  if (!isRecord(body)) return [];
  return Array.isArray(body.recentEvents) ? body.recentEvents as readonly ControlPlaneRecentEvent[] : [];
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

export function readNodeHostContract(
  body: { contract?: DistributedNodeHostContract } | DistributedNodeHostContract,
): DistributedNodeHostContract {
  if (isRecord(body) && 'contract' in body && body.contract) {
    return body.contract;
  }
  return body as DistributedNodeHostContract;
}

export async function readControlPlaneSnapshot(
  fetchImpl: typeof fetch,
  paths: TransportPaths,
  token: string | null | undefined,
): Promise<UiControlPlaneSnapshot> {
  const approvalsUrl = new URL(paths.approvalsUrl);
  approvalsUrl.searchParams.set('limit', '6');
  const [gatewaySnapshot, approvals, sessions] = await Promise.all([
    requestJson<Record<string, unknown>>(fetchImpl, paths.controlPlaneUrl, createJsonRequestInit(token)),
    requestJson<readonly SharedApprovalRecord[] | { approvals?: SharedApprovalRecord[] }>(
      fetchImpl,
      approvalsUrl.toString(),
      createJsonRequestInit(token),
    ),
    requestJson<readonly SharedSessionRecord[] | { sessions?: SharedSessionRecord[] } | { session?: SharedSessionRecord[] }>(
      fetchImpl,
      paths.sessionsUrl,
      createJsonRequestInit(token),
    ),
  ]);
  const server = maybeObject<Record<string, unknown>>(isRecord(gatewaySnapshot) ? gatewaySnapshot.server : null) ?? {};
  const totals = maybeObject<Record<string, unknown>>(isRecord(gatewaySnapshot) ? gatewaySnapshot.totals : null) ?? {};
  const clients = readControlPlaneClients(gatewaySnapshot);
  const recentEvents = readControlPlaneEvents(gatewaySnapshot).slice(0, 6);
  const sessionList = readArrayResponse<SharedSessionRecord>(sessions, 'sessions');
  const approvalList = readArrayResponse<SharedApprovalRecord>(approvals, 'approvals');
  return {
    connectionState: readString(server.connectionState, 'unknown'),
    activeClientIds: clients.filter((client) => readBoolean(client.connected)).map((client) => client.id),
    requestCount: readNumber(totals.requests),
    errorCount: readNumber(totals.errors),
    host: readString(server.host, ''),
    port: readNumber(server.port),
    clients,
    approvals: approvalList.slice(0, 6),
    sessions: sessionList.length > 0
      ? sessionList.slice(0, 6)
      : readArrayResponse<SharedSessionRecord>(sessions, 'session').slice(0, 6),
    recentEvents,
  };
}

export function buildSessionEnsureBody(input: HttpSessionEnsureInput = {}): Record<string, unknown> {
  return {
    ...(input.sessionId ? { id: input.sessionId } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.routeId ? { routeId: input.routeId } : {}),
    ...(input.participant
      ? {
          surfaceKind: input.participant.surfaceKind,
          surfaceId: input.participant.surfaceId,
          ...(input.participant.externalId ? { externalId: input.participant.externalId } : {}),
          ...(input.participant.userId ? { userId: input.participant.userId } : {}),
          ...(input.participant.displayName ? { displayName: input.participant.displayName } : {}),
        }
      : {}),
  };
}

export function buildSessionMessageBody(input: HttpSessionMessageInput): Record<string, unknown> {
  return {
    body: input.body,
    ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.routeId ? { routeId: input.routeId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.routing ? { routing: input.routing } : {}),
  };
}

export function buildSteerSessionMessageBody(input: HttpSteerSessionMessageInput): Record<string, unknown> {
  return {
    ...buildSessionMessageBody(input),
    ...(input.allowSpawnFallback === true ? { allowSpawnFallback: true } : {}),
  };
}

export function buildTaskSubmitBody(input: HttpTaskSubmitInput): Record<string, unknown> {
  return {
    task: input.task,
    ...(input.model ? { model: input.model } : {}),
    ...(input.tools ? { tools: [...input.tools] } : {}),
    ...(input.routing ? { routing: input.routing } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.routeId ? { routeId: input.routeId } : {}),
    ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
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

export function normalizeTelemetryQuery(query: HttpTransportTelemetryQuery | undefined, defaultLimit: number): TelemetryFilter {
  if (typeof query === 'number') {
    return { limit: Math.max(1, Math.floor(query)) };
  }
  return {
    ...(query ?? {}),
    ...(query?.limit !== undefined ? { limit: Math.max(1, Math.floor(query.limit)) } : { limit: defaultLimit }),
  };
}

export function appendTelemetryQuery(url: URL, query: TelemetryFilter): void {
  if (query.limit !== undefined) url.searchParams.set('limit', String(Math.max(1, Math.floor(query.limit))));
  if (query.since !== undefined) url.searchParams.set('since', String(query.since));
  if (query.until !== undefined) url.searchParams.set('until', String(query.until));
  if (query.domains?.length) url.searchParams.set('domains', query.domains.join(','));
  if (query.eventTypes?.length) url.searchParams.set('types', query.eventTypes.join(','));
  if (query.severity) url.searchParams.set('severity', query.severity);
  if (query.traceId) url.searchParams.set('traceId', query.traceId);
  if (query.sessionId) url.searchParams.set('sessionId', query.sessionId);
  if (query.turnId) url.searchParams.set('turnId', query.turnId);
  if (query.agentId) url.searchParams.set('agentId', query.agentId);
  if (query.taskId) url.searchParams.set('taskId', query.taskId);
  if (query.cursor) url.searchParams.set('cursor', query.cursor);
  if (query.view) url.searchParams.set('view', query.view);
}

export async function connectTelemetryStream(
  fetchImpl: typeof fetch,
  url: string,
  token: string | null | undefined,
  handlers: HttpTransportTelemetryStreamHandlers,
): Promise<() => void> {
  const controller = new AbortController();
  const response = await fetchImpl(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: 'include',
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    throw new Error(`Unable to connect telemetry stream: ${response.status} ${body}`.trim());
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let data = '';
  const handleRecord = (): void => {
    if (!eventName || !data.trim()) {
      eventName = '';
      data = '';
      return;
    }
    try {
      if (eventName === 'telemetry') {
        handlers.onRecord(JSON.parse(data) as TelemetryRecord);
      } else if (eventName === 'ready' && handlers.onReady) {
        handlers.onReady(JSON.parse(data) as HttpTransportTelemetryStreamReady);
      }
    } finally {
      eventName = '';
      data = '';
    }
  };
  const consumeLine = (line: string): void => {
    if (!line) {
      handleRecord();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      data += `${data ? '\n' : ''}${line.slice(5).trim()}`;
    }
  };
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const raw = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          consumeLine(raw);
          newlineIndex = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) {
        consumeLine(buffer.replace(/\r$/, ''));
        handleRecord();
      }
    } finally {
      controller.abort();
    }
  })().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  });
  return () => {
    controller.abort();
  };
}

export async function requestJsonWithFallback<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<T | null> {
  try {
    return await requestJson<T>(fetchImpl, url, init);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export function buildTransportUrl(baseUrl: string, path: string): string {
  return new URL(path, `${normalizeBaseUrl(baseUrl)}/`).toString();
}
