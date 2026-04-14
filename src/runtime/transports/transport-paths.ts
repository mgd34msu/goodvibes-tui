export interface TransportPaths {
  readonly baseUrl: string;
  readonly statusUrl: string;
  readonly controlPlaneUrl: string;
  readonly controlPlaneAuthUrl: string;
  readonly controlPlaneEventsUrl: string;
  readonly controlPlaneMethodsUrl: string;
  readonly sessionsUrl: string;
  readonly tasksUrl: string;
  readonly approvalsUrl: string;
  readonly providersUrl: string;
  readonly accountsUrl: string;
  readonly localAuthUrl: string;
  readonly telemetryUrl: string;
  readonly telemetryEventsUrl: string;
  readonly telemetryErrorsUrl: string;
  readonly telemetryTracesUrl: string;
  readonly telemetryMetricsUrl: string;
  readonly telemetryStreamUrl: string;
  readonly telemetryOtlpTracesUrl: string;
  readonly telemetryOtlpLogsUrl: string;
  readonly telemetryOtlpMetricsUrl: string;
  readonly remoteUrl: string;
  readonly remoteContractUrl: string;
  readonly peerRequestsUrl: string;
  readonly peerListUrl: string;
  readonly remoteWorkUrl: string;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new Error('Transport baseUrl is required');
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function buildUrl(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return new URL(path, `${normalized}/`).toString();
}

export function createTransportPaths(baseUrl: string): TransportPaths {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    baseUrl: normalized,
    statusUrl: buildUrl(normalized, '/status'),
    controlPlaneUrl: buildUrl(normalized, '/api/control-plane'),
    controlPlaneAuthUrl: buildUrl(normalized, '/api/control-plane/auth'),
    controlPlaneEventsUrl: buildUrl(normalized, '/api/control-plane/events'),
    controlPlaneMethodsUrl: buildUrl(normalized, '/api/control-plane/methods'),
    sessionsUrl: buildUrl(normalized, '/api/sessions'),
    tasksUrl: buildUrl(normalized, '/api/tasks'),
    approvalsUrl: buildUrl(normalized, '/api/approvals'),
    providersUrl: buildUrl(normalized, '/api/providers'),
    accountsUrl: buildUrl(normalized, '/api/accounts'),
    localAuthUrl: buildUrl(normalized, '/api/local-auth'),
    telemetryUrl: buildUrl(normalized, '/api/v1/telemetry'),
    telemetryEventsUrl: buildUrl(normalized, '/api/v1/telemetry/events'),
    telemetryErrorsUrl: buildUrl(normalized, '/api/v1/telemetry/errors'),
    telemetryTracesUrl: buildUrl(normalized, '/api/v1/telemetry/traces'),
    telemetryMetricsUrl: buildUrl(normalized, '/api/v1/telemetry/metrics'),
    telemetryStreamUrl: buildUrl(normalized, '/api/v1/telemetry/stream'),
    telemetryOtlpTracesUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/traces'),
    telemetryOtlpLogsUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/logs'),
    telemetryOtlpMetricsUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/metrics'),
    remoteUrl: buildUrl(normalized, '/api/remote'),
    remoteContractUrl: buildUrl(normalized, '/api/remote/node-host/contract'),
    peerRequestsUrl: buildUrl(normalized, '/api/remote/pair/requests'),
    peerListUrl: buildUrl(normalized, '/api/remote/peers'),
    remoteWorkUrl: buildUrl(normalized, '/api/remote/work'),
  };
}
