import type { CommunicationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/communication';
import type { PluginEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/plugins';
import type { McpEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/mcp';
import type { TransportEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/transport';
import type { IntegrationDomainState, IntegrationRecord, IntegrationStatus } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/integrations';
import type { AutomationDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/automation';
import type { RoutesDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/routes';
import type { ControlPlaneDomainState, ControlPlaneClientRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';
import type { DeliveryDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/deliveries';
import type { WatcherDomainState, WatcherRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';
import type { SurfaceDomainState, SurfaceRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surfaces';
import type { CommunicationDomainState, RuntimeCommunicationRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';
import type { PluginDomainState, RuntimePlugin, PluginLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';
import type { McpDomainState, McpServerRecord, McpServerLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/mcp';
import type { AcpDomainState, AcpTransportState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import type { DaemonDomainState, DaemonTransportState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/daemon';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation/runs';
import type { AutomationSourceRecord } from '@pellux/goodvibes-sdk/platform/automation/sources';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { AutomationSurfaceKind } from '@pellux/goodvibes-sdk/platform/automation/types';
import type { AutomationDeliveryAttempt } from '@pellux/goodvibes-sdk/platform/automation/delivery';
import type { SessionDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/session';
import { now, uniq, updateDomainMetadata } from '@pellux/goodvibes-sdk/platform/runtime/store/helpers/reducers/shared';

export function updateCommunicationState(
  domain: CommunicationDomainState,
  event: CommunicationEvent,
): CommunicationDomainState {
  const timestamp = now();
  const records = new Map(domain.records);
  const base: RuntimeCommunicationRecord | undefined =
    event.type === 'COMMUNICATION_SENT' || event.type === 'COMMUNICATION_BLOCKED'
      ? {
          id: event.messageId,
          fromId: event.fromId,
          toId: event.toId,
          scope: event.scope,
          kind: event.kind,
          content: 'content' in event ? event.content : '',
          timestamp,
          status: event.type === 'COMMUNICATION_BLOCKED' ? 'blocked' : 'sent',
          ...(event.fromRole !== undefined ? { fromRole: event.fromRole } : {}),
          ...(event.toRole !== undefined ? { toRole: event.toRole } : {}),
          ...(event.cohort !== undefined ? { cohort: event.cohort } : {}),
          ...(event.wrfcId !== undefined ? { wrfcId: event.wrfcId } : {}),
          ...(event.parentAgentId !== undefined ? { parentAgentId: event.parentAgentId } : {}),
          ...('reason' in event && event.reason !== undefined ? { reason: event.reason } : {}),
        }
      : undefined;

  if (base) {
    records.set(event.messageId, base);
  } else {
    const existing = records.get(event.messageId);
    if (!existing) return domain;
    records.set(event.messageId, {
      ...existing,
      status: event.type === 'COMMUNICATION_DELIVERED' ? 'delivered' : existing.status,
    });
  }

  const recentRecordIds = uniq([event.messageId, ...domain.recentRecordIds]).slice(0, 200);
  return {
    ...updateDomainMetadata(domain, event.type),
    records,
    recentRecordIds,
    totalSent: domain.totalSent + (event.type === 'COMMUNICATION_SENT' ? 1 : 0),
    totalDelivered: domain.totalDelivered + (event.type === 'COMMUNICATION_DELIVERED' ? 1 : 0),
    totalBlocked: domain.totalBlocked + (event.type === 'COMMUNICATION_BLOCKED' ? 1 : 0),
  };
}

function pluginStatusForEvent(event: PluginEvent): PluginLifecycleState {
  switch (event.type) {
    case 'PLUGIN_DISCOVERED':
      return 'discovered';
    case 'PLUGIN_LOADING':
      return 'loading';
    case 'PLUGIN_LOADED':
      return 'loaded';
    case 'PLUGIN_ACTIVE':
      return 'active';
    case 'PLUGIN_DEGRADED':
      return 'degraded';
    case 'PLUGIN_ERROR':
      return 'error';
    case 'PLUGIN_UNLOADING':
      return 'unloading';
    case 'PLUGIN_DISABLED':
      return 'disabled';
  }
}

export function updatePluginState(domain: PluginDomainState, event: PluginEvent): PluginDomainState {
  const plugins = new Map(domain.plugins);
  const existing = plugins.get(event.pluginId);
  const timestamp = now();
  const plugin: RuntimePlugin =
    existing ??
    {
      name: event.pluginId,
      displayName: event.pluginId,
      version: 'version' in event ? event.version : 'unknown',
      description: 'path' in event ? event.path : '',
      status: pluginStatusForEvent(event),
      enabled: true,
      active: false,
      toolCount: 'capabilities' in event ? event.capabilities.length : 0,
      config: {},
      hookInvocations: 0,
    };
  const next: RuntimePlugin = {
    ...plugin,
    status: pluginStatusForEvent(event),
    version: 'version' in event ? event.version : plugin.version,
    description: 'path' in event ? event.path : plugin.description,
    active: event.type === 'PLUGIN_ACTIVE' ? true : event.type === 'PLUGIN_DISABLED' ? false : plugin.active,
    enabled: event.type === 'PLUGIN_DISABLED' ? false : plugin.enabled,
    toolCount: 'capabilities' in event ? event.capabilities.length : plugin.toolCount,
    error:
      event.type === 'PLUGIN_ERROR'
        ? event.error
        : event.type === 'PLUGIN_DEGRADED'
          ? event.reason
          : plugin.error,
    loadedAt: event.type === 'PLUGIN_LOADED' || event.type === 'PLUGIN_ACTIVE' ? timestamp : plugin.loadedAt,
    errorAt: event.type === 'PLUGIN_ERROR' || event.type === 'PLUGIN_DEGRADED' ? timestamp : plugin.errorAt,
  };
  plugins.set(event.pluginId, next);
  const activePluginNames = [...plugins.values()].filter((value) => value.active).map((value) => value.name);
  const erroredPluginNames = [...plugins.values()]
    .filter((value) => value.status === 'error' || value.status === 'degraded')
    .map((value) => value.name);
  return {
    ...updateDomainMetadata(domain, event.type),
    plugins,
    activePluginNames,
    erroredPluginNames,
    totalDiscovered: domain.totalDiscovered + (event.type === 'PLUGIN_DISCOVERED' ? 1 : 0),
    totalActive: activePluginNames.length,
    totalToolsContributed: [...plugins.values()].reduce((sum, value) => sum + (value.active ? value.toolCount : 0), 0),
    initialLoadComplete: domain.initialLoadComplete || event.type === 'PLUGIN_LOADED' || event.type === 'PLUGIN_ACTIVE',
    reloadInProgress: event.type === 'PLUGIN_LOADING' || event.type === 'PLUGIN_UNLOADING',
  };
}

function mcpStatusForEvent(event: McpEvent): McpServerLifecycleState {
  switch (event.type) {
    case 'MCP_CONFIGURED':
      return 'configured';
    case 'MCP_CONNECTING':
      return 'connecting';
    case 'MCP_CONNECTED':
      return 'connected';
    case 'MCP_DEGRADED':
    case 'MCP_SCHEMA_QUARANTINED':
    case 'MCP_SCHEMA_QUARANTINE_APPROVED':
      return 'degraded';
    case 'MCP_AUTH_REQUIRED':
      return 'auth_required';
    case 'MCP_RECONNECTING':
      return 'reconnecting';
    case 'MCP_DISCONNECTED':
      return 'disconnected';
    case 'MCP_POLICY_UPDATED':
      return 'configured';
  }
}

export function updateMcpState(domain: McpDomainState, event: McpEvent): McpDomainState {
  const servers = new Map(domain.servers);
  const existing = servers.get(event.serverId);
  const timestamp = now();
  const server: McpServerRecord =
    existing ??
    {
      name: event.serverId,
      displayName: event.serverId,
      status: mcpStatusForEvent(event),
      transport: event.type === 'MCP_CONFIGURED' && event.transport === 'http' ? 'http' : 'stdio',
      toolCount: 0,
      toolNames: [],
      callCount: 0,
      errorCount: 0,
      reconnectAttempts: 0,
      trustMode:
        event.type === 'MCP_POLICY_UPDATED'
          ? event.trustMode
          : event.type === 'MCP_CONFIGURED'
            ? event.trustMode ?? 'ask-on-risk'
            : 'ask-on-risk',
      role:
        event.type === 'MCP_POLICY_UPDATED'
          ? event.role
          : event.type === 'MCP_CONFIGURED'
            ? event.role ?? 'general'
            : 'general',
      allowedPaths:
        event.type === 'MCP_POLICY_UPDATED'
          ? [...event.allowedPaths]
          : event.type === 'MCP_CONFIGURED'
            ? [...(event.allowedPaths ?? [])]
            : [],
      allowedHosts:
        event.type === 'MCP_POLICY_UPDATED'
          ? [...event.allowedHosts]
          : event.type === 'MCP_CONFIGURED'
            ? [...(event.allowedHosts ?? [])]
            : [],
      schemaFreshness:
        event.type === 'MCP_SCHEMA_QUARANTINED'
          ? 'quarantined'
          : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
            ? 'stale'
            : 'unknown',
      quarantineReason: event.type === 'MCP_SCHEMA_QUARANTINED' ? event.reason : undefined,
      quarantineDetail: event.type === 'MCP_SCHEMA_QUARANTINED' ? event.detail : undefined,
      quarantineApprovedBy: event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED' ? event.operatorId : undefined,
    };
  servers.set(event.serverId, {
    ...server,
    status:
      event.type === 'MCP_POLICY_UPDATED' ||
      event.type === 'MCP_SCHEMA_QUARANTINED' ||
      event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
        ? server.status
        : mcpStatusForEvent(event),
    transport:
      event.type === 'MCP_CONFIGURED'
        ? event.transport === 'sse' || event.transport === 'http'
          ? event.transport
          : 'stdio'
        : server.transport,
    toolCount: event.type === 'MCP_CONNECTED' ? event.toolCount : server.toolCount,
    connectedAt: event.type === 'MCP_CONNECTED' ? timestamp : server.connectedAt,
    reconnectAttempts: event.type === 'MCP_RECONNECTING' ? event.attempt : server.reconnectAttempts,
    trustMode: event.type === 'MCP_POLICY_UPDATED'
      ? event.trustMode
      : event.type === 'MCP_CONFIGURED'
        ? event.trustMode ?? server.trustMode
        : server.trustMode,
    role: event.type === 'MCP_POLICY_UPDATED'
      ? event.role
      : event.type === 'MCP_CONFIGURED'
        ? event.role ?? server.role
        : server.role,
    allowedPaths: event.type === 'MCP_POLICY_UPDATED'
      ? [...event.allowedPaths]
      : event.type === 'MCP_CONFIGURED'
        ? [...(event.allowedPaths ?? server.allowedPaths)]
        : server.allowedPaths,
    allowedHosts: event.type === 'MCP_POLICY_UPDATED'
      ? [...event.allowedHosts]
      : event.type === 'MCP_CONFIGURED'
        ? [...(event.allowedHosts ?? server.allowedHosts)]
        : server.allowedHosts,
    schemaFreshness:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? 'quarantined'
        : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
          ? 'stale'
          : event.type === 'MCP_CONNECTED'
            ? 'fresh'
            : server.schemaFreshness,
    quarantineReason:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? event.reason
        : server.quarantineReason,
    quarantineDetail:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? event.detail
        : server.quarantineDetail,
    quarantineApprovedBy:
      event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
        ? event.operatorId
        : server.quarantineApprovedBy,
    lastError:
      event.type === 'MCP_DEGRADED'
        ? event.reason
        : event.type === 'MCP_DISCONNECTED'
          ? event.reason
          : event.type === 'MCP_SCHEMA_QUARANTINED'
            ? event.detail ?? String(event.reason)
            : server.lastError,
  });
  const connectedServerNames = [...servers.values()].filter((value) => value.status === 'connected').map((value) => value.name);
  return {
    ...updateDomainMetadata(domain, event.type),
    servers,
    connectedServerNames,
    availableToolCount: [...servers.values()].reduce((sum, value) => sum + (value.status === 'connected' ? value.toolCount : 0), 0),
    totalErrors:
      domain.totalErrors +
      (event.type === 'MCP_DEGRADED' || event.type === 'MCP_DISCONNECTED' || event.type === 'MCP_SCHEMA_QUARANTINED' ? 1 : 0),
  };
}

function transportStateForEvent(event: TransportEvent): AcpTransportState | DaemonTransportState {
  switch (event.type) {
    case 'TRANSPORT_INITIALIZING':
      return 'initializing';
    case 'TRANSPORT_AUTHENTICATING':
      return 'authenticating';
    case 'TRANSPORT_CONNECTED':
      return 'connected';
    case 'TRANSPORT_SYNCING':
      return 'syncing';
    case 'TRANSPORT_DEGRADED':
      return 'degraded';
    case 'TRANSPORT_RECONNECTING':
      return 'reconnecting';
    case 'TRANSPORT_DISCONNECTED':
      return 'disconnected';
    case 'TRANSPORT_TERMINAL_FAILURE':
      return 'terminal_failure';
  }
}

export function updateTransportState(
  acp: AcpDomainState,
  daemon: DaemonDomainState,
  event: TransportEvent,
): Pick<import('../../state.ts').RuntimeState, 'acp' | 'daemon'> {
  const nextTransportState = transportStateForEvent(event);
  const isAcp = event.transportId.startsWith('acp');
  const nextAcp = isAcp
    ? {
        ...updateDomainMetadata(acp, event.type),
        managerTransportState: nextTransportState as AcpTransportState,
        initialized: acp.initialized || event.type === 'TRANSPORT_INITIALIZING',
      }
    : acp;
  const nextDaemon = !isAcp
    ? {
        ...updateDomainMetadata(daemon, event.type),
        transportState: nextTransportState as DaemonTransportState,
        isRunning:
          event.type === 'TRANSPORT_CONNECTED'
            ? true
            : event.type === 'TRANSPORT_DISCONNECTED'
              ? false
              : daemon.isRunning,
        reconnectAttempts: event.type === 'TRANSPORT_RECONNECTING' ? event.attempt : daemon.reconnectAttempts,
        lastConnectedAt: event.type === 'TRANSPORT_CONNECTED' ? now() : daemon.lastConnectedAt,
        lastError:
          event.type === 'TRANSPORT_DEGRADED'
            ? event.reason
            : event.type === 'TRANSPORT_DISCONNECTED'
              ? event.reason
              : event.type === 'TRANSPORT_TERMINAL_FAILURE'
                ? event.error
                : daemon.lastError,
      }
    : daemon;
  return { acp: nextAcp, daemon: nextDaemon };
}

export function updateIntegrationDomainFromRecord(domain: IntegrationDomainState, record: IntegrationRecord, source: string): IntegrationDomainState {
  const integrations = new Map(domain.integrations);
  const previous = integrations.get(record.id);
  integrations.set(record.id, record);
  const problemStatuses: IntegrationStatus[] = ['degraded', 'error'];
  const healthyIds = [...integrations.values()].filter((value) => value.status === 'healthy').map((value) => value.id);
  const problemIds = [...integrations.values()].filter((value) => problemStatuses.includes(value.status)).map((value) => value.id);
  return {
    ...updateDomainMetadata(domain, source),
    integrations,
    healthyIds,
    problemIds,
    totalOperations: domain.totalOperations + ((record.successCount ?? 0) - (previous?.successCount ?? 0)),
    totalErrors: domain.totalErrors + ((record.errorCount ?? 0) - (previous?.errorCount ?? 0)),
  };
}

export function updateAutomationDomainFromSource(domain: AutomationDomainState, sourceRecord: AutomationSourceRecord, source: string): AutomationDomainState {
  const sources = new Map(domain.sources);
  sources.set(sourceRecord.id, sourceRecord);
  const sourceIds = [...sources.values()].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt).map((record) => record.id);
  return { ...updateDomainMetadata(domain, source), sources, sourceIds };
}

export function updateAutomationDomainFromJob(domain: AutomationDomainState, job: AutomationJob, source: string): AutomationDomainState {
  const jobs = new Map(domain.jobs);
  const sources = new Map(domain.sources);
  jobs.set(job.id, job);
  sources.set(job.source.id, job.source);
  const allRuns = [...domain.runs.values()];
  const totalDeadLettered = allRuns.reduce(
    (count, run) => count + (run.deliveryAttempts?.filter((attempt) => attempt.status === 'dead_lettered').length ?? 0),
    0,
  );
  return {
    ...updateDomainMetadata(domain, source),
    jobs,
    jobIds: [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt).map((record) => record.id),
    sources,
    sourceIds: [...sources.values()].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt).map((record) => record.id),
    totalJobs: jobs.size,
    totalRuns: allRuns.length,
    totalSucceeded: allRuns.filter((run) => run.status === 'completed').length,
    totalFailed: allRuns.filter((run) => run.status === 'failed').length,
    totalCancelled: allRuns.filter((run) => run.status === 'cancelled').length,
    totalDeadLettered,
  };
}

export function updateAutomationDomainFromRun(domain: AutomationDomainState, run: AutomationRun, source: string): AutomationDomainState {
  const runs = new Map(domain.runs);
  const sources = new Map(domain.sources);
  runs.set(run.id, run);
  sources.set(run.triggeredBy.id, run.triggeredBy);
  const allRuns = [...runs.values()];
  const totalDeadLettered = allRuns.reduce(
    (count, record) => count + (record.deliveryAttempts?.filter((attempt) => attempt.status === 'dead_lettered').length ?? 0),
    0,
  );
  return {
    ...updateDomainMetadata(domain, source),
    runs,
    runIds: allRuns.sort((a, b) => b.queuedAt - a.queuedAt || a.id.localeCompare(b.id)).map((record) => record.id),
    activeRunIds: allRuns.filter((record) => record.status === 'queued' || record.status === 'running').map((record) => record.id),
    failedRunIds: allRuns.filter((record) => record.status === 'failed').map((record) => record.id),
    sources,
    sourceIds: [...sources.values()].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt).map((record) => record.id),
    totalJobs: domain.jobs.size,
    totalRuns: allRuns.length,
    totalSucceeded: allRuns.filter((record) => record.status === 'completed').length,
    totalFailed: allRuns.filter((record) => record.status === 'failed').length,
    totalCancelled: allRuns.filter((record) => record.status === 'cancelled').length,
    totalDeadLettered,
  };
}

function buildBindingIdsBySurface(bindings: readonly AutomationRouteBinding[]): Readonly<Record<string, readonly string[]>> {
  const grouped: Record<string, string[]> = {
    slack: [],
    discord: [],
    web: [],
    ntfy: [],
    webhook: [],
    tui: [],
    service: [],
  };
  for (const binding of bindings) {
    grouped[binding.surfaceKind] ??= [];
    grouped[binding.surfaceKind]!.push(binding.id);
  }
  return grouped;
}

export function updateRoutesDomainFromBinding(domain: RoutesDomainState, binding: AutomationRouteBinding, source: string): RoutesDomainState {
  const bindings = new Map(domain.bindings);
  bindings.set(binding.id, binding);
  const records = [...bindings.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    bindings,
    bindingIds: records.map((record) => record.id),
    bindingIdsBySurface: buildBindingIdsBySurface(records),
    activeBindingIds: records.map((record) => record.id),
    recentBindingIds: records.slice(0, 20).map((record) => record.id),
    totalBindings: records.length,
    totalResolved: records.filter((record) => record.sessionId || record.jobId || record.runId).length,
  };
}

export function updateRouteFailureState(domain: RoutesDomainState, _surfaceKind: AutomationSurfaceKind, _externalId: string, source: string): RoutesDomainState {
  return { ...updateDomainMetadata(domain, source), totalFailures: domain.totalFailures + 1 };
}

export function updateControlPlaneDomainFromClient(domain: ControlPlaneDomainState, client: ControlPlaneClientRecord, source: string): ControlPlaneDomainState {
  const clients = new Map(domain.clients);
  const previous = clients.get(client.id);
  clients.set(client.id, client);
  const records = [...clients.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
  const active = records.filter((record) => record.connected);
  return {
    ...updateDomainMetadata(domain, source),
    clients,
    activeClients: new Map(active.map((record) => [record.id, record])),
    clientIds: records.map((record) => record.id),
    activeClientIds: active.map((record) => record.id),
    isRunning: domain.isRunning || active.length > 0,
    connectionState: active.length > 0 ? 'connected' : domain.isRunning ? 'disconnected' : domain.connectionState,
    totalConnections: domain.totalConnections + (client.connected && !previous?.connected ? 1 : 0),
    totalDisconnects: domain.totalDisconnects + (!client.connected && previous?.connected ? 1 : 0),
  };
}

export function patchControlPlaneDomain(domain: ControlPlaneDomainState, patch: Partial<ControlPlaneDomainState>, source: string): ControlPlaneDomainState {
  return {
    ...updateDomainMetadata(domain, source),
    ...patch,
    totalFailures: patch.connectionState === 'terminal_failure' ? domain.totalFailures + 1 : patch.totalFailures ?? domain.totalFailures,
  };
}

export function updateDeliveryDomainFromAttempt(domain: DeliveryDomainState, attempt: AutomationDeliveryAttempt, source: string): DeliveryDomainState {
  const deliveryAttempts = new Map(domain.deliveryAttempts);
  deliveryAttempts.set(attempt.id, attempt);
  const attempts = [...deliveryAttempts.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    deliveryAttempts,
    attemptIds: attempts.map((record) => record.id),
    pendingAttemptIds: attempts.filter((record) => record.status === 'pending' || record.status === 'sending').map((record) => record.id),
    failedAttemptIds: attempts.filter((record) => record.status === 'failed').map((record) => record.id),
    deadLetterIds: attempts.filter((record) => record.status === 'dead_lettered').map((record) => record.id),
    totalQueued: attempts.length,
    totalStarted: attempts.filter((record) => record.startedAt !== undefined || record.status !== 'pending').length,
    totalSucceeded: attempts.filter((record) => record.status === 'sent').length,
    totalFailed: attempts.filter((record) => record.status === 'failed').length,
    totalDeadLettered: attempts.filter((record) => record.status === 'dead_lettered').length,
  };
}

export function updateSurfaceDomainFromRecord(domain: SurfaceDomainState, record: SurfaceRecord, source: string): SurfaceDomainState {
  const surfaces = new Map(domain.surfaces);
  surfaces.set(record.id, record);
  const records = [...surfaces.values()].sort((a, b) => a.label.localeCompare(b.label) || a.configuredAt - b.configuredAt);
  return {
    ...updateDomainMetadata(domain, source),
    surfaces,
    surfaceIds: records.map((entry) => entry.id),
    enabledSurfaceIds: records.filter((entry) => entry.enabled).map((entry) => entry.id),
    problemSurfaceIds: records.filter((entry) => entry.state === 'degraded' || entry.state === 'error').map((entry) => entry.id),
    totalHealthy: records.filter((entry) => entry.state === 'healthy').length,
    totalDegraded: records.filter((entry) => entry.state === 'degraded' || entry.state === 'error').length,
    totalDisabled: records.filter((entry) => !entry.enabled || entry.state === 'disabled').length,
  };
}

export function updateWatcherDomainFromRecord(domain: WatcherDomainState, record: WatcherRecord, source: string): WatcherDomainState {
  const watchers = new Map(domain.watchers);
  watchers.set(record.id, record);
  const records = [...watchers.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    watchers,
    watcherIds: records.map((entry) => entry.id),
    activeWatcherIds: records.filter((entry) => entry.state === 'running' || entry.state === 'starting' || entry.state === 'degraded').map((entry) => entry.id),
    failedWatcherIds: records.filter((entry) => entry.state === 'failed').map((entry) => entry.id),
    totalStarted: records.filter((entry) => entry.state === 'running' || entry.state === 'starting').length,
    totalStopped: records.filter((entry) => entry.state === 'stopped').length,
    totalFailed: records.filter((entry) => entry.state === 'failed').length,
    totalHeartbeats: records.filter((entry) => entry.lastHeartbeatAt !== undefined).length,
    totalDegraded: records.filter((entry) => entry.state === 'degraded' || entry.sourceStatus === 'degraded').length,
    totalLagged: records.filter((entry) => entry.sourceStatus === 'lagging' || entry.sourceStatus === 'stale').length,
  };
}

export function syncSessionStatePatch(domain: SessionDomainState, patch: Partial<SessionDomainState>, source: string): SessionDomainState {
  return { ...updateDomainMetadata(domain, source), ...patch };
}
