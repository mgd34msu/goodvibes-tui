import type {
  ControlPlaneRecentEvent,
  SharedApprovalRecord,
  SharedSessionRecord,
} from '../../control-plane/index.ts';
import type { ControlPlaneClientRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';
import type { TelemetryFilter, TelemetryRecord } from '../telemetry/api.ts';
import type { UiControlPlaneSnapshot } from '../ui-read-models.ts';
import type { TransportPaths } from '@pellux/goodvibes-sdk/platform/runtime/transports/transport-paths';
import { buildUrl } from '@pellux/goodvibes-sdk/platform/runtime/transports/transport-paths';
import { createJsonInit, requestJson } from '@pellux/goodvibes-sdk/platform/runtime/transports/http-json-transport';
import { openServerSentEventStream } from '@pellux/goodvibes-sdk/platform/runtime/transports/sse-stream';
import type {
  HttpSessionEnsureInput,
  HttpSessionMessageInput,
  HttpSteerSessionMessageInput,
  HttpTaskSubmitInput,
  HttpTransportTelemetryQuery,
  HttpTransportTelemetryStreamHandlers,
  HttpTransportTelemetryStreamReady,
} from './http-types.ts';

export function createJsonRequestInit(token: string | null | undefined, body?: unknown, method = 'GET'): RequestInit {
  return createJsonInit(token, body, method);
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
  return await openServerSentEventStream(fetchImpl, url, {
    onEvent: (eventName, payload) => {
      if (eventName === 'telemetry' && payload && typeof payload === 'object') {
        handlers.onRecord(payload as TelemetryRecord);
      }
    },
    onReady: handlers.onReady
      ? (payload) => {
          handlers.onReady?.(payload as HttpTransportTelemetryStreamReady);
        }
      : undefined,
  }, {
    authToken: token,
  });
}

export function buildTransportUrl(baseUrl: string, path: string): string {
  return buildUrl(baseUrl, path);
}
