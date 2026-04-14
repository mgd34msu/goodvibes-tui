import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import { AppError } from '../../types/errors.ts';
import { buildMissingScopeBody, resolveAuthenticatedPrincipal, type AuthenticatedPrincipal } from '../http-policy.ts';
import type { RuntimeEventDomain } from '../../runtime/events/index.ts';
import type { TelemetryApiService, TelemetryFilter, TelemetrySeverity, TelemetryViewMode } from '../../runtime/telemetry/api.ts';
import { jsonErrorResponse } from './error-response.ts';

interface TelemetryRouteContext {
  readonly telemetryApi: TelemetryApiService | null;
  readonly extractAuthToken: (req: Request) => string;
  readonly describeAuthenticatedPrincipal: (token: string) => AuthenticatedPrincipal | null;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCsv<T extends string>(value: string | null): readonly T[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as T[];
  return parsed.length > 0 ? parsed : undefined;
}

function parseSeverity(value: string | null): TelemetrySeverity | undefined {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

function parseView(value: string | null): TelemetryViewMode | undefined {
  return value === 'safe' || value === 'raw' ? value : undefined;
}

function buildFilter(url: URL): TelemetryFilter {
  return {
    ...(parseNumber(url.searchParams.get('limit')) !== undefined ? { limit: parseNumber(url.searchParams.get('limit')) } : {}),
    ...(parseNumber(url.searchParams.get('since')) !== undefined ? { since: parseNumber(url.searchParams.get('since')) } : {}),
    ...(parseNumber(url.searchParams.get('until')) !== undefined ? { until: parseNumber(url.searchParams.get('until')) } : {}),
    ...(parseCsv<RuntimeEventDomain>(url.searchParams.get('domains')) ? { domains: parseCsv<RuntimeEventDomain>(url.searchParams.get('domains')) } : {}),
    ...(parseCsv<string>(url.searchParams.get('types')) ? { eventTypes: parseCsv<string>(url.searchParams.get('types')) } : {}),
    ...(parseSeverity(url.searchParams.get('severity')) ? { severity: parseSeverity(url.searchParams.get('severity')) } : {}),
    ...(url.searchParams.get('traceId') ? { traceId: url.searchParams.get('traceId') ?? undefined } : {}),
    ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId') ?? undefined } : {}),
    ...(url.searchParams.get('turnId') ? { turnId: url.searchParams.get('turnId') ?? undefined } : {}),
    ...(url.searchParams.get('agentId') ? { agentId: url.searchParams.get('agentId') ?? undefined } : {}),
    ...(url.searchParams.get('taskId') ? { taskId: url.searchParams.get('taskId') ?? undefined } : {}),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') ?? undefined } : {}),
    ...(parseView(url.searchParams.get('view')) ? { view: parseView(url.searchParams.get('view')) } : {}),
  };
}

function unavailable(): Response {
  return jsonErrorResponse(
    new AppError('Telemetry API unavailable', 'TELEMETRY_UNAVAILABLE', true, {
      category: 'service',
      source: 'runtime',
      guidance: 'Start the daemon runtime and ensure the runtime store is available before reading telemetry.',
    }),
    { status: 503 },
  );
}

function invalidCursor(error: unknown): Response {
  return jsonErrorResponse(
    new AppError(error instanceof Error ? error.message : 'Invalid telemetry cursor', 'INVALID_CURSOR', false, {
      category: 'bad_request',
      source: 'runtime',
      guidance: 'Use the nextCursor returned by the previous telemetry page, or omit cursor to start from the newest records.',
    }),
    { status: 400 },
  );
}

function authenticateTelemetryRequest(
  context: TelemetryRouteContext,
  req: Request,
  requestedView: TelemetryViewMode,
): { principal: AuthenticatedPrincipal; view: TelemetryViewMode; rawAccessible: boolean } | Response {
  const principal = resolveAuthenticatedPrincipal(req, context);
  if (!principal) {
    return jsonErrorResponse(
      new AppError('Authentication required for telemetry access', 'AUTH_REQUIRED', false, {
        category: 'authentication',
        source: 'runtime',
        guidance: 'Authenticate with the operator shared token or an authenticated user session before calling telemetry APIs.',
      }),
      { status: 401 },
    );
  }

  const missingRead = buildMissingScopeBody('telemetry access', ['read:telemetry'], principal.scopes);
  if (missingRead) {
    return jsonErrorResponse(
      new AppError(missingRead.error, 'MISSING_SCOPE', false, {
        category: 'authorization',
        source: 'permission',
        detail: JSON.stringify(missingRead),
        guidance: 'Use a token or session with the read:telemetry scope, or elevate to an admin/shared-token session.',
      }),
      { status: 403 },
    );
  }

  const rawAccessible = principal.admin || principal.scopes.includes('read:telemetry-sensitive');
  if (requestedView === 'raw' && !rawAccessible) {
    return jsonErrorResponse(
      new AppError('Raw telemetry view requires elevated telemetry scope', 'MISSING_SCOPE', false, {
        category: 'authorization',
        source: 'permission',
        guidance: 'Use an admin/shared-token session or a token granted read:telemetry-sensitive to access raw telemetry payloads.',
      }),
      { status: 403 },
    );
  }

  return {
    principal,
    view: requestedView,
    rawAccessible,
  };
}

export function createDaemonTelemetryRouteHandlers(
  context: TelemetryRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getTelemetrySnapshot'
  | 'getTelemetryEvents'
  | 'getTelemetryErrors'
  | 'getTelemetryTraces'
  | 'getTelemetryMetrics'
  | 'createTelemetryEventStream'
  | 'getTelemetryOtlpTraces'
  | 'getTelemetryOtlpLogs'
  | 'getTelemetryOtlpMetrics'
> {
  return {
    getTelemetrySnapshot: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.getSnapshot(filter, access.view, access.rawAccessible));
    },
    getTelemetryEvents: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listEventPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryErrors: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listErrorPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryTraces: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listSpanPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryMetrics: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      const snapshot = context.telemetryApi.getSnapshot(filter, access.view, access.rawAccessible);
      return Response.json({
        version: 1,
        generatedAt: snapshot.generatedAt,
        view: snapshot.view,
        rawAccessible: snapshot.rawAccessible,
        runtime: snapshot.runtime,
        sessionMetrics: snapshot.sessionMetrics,
        aggregates: snapshot.aggregates,
      });
    },
    createTelemetryEventStream: (req) => {
      if (!context.telemetryApi) return unavailable();
      const filter = buildFilter(new URL(req.url));
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return context.telemetryApi.createStream(req, filter, access.view, access.rawAccessible);
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryOtlpTraces: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpTraceDocument(filter, access.view));
    },
    getTelemetryOtlpLogs: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpLogDocument(filter, access.view));
    },
    getTelemetryOtlpMetrics: (req) => {
      if (!context.telemetryApi) return unavailable();
      const access = authenticateTelemetryRequest(context, req, 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpMetricDocument());
    },
  };
}
