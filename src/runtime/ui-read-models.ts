import type { ControlPlaneRecentEvent, SharedApprovalRecord, SharedSessionRecord } from '../control-plane/index.ts';
import type {
  DistributedPendingWork,
  DistributedPeerRecord,
  DistributedRuntimePairRequest,
} from './remote/distributed-runtime-types.ts';
import { buildMcpAttackPathReview } from './mcp/index.ts';
import type { McpDecisionRecord, McpSecuritySnapshot } from './mcp/types.ts';
import type { RuntimeServices } from './services.ts';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { PluginStatus } from '../plugins/manager.ts';
import type { TokenAuditResult } from '../security/token-audit.ts';
import type { SecurityPanelSnapshot } from './diagnostics/panels/security.ts';
import type { SessionReturnContextSummary } from './session-return-context.ts';
import type { AutomationJob } from '../automation/jobs.ts';
import type { AutomationRun } from '../automation/runs.ts';
import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { WatcherRecord } from './store/domains/watchers.ts';
import type { OrchestrationGraphRecord } from './store/domains/orchestration.ts';
import type { RuntimeCommunicationRecord } from './store/domains/communication.ts';
import type { RuntimeTask } from './store/domains/tasks.ts';
import type { ControlPlaneClientRecord } from './store/domains/control-plane.ts';
import type { AcpConnection } from './store/domains/acp.ts';
import type { SessionDomainState } from './store/domains/session.ts';
import type { TurnState } from './store/domains/conversation.ts';
import type { RuntimeAgent } from './store/domains/agents.ts';
import type { LspDiagnostic } from './store/domains/intelligence.ts';
import type { ManagedWorktreeMeta } from './worktree/registry.ts';
import { buildEcosystemRecommendations, type EcosystemRecommendation } from './ecosystem/recommendations.ts';
import type { RemoteSupervisorSnapshot } from './remote/supervisor.ts';
import { combineSubscriptions, createStoreBackedReadModel, listProviderIds } from './ui-read-model-helpers.ts';

type Listener = () => void;

export interface UiReadModel<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: Listener): () => void;
}

export interface UiTasksSnapshot {
  readonly tasks: readonly RuntimeTask[];
}

export interface UiAutomationSnapshot {
  readonly jobs: readonly AutomationJob[];
  readonly runs: readonly AutomationRun[];
  readonly totalJobs: number;
  readonly totalRuns: number;
  readonly activeRunIds: readonly string[];
  readonly totalFailed: number;
  readonly sourceCount: number;
  readonly deliveryTotals: {
    readonly succeeded: number;
    readonly failed: number;
    readonly deadLettered: number;
  };
}

export interface UiRoutesSnapshot {
  readonly bindings: readonly AutomationRouteBinding[];
  readonly bindingIdsBySurface: Readonly<Record<string, readonly string[]>>;
  readonly totalBindings: number;
  readonly activeBindingIds: readonly string[];
  readonly totalResolved: number;
  readonly totalFailures: number;
}

export interface UiWatchersSnapshot {
  readonly watchers: readonly WatcherRecord[];
  readonly totalWatchers: number;
  readonly activeWatcherIds: readonly string[];
  readonly totalDegraded: number;
  readonly totalLagged: number;
}

export interface UiOrchestrationSnapshot {
  readonly graphs: readonly OrchestrationGraphRecord[];
  readonly totalGraphs: number;
  readonly activeGraphIds: readonly string[];
  readonly totalCompletedGraphs: number;
  readonly totalFailedGraphs: number;
  readonly recursionGuardTrips: number;
}

export interface UiCommunicationSnapshot {
  readonly records: readonly RuntimeCommunicationRecord[];
  readonly totalSent: number;
  readonly totalDelivered: number;
  readonly totalBlocked: number;
}

export interface UiControlPlaneSnapshot {
  readonly connectionState: string;
  readonly activeClientIds: readonly string[];
  readonly requestCount: number;
  readonly errorCount: number;
  readonly host: string;
  readonly port: number;
  readonly clients: readonly ControlPlaneClientRecord[];
  readonly approvals: readonly SharedApprovalRecord[];
  readonly sessions: readonly SharedSessionRecord[];
  readonly recentEvents: readonly ControlPlaneRecentEvent[];
}

export interface UiRemoteSnapshot {
  readonly daemon: {
    readonly transportState: string;
    readonly isRunning: boolean;
    readonly reconnectAttempts: number;
    readonly runningJobCount: number;
    readonly lastError?: string;
  };
  readonly acp: {
    readonly transportState: string;
    readonly totalMessages: number;
    readonly activeConnections: readonly AcpConnection[];
  };
  readonly pools: ReturnType<RuntimeServices['remoteRunnerRegistry']['listPools']>;
  readonly contracts: ReturnType<RuntimeServices['remoteRunnerRegistry']['listContracts']>;
  readonly artifacts: ReturnType<RuntimeServices['remoteRunnerRegistry']['listArtifacts']>;
  readonly supervisor: RemoteSupervisorSnapshot;
  readonly distributed: {
    readonly pairRequests: readonly DistributedRuntimePairRequest[];
    readonly peers: readonly DistributedPeerRecord[];
    readonly work: readonly DistributedPendingWork[];
  };
}

export interface UiIntelligenceSnapshot {
  readonly diagnosticsStatus: string;
  readonly symbolSearchStatus: string;
  readonly completionsStatus: string;
  readonly hoverStatus: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly totalRequests: number;
  readonly avgLatencyMs: number;
  readonly hover: {
    readonly active: boolean;
    readonly filePath?: string;
  };
  readonly diagnostics: ReadonlyMap<string, readonly LspDiagnostic[]>;
}

export interface UiMarketplaceSnapshot {
  readonly startupIssues: readonly string[];
  readonly recommendations: readonly EcosystemRecommendation[];
}

export interface UiCockpitSnapshot {
  readonly runningTasks: number;
  readonly blockedTasks: number;
  readonly failedTasks: number;
  readonly activeGraphs: number;
  readonly guardTrips: number;
  readonly blockedMessages: number;
  readonly pendingPermissions: number;
  readonly deniedPermissions: number;
  readonly preflightStatus: string;
  readonly preflightIssueCount: number;
  readonly lintFindingCount: number;
  readonly tokenBlockedCount: number;
  readonly tokenRotationOverdueCount: number;
  readonly tokenScopeViolationCount: number;
  readonly tokenRotationWarningCount: number;
  readonly incidentCount: number;
  readonly latestIncident: ReturnType<ForensicsRegistry['latest']>;
  readonly elevatedMcp: number;
  readonly unhealthyMcp: number;
  readonly erroredPlugins: number;
  readonly failingIntegrations: number;
  readonly taskCount: number;
  readonly agentCount: number;
  readonly totalGraphs: number;
  readonly communicationCount: number;
  readonly mcpServerCount: number;
  readonly pluginCount: number;
}

export interface UiSecuritySnapshot {
  readonly audit: SecurityPanelSnapshot;
  readonly policy: {
    readonly preflightStatus: string;
    readonly preflightIssueCount: number;
    readonly lintFindingCount: number;
  };
  readonly deniedPermissions: number;
  readonly incidents: ReturnType<ForensicsRegistry['getAll']>;
  readonly latestIncident: ReturnType<ForensicsRegistry['latest']>;
  readonly mcpServers: readonly McpSecuritySnapshot[];
  readonly recentMcpDecisions: readonly McpDecisionRecord[];
  readonly attackPathReview: ReturnType<typeof buildMcpAttackPathReview>;
  readonly plugins: readonly PluginStatus[];
  readonly quarantinedPlugins: readonly PluginStatus[];
  readonly untrustedPlugins: readonly PluginStatus[];
}

export interface UiHealthSnapshot {
  readonly degradedDomains: readonly string[];
  readonly providerProblems: readonly string[];
  readonly degradedMcpServers: readonly string[];
  readonly quarantinedMcpServers: readonly string[];
  readonly integrationProblems: readonly string[];
  readonly daemonTransportState: string;
  readonly acpTransportState: string;
  readonly recoveryState: string;
}

export interface UiMcpServerSnapshot {
  readonly name: string;
  readonly role: string;
  readonly trustMode: string;
  readonly status: string;
  readonly schemaFreshness: string;
  readonly toolCount: number;
  readonly lastError?: string;
  readonly quarantineReason?: string;
  readonly quarantineDetail?: string;
}

export interface UiMcpSnapshot {
  readonly servers: readonly UiMcpServerSnapshot[];
  readonly connectedServerNames: readonly string[];
  readonly availableToolCount: number;
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly recentDecisions: readonly McpDecisionRecord[];
}

export interface UiLocalAuthSnapshot {
  readonly bootstrapCredentialPresent: boolean;
  readonly userCount: number;
  readonly sessionCount: number;
}

export interface UiSettingsSnapshot {
  readonly available: boolean;
  readonly conflictCount: number;
  readonly recentFailureCount: number;
  readonly managedLockCount: number;
  readonly hasStagedManagedBundle: boolean;
}

export interface UiContinuitySnapshot {
  readonly sessionId: string;
  readonly status: string;
  readonly recoveryState: string;
  readonly lastSessionPointer: string | null;
  readonly recoveryFilePresent: boolean;
  readonly recoveryFile: Record<string, unknown> | null;
  readonly returnContext?: SessionReturnContextSummary;
}

export interface UiWorktreeSnapshot {
  readonly summary: {
    readonly total: number;
    readonly active: number;
    readonly paused: number;
    readonly cleanupPending: number;
    readonly discard: number;
  };
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface UiProvidersSnapshot {
  readonly providerIds: readonly string[];
}

export interface UiSessionSnapshot {
  readonly session: SessionDomainState;
  readonly totalTurns: number;
  readonly messageCount: number;
  readonly estimatedContextTokens: number;
  readonly contextWindow: number;
  readonly turnState: TurnState;
  readonly streamToolPreview?: string;
  readonly contextWarningActive: boolean;
  readonly pendingApproval: boolean;
  readonly denialCount: number;
}

export interface UiAgentsSnapshot {
  readonly active: readonly RuntimeAgent[];
  readonly totalSpawned: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
}

export interface UiReadModels {
  readonly providers: UiReadModel<UiProvidersSnapshot>;
  readonly session: UiReadModel<UiSessionSnapshot>;
  readonly agents: UiReadModel<UiAgentsSnapshot>;
  readonly tasks: UiReadModel<UiTasksSnapshot>;
  readonly automation: UiReadModel<UiAutomationSnapshot>;
  readonly routes: UiReadModel<UiRoutesSnapshot>;
  readonly watchers: UiReadModel<UiWatchersSnapshot>;
  readonly orchestration: UiReadModel<UiOrchestrationSnapshot>;
  readonly communication: UiReadModel<UiCommunicationSnapshot>;
  readonly controlPlane: UiReadModel<UiControlPlaneSnapshot>;
  readonly remote: UiReadModel<UiRemoteSnapshot>;
  readonly intelligence: UiReadModel<UiIntelligenceSnapshot>;
  readonly marketplace: UiReadModel<UiMarketplaceSnapshot>;
  readonly cockpit: UiReadModel<UiCockpitSnapshot>;
  readonly security: UiReadModel<UiSecuritySnapshot>;
  readonly health: UiReadModel<UiHealthSnapshot>;
  readonly mcp: UiReadModel<UiMcpSnapshot>;
  readonly localAuth: UiReadModel<UiLocalAuthSnapshot>;
  readonly settings: UiReadModel<UiSettingsSnapshot>;
  readonly continuity: UiReadModel<UiContinuitySnapshot>;
  readonly worktrees: UiReadModel<UiWorktreeSnapshot>;
}

export interface UiReadModelOptions {
  readonly forensicsRegistry?: ForensicsRegistry;
  readonly getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
}

export function createUiReadModels(
  runtimeServices: RuntimeServices,
  options: UiReadModelOptions = {},
): UiReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    providers: {
      getSnapshot() {
        return {
          providerIds: listProviderIds(runtimeServices),
        };
      },
      subscribe(listener) {
        return runtimeServices.runtimeBus.on('PROVIDERS_CHANGED', listener);
      },
    },
    session: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      return {
        session: state.session,
        totalTurns: state.conversation.totalTurns,
        messageCount: state.conversation.messageCount,
        estimatedContextTokens: state.conversation.estimatedContextTokens,
        contextWindow: state.model.tokenLimits.contextWindow,
        turnState: state.conversation.turnState,
        streamToolPreview: state.conversation.stream.partialToolPreview,
        contextWarningActive: state.conversation.contextWarningActive,
        pendingApproval: state.permissions.awaitingDecision,
        denialCount: state.permissions.denialCount,
      };
    }),
    agents: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().agents;
      const active = state.activeAgentIds
        .map((id) => state.agents.get(id))
        .filter((agent): agent is RuntimeAgent => agent !== undefined);
      return {
        active,
        totalSpawned: state.totalSpawned,
        totalCompleted: state.totalCompleted,
        totalFailed: state.totalFailed,
      };
    }),
    tasks: createStoreBackedReadModel(runtimeServices, () => {
      const tasksState = runtimeStore.getState().tasks;
      const tasks = [...tasksState.tasks.values()].sort((a, b) => {
        const aTime = a.startedAt ?? a.queuedAt;
        const bTime = b.startedAt ?? b.queuedAt;
        return bTime - aTime || a.title.localeCompare(b.title);
      });
      return { tasks };
    }),
    automation: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const jobs = state.automation.jobIds
        .map((id) => state.automation.jobs.get(id))
        .filter((job): job is AutomationJob => job !== undefined)
        .sort((a, b) => (b.nextRunAt ?? 0) - (a.nextRunAt ?? 0) || a.name.localeCompare(b.name));
      const runs = state.automation.runIds
        .map((id) => state.automation.runs.get(id))
        .filter((run): run is AutomationRun => run !== undefined)
        .sort((a, b) => b.queuedAt - a.queuedAt || a.id.localeCompare(b.id));
      return {
        jobs,
        runs,
        totalJobs: state.automation.totalJobs,
        totalRuns: state.automation.totalRuns,
        activeRunIds: state.automation.activeRunIds,
        totalFailed: state.automation.totalFailed,
        sourceCount: state.automation.sourceIds.length,
        deliveryTotals: {
          succeeded: state.deliveries.totalSucceeded,
          failed: state.deliveries.totalFailed,
          deadLettered: state.deliveries.totalDeadLettered,
        },
      };
    }),
    routes: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().routes;
      const bindings = state.bindingIds
        .map((id) => state.bindings.get(id))
        .filter((binding): binding is AutomationRouteBinding => binding !== undefined)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
      return {
        bindings,
        bindingIdsBySurface: state.bindingIdsBySurface,
        totalBindings: state.totalBindings,
        activeBindingIds: state.activeBindingIds,
        totalResolved: state.totalResolved,
        totalFailures: state.totalFailures,
      };
    }),
    watchers: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().watchers;
      const watchers = state.watcherIds
        .map((id) => state.watchers.get(id))
        .filter((watcher): watcher is WatcherRecord => watcher !== undefined)
        .sort((a, b) => (b.lastHeartbeatAt ?? 0) - (a.lastHeartbeatAt ?? 0) || a.id.localeCompare(b.id));
      return {
        watchers,
        totalWatchers: state.watcherIds.length,
        activeWatcherIds: state.activeWatcherIds,
        totalDegraded: state.totalDegraded,
        totalLagged: state.totalLagged,
      };
    }),
    orchestration: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().orchestration;
      const graphs = [...state.graphs.values()].sort((a, b) => b.createdAt - a.createdAt);
      return {
        graphs,
        totalGraphs: state.totalGraphs,
        activeGraphIds: state.activeGraphIds,
        totalCompletedGraphs: state.totalCompletedGraphs,
        totalFailedGraphs: state.totalFailedGraphs,
        recursionGuardTrips: state.recursionGuardTrips,
      };
    }),
    communication: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().communication;
      const records = state.recentRecordIds
        .map((id) => state.records.get(id))
        .filter((record): record is RuntimeCommunicationRecord => record !== undefined)
        .sort((a, b) => b.timestamp - a.timestamp);
      return {
        records,
        totalSent: state.totalSent,
        totalDelivered: state.totalDelivered,
        totalBlocked: state.totalBlocked,
      };
    }),
    controlPlane: {
      getSnapshot() {
        const state = runtimeStore.getState().controlPlane;
        const clients = state.clientIds
          .map((id) => state.clients.get(id))
          .filter((client): client is ControlPlaneClientRecord => client !== undefined)
          .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
        return {
          connectionState: state.connectionState,
          activeClientIds: state.activeClientIds,
          requestCount: state.requestCount,
          errorCount: state.errorCount,
          host: state.host,
          port: state.port,
          clients,
          approvals: runtimeServices.approvalBroker.listApprovals(6),
          sessions: runtimeServices.sessionBroker.listSessions(6),
          recentEvents: options.getControlPlaneRecentEvents?.(6) ?? [],
        };
      },
      subscribe(listener) {
        const unsubs = [
          runtimeStore.subscribe(listener),
          runtimeServices.approvalBroker.subscribe(listener),
        ];
        return combineSubscriptions(...unsubs);
      },
    },
    remote: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const distributedRaw = runtimeServices.distributedRuntime.getSnapshot() as {
        pairRequests?: readonly DistributedRuntimePairRequest[];
        peers?: readonly DistributedPeerRecord[];
        work?: readonly DistributedPendingWork[];
      };
      return {
        daemon: {
          transportState: state.daemon.transportState,
          isRunning: state.daemon.isRunning,
          reconnectAttempts: state.daemon.reconnectAttempts,
          runningJobCount: state.daemon.runningJobCount,
          lastError: state.daemon.lastError,
        },
        acp: {
          transportState: state.acp.managerTransportState,
          totalMessages: state.acp.totalMessages,
          activeConnections: state.acp.activeConnectionIds
            .map((id) => state.acp.connections.get(id))
            .filter((connection): connection is AcpConnection => connection !== undefined),
        },
        pools: runtimeServices.remoteRunnerRegistry.listPools(),
        contracts: runtimeServices.remoteRunnerRegistry.listContracts(),
        artifacts: runtimeServices.remoteRunnerRegistry.listArtifacts(),
        supervisor: runtimeServices.remoteSupervisor.getSnapshot(runtimeStore),
        distributed: {
          pairRequests: distributedRaw.pairRequests ?? [],
          peers: distributedRaw.peers ?? [],
          work: distributedRaw.work ?? [],
        },
      };
    }),
    intelligence: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().intelligence;
      return {
        diagnosticsStatus: state.diagnosticsStatus,
        symbolSearchStatus: state.symbolSearchStatus,
        completionsStatus: state.completionsStatus,
        hoverStatus: state.hoverStatus,
        errorCount: state.errorCount,
        warningCount: state.warningCount,
        totalRequests: state.totalRequests,
        avgLatencyMs: state.avgLatencyMs,
        hover: {
          active: state.hover.active,
          filePath: state.hover.filePath,
        },
        diagnostics: state.diagnostics,
      };
    }),
    marketplace: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const startupIssues: string[] = [];
      if (state.permissions.denialCount >= 3) {
        startupIssues.push(`${state.permissions.denialCount} permission denials suggest a policy-pack or trust posture review.`);
      }
      const authRequiredServers = [...state.mcp.servers.values()].filter((server) => server.status === 'auth_required');
      if (authRequiredServers.length > 0) {
        startupIssues.push(`${authRequiredServers.length} MCP server${authRequiredServers.length === 1 ? '' : 's'} need auth or reconnect repair.`);
      }
      const staleSchemas = [...state.mcp.servers.values()].filter((server) => server.schemaFreshness !== 'fresh');
      if (staleSchemas.length > 0) {
        startupIssues.push(`${staleSchemas.length} MCP server schema${staleSchemas.length === 1 ? ' is' : 's are'} stale or quarantined.`);
      }
      return {
        startupIssues,
        recommendations: buildEcosystemRecommendations(runtimeStore, {
          cwd: runtimeServices.shellPaths.workingDirectory,
          homeDir: runtimeServices.shellPaths.homeDirectory,
        }),
      };
    }),
    cockpit: {
      getSnapshot() {
        const state = runtimeStore.getState();
        const runningTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'running').length;
        const blockedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'blocked').length;
        const failedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'failed').length;
        const audit = runtimeServices.tokenAuditor.auditAll();
        const incidents = options.forensicsRegistry?.getAll() ?? [];
        const plugins = runtimeServices.pluginManager.list();
        const failingIntegrations = [...state.integrations.integrations.values()].filter((record) => record.status === 'error').length;
        const elevatedMcp = [...state.mcp.servers.values()].filter((server) => server.trustMode === 'allow-all').length;
        const unhealthyMcp = [...state.mcp.servers.values()].filter((server) => (
          server.status === 'degraded'
          || server.status === 'auth_required'
          || server.status === 'reconnecting'
          || server.status === 'disconnected'
        )).length;
        const preflight = runtimeServices.policyRuntimeState.getSnapshot().lastPreflightReview;
        const lintFindingCount = runtimeServices.policyRuntimeState.getSnapshot().lintFindings.length;
        return {
          runningTasks,
          blockedTasks,
          failedTasks,
          activeGraphs: state.orchestration.activeGraphIds.length,
          guardTrips: state.orchestration.recursionGuardTrips,
          blockedMessages: state.communication.totalBlocked,
          pendingPermissions: state.permissions.awaitingDecision ? 1 : 0,
          deniedPermissions: state.permissions.denialCount,
          preflightStatus: preflight?.status ?? 'n/a',
          preflightIssueCount: preflight?.issueCount ?? 0,
          lintFindingCount,
          tokenBlockedCount: audit.blocked.length,
          tokenRotationOverdueCount: audit.rotationOverdue.length,
          tokenScopeViolationCount: audit.scopeViolations.length,
          tokenRotationWarningCount: audit.rotationWarnings.length,
          incidentCount: incidents.length,
          latestIncident: options.forensicsRegistry?.latest(),
          elevatedMcp,
          unhealthyMcp,
          erroredPlugins: plugins.filter((plugin) => plugin.quarantined || !plugin.active).length,
          failingIntegrations,
          taskCount: state.tasks.tasks.size,
          agentCount: state.agents.agents.size,
          totalGraphs: state.orchestration.totalGraphs,
          communicationCount: state.communication.records.size,
          mcpServerCount: state.mcp.servers.size,
          pluginCount: plugins.length,
        };
      },
      subscribe(listener) {
        const unsubs: Array<() => void> = [runtimeStore.subscribe(listener)];
        if (options.forensicsRegistry) {
          unsubs.push(options.forensicsRegistry.subscribe(listener));
        }
        return combineSubscriptions(...unsubs);
      },
    },
    security: {
      getSnapshot() {
        const audit = runtimeServices.tokenAuditor.auditAll(Date.now());
        const mcpServers = [...runtimeStore.getState().mcp.servers.values()].map((server): McpSecuritySnapshot => ({
          name: server.name,
          role: server.role,
          trustMode: server.trustMode,
          allowedPaths: server.allowedPaths,
          allowedHosts: server.allowedHosts,
          schemaFreshness: server.schemaFreshness,
          quarantineReason: server.quarantineReason,
          quarantineDetail: server.quarantineDetail,
          connected: server.status === 'connected' || server.status === 'degraded',
        }));
        const recentMcpDecisions = runtimeServices.mcpRegistry.listRecentSecurityDecisions(8);
        const attackPathReview = buildMcpAttackPathReview({
          servers: mcpServers,
          recentDecisions: recentMcpDecisions,
        });
        const plugins = runtimeServices.pluginManager.list();
        const policySnapshot = runtimeServices.policyRuntimeState.getSnapshot();
        const snapshot: SecurityPanelSnapshot = {
          managed: runtimeServices.tokenAuditor.isManaged,
          totalTokens: runtimeServices.tokenAuditor.tokenCount,
          results: audit.results,
          blocked: audit.blocked,
          scopeViolations: audit.scopeViolations,
          rotationWarnings: audit.rotationWarnings,
          rotationOverdue: audit.rotationOverdue,
          lastAuditAt: audit.capturedAt,
          capturedAt: new Date().toISOString(),
        };
        return {
          audit: snapshot,
          policy: {
            preflightStatus: policySnapshot.lastPreflightReview?.status ?? 'n/a',
            preflightIssueCount: policySnapshot.lastPreflightReview?.issueCount ?? 0,
            lintFindingCount: policySnapshot.lintFindings.length,
          },
          deniedPermissions: runtimeStore.getState().permissions.denialCount,
          incidents: options.forensicsRegistry?.getAll() ?? [],
          latestIncident: options.forensicsRegistry?.latest(),
          mcpServers,
          recentMcpDecisions,
          attackPathReview,
          plugins,
          quarantinedPlugins: plugins.filter((plugin) => plugin.quarantined),
          untrustedPlugins: plugins.filter((plugin) => plugin.trustTier === 'untrusted'),
        };
      },
      subscribe(listener) {
        const unsubs: Array<() => void> = [
          runtimeStore.subscribe(listener),
          runtimeServices.pluginManager.subscribe(listener),
          runtimeServices.policyRuntimeState.subscribe(listener),
        ];
        if (options.forensicsRegistry) {
          unsubs.push(options.forensicsRegistry.subscribe(listener));
        }
        return combineSubscriptions(...unsubs);
      },
    },
    health: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const providerProblems = [...state.providerHealth.providers.values()]
        .filter((provider) => provider.status !== 'healthy' && provider.status !== 'unknown')
        .map((provider) => provider.providerId);
      const degradedMcpServers = [...state.mcp.servers.values()]
        .filter((server) => server.status === 'degraded' || server.status === 'auth_required' || server.schemaFreshness === 'quarantined')
        .map((server) => server.name);
      const quarantinedMcpServers = [...state.mcp.servers.values()]
        .filter((server) => server.schemaFreshness === 'quarantined')
        .map((server) => server.name);
      const degradedDomains: string[] = [];
      if (providerProblems.length > 0) degradedDomains.push('providerHealth');
      if (degradedMcpServers.length > 0) degradedDomains.push('mcp');
      if (state.integrations.problemIds.length > 0) degradedDomains.push('integrations');
      if (state.daemon.transportState === 'degraded' || state.daemon.transportState === 'terminal_failure') degradedDomains.push('daemon');
      if (state.acp.managerTransportState === 'degraded' || state.acp.managerTransportState === 'terminal_failure') degradedDomains.push('acp');
      if (state.session.recoveryState === 'failed') degradedDomains.push('session');
      return {
        degradedDomains,
        providerProblems,
        degradedMcpServers,
        quarantinedMcpServers,
        integrationProblems: state.integrations.problemIds,
        daemonTransportState: state.daemon.transportState,
        acpTransportState: state.acp.managerTransportState,
        recoveryState: state.session.recoveryState,
      };
    }),
    mcp: {
      getSnapshot() {
        const state = runtimeStore.getState().mcp;
        const servers = [...state.servers.values()]
          .map((server): UiMcpServerSnapshot => ({
            name: server.name,
            role: server.role,
            trustMode: server.trustMode,
            status: server.status,
            schemaFreshness: server.schemaFreshness,
            toolCount: server.toolCount,
            lastError: server.lastError,
            quarantineReason: server.quarantineReason,
            quarantineDetail: server.quarantineDetail,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          servers,
          connectedServerNames: state.connectedServerNames,
          availableToolCount: state.availableToolCount,
          totalCalls: state.totalCalls,
          totalErrors: state.totalErrors,
          recentDecisions: runtimeServices.mcpRegistry.listRecentSecurityDecisions(8),
        };
      },
      subscribe(listener) {
        return runtimeStore.subscribe(listener);
      },
    },
    localAuth: {
      getSnapshot() {
        const snapshot = runtimeServices.localUserAuthManager.inspect();
        return {
          bootstrapCredentialPresent: snapshot.bootstrapCredentialPresent,
          userCount: snapshot.userCount,
          sessionCount: snapshot.sessionCount,
        };
      },
      subscribe() {
        return () => {};
      },
    },
    settings: {
      getSnapshot() {
        const snapshot = runtimeServices.integrationHelpers.getSettingsSnapshot() as {
          available: boolean;
          conflicts?: readonly unknown[];
          recentFailures?: readonly unknown[];
          managedLockCount?: number;
          stagedManagedBundle?: unknown;
        };
        return {
          available: snapshot.available,
          conflictCount: snapshot.conflicts?.length ?? 0,
          recentFailureCount: snapshot.recentFailures?.length ?? 0,
          managedLockCount: snapshot.managedLockCount ?? 0,
          hasStagedManagedBundle: Boolean(snapshot.stagedManagedBundle),
        };
      },
      subscribe() {
        return () => {};
      },
    },
    continuity: createStoreBackedReadModel(runtimeServices, () => {
      const snapshot = runtimeServices.integrationHelpers.getContinuitySnapshot() as {
        sessionId: string;
        status: string;
        recoveryState: string;
        lastSessionPointer: string | null;
        recoveryFilePresent: boolean;
        recoveryFile: Record<string, unknown> | null;
        returnContext?: SessionReturnContextSummary;
      };
      return snapshot;
    }),
    worktrees: {
      getSnapshot() {
        const snapshot = runtimeServices.integrationHelpers.getWorktreeSnapshot() as {
          summary: UiWorktreeSnapshot['summary'];
          records: UiWorktreeSnapshot['records'];
        };
        return {
          summary: snapshot.summary,
          records: snapshot.records,
        };
      },
      subscribe() {
        return () => {};
      },
    },
  };
}
