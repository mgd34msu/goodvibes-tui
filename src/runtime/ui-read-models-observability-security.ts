import { buildMcpAttackPathReview } from '@pellux/goodvibes-sdk/platform/runtime/mcp/index';
import type { McpDecisionRecord, McpSecuritySnapshot } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';
import type { RuntimeServices } from './services.ts';
import type { UiReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-base';
import { combineSubscriptions } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-model-helpers';
import type { SecurityPanelSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/panels/security';
import type { PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins/manager';

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

export interface UiSecuritySnapshot {
  readonly audit: SecurityPanelSnapshot;
  readonly policy: {
    readonly preflightStatus: string;
    readonly preflightIssueCount: number;
    readonly lintFindingCount: number;
  };
  readonly deniedPermissions: number;
  readonly incidents: ReturnType<import('./forensics/index.ts').ForensicsRegistry['getAll']>;
  readonly latestIncident: ReturnType<import('./forensics/index.ts').ForensicsRegistry['latest']>;
  readonly mcpServers: readonly McpSecuritySnapshot[];
  readonly recentMcpDecisions: readonly McpDecisionRecord[];
  readonly attackPathReview: ReturnType<typeof buildMcpAttackPathReview>;
  readonly plugins: readonly PluginStatus[];
  readonly quarantinedPlugins: readonly PluginStatus[];
  readonly untrustedPlugins: readonly PluginStatus[];
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

export interface UiSecurityObservabilityReadModels {
  readonly security: UiReadModel<UiSecuritySnapshot>;
  readonly mcp: UiReadModel<UiMcpSnapshot>;
  readonly localAuth: UiReadModel<UiLocalAuthSnapshot>;
}

export function createSecurityObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: import('./ui-read-models-observability-options.ts').UiObservabilityReadModelOptions = {},
): UiSecurityObservabilityReadModels {
  const { runtimeStore } = runtimeServices;

  return {
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
  };
}
