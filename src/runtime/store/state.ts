/**
 * RuntimeState — the canonical top-level state shape for the goodvibes-tui
 * runtime store. All domain slices are defined here.
 *
 * Each domain includes revision, lastUpdatedAt, and source metadata fields.
 * These are defined per-domain in the domain files.
 */

import type { SessionDomainState } from './domains/session.ts';
import type { ModelDomainState } from './domains/model.ts';
import type { ConversationDomainState } from './domains/conversation.ts';
import type { OverlayDomainState } from './domains/overlays.ts';
import type { PanelDomainState } from './domains/panels.ts';
import type { PermissionDomainState } from './domains/permissions.ts';
import type { TaskDomainState } from './domains/tasks.ts';
import type { AgentDomainState } from './domains/agents.ts';
import type { OrchestrationDomainState } from './domains/orchestration.ts';
import type { CommunicationDomainState } from './domains/communication.ts';
import type { ProviderHealthDomainState } from './domains/provider-health.ts';
import type { McpDomainState } from './domains/mcp.ts';
import type { PluginDomainState } from './domains/plugins.ts';
import type { DaemonDomainState } from './domains/daemon.ts';
import type { AutomationDomainState } from './domains/automation.ts';
import type { AcpDomainState } from './domains/acp.ts';
import type { RoutesDomainState } from './domains/routes.ts';
import type { ControlPlaneDomainState } from './domains/control-plane.ts';
import type { DeliveryDomainState } from './domains/deliveries.ts';
import type { WatcherDomainState } from './domains/watchers.ts';
import type { SurfaceDomainState } from './domains/surfaces.ts';
import type { IntegrationDomainState } from './domains/integrations.ts';
import type { TelemetryDomainState } from './domains/telemetry.ts';
import type { GitDomainState } from './domains/git.ts';
import type { DiscoveryDomainState } from './domains/discovery.ts';
import type { IntelligenceDomainState } from './domains/intelligence.ts';
import type { UiPerfDomainState } from './domains/ui-perf.ts';

import { createInitialSessionState } from './domains/session.ts';
import { createInitialModelState } from './domains/model.ts';
import { createInitialConversationState } from './domains/conversation.ts';
import { createInitialOverlaysState } from './domains/overlays.ts';
import { createInitialPanelsState } from './domains/panels.ts';
import { createInitialPermissionsState } from './domains/permissions.ts';
import { createInitialTasksState } from './domains/tasks.ts';
import { createInitialAgentsState } from './domains/agents.ts';
import { createInitialOrchestrationState } from './domains/orchestration.ts';
import { createInitialCommunicationState } from './domains/communication.ts';
import { createInitialProviderHealthState } from './domains/provider-health.ts';
import { createInitialMcpState } from './domains/mcp.ts';
import { createInitialPluginsState } from './domains/plugins.ts';
import { createInitialDaemonState } from './domains/daemon.ts';
import { createInitialAutomationState } from './domains/automation.ts';
import { createInitialAcpState } from './domains/acp.ts';
import { createInitialRoutesState } from './domains/routes.ts';
import { createInitialControlPlaneState } from './domains/control-plane.ts';
import { createInitialDeliveryState } from './domains/deliveries.ts';
import { createInitialWatcherState } from './domains/watchers.ts';
import { createInitialSurfaceState } from './domains/surfaces.ts';
import { createInitialIntegrationsState } from './domains/integrations.ts';
import { createInitialTelemetryState } from './domains/telemetry.ts';
import { createInitialGitState } from './domains/git.ts';
import { createInitialDiscoveryState } from './domains/discovery.ts';
import { createInitialIntelligenceState } from './domains/intelligence.ts';
import { createInitialUiPerfState } from './domains/ui-perf.ts';

/**
 * RuntimeState — the complete state shape managed by the runtime store.
 *
 * Domain slices, each with revision/lastUpdatedAt/source metadata.
 * All mutations must go through typed domain dispatch APIs.
 */
export interface RuntimeState {
  session: SessionDomainState;
  model: ModelDomainState;
  conversation: ConversationDomainState;
  overlays: OverlayDomainState;
  panels: PanelDomainState;
  permissions: PermissionDomainState;
  tasks: TaskDomainState;
  agents: AgentDomainState;
  orchestration: OrchestrationDomainState;
  communication: CommunicationDomainState;
  providerHealth: ProviderHealthDomainState;
  mcp: McpDomainState;
  plugins: PluginDomainState;
  daemon: DaemonDomainState;
  automation: AutomationDomainState;
  routes: RoutesDomainState;
  controlPlane: ControlPlaneDomainState;
  deliveries: DeliveryDomainState;
  watchers: WatcherDomainState;
  surfaces: SurfaceDomainState;
  acp: AcpDomainState;
  integrations: IntegrationDomainState;
  telemetry: TelemetryDomainState;
  git: GitDomainState;
  discovery: DiscoveryDomainState;
  intelligence: IntelligenceDomainState;
  uiPerf: UiPerfDomainState;
}

/**
 * Creates and returns a fully initialized RuntimeState with all domains
 * set to their default initial values.
 *
 * This is the factory used by `createRuntimeStore()` and test harnesses.
 */
export function createInitialRuntimeState(): RuntimeState {
  return {
    session: createInitialSessionState(),
    model: createInitialModelState(),
    conversation: createInitialConversationState(),
    overlays: createInitialOverlaysState(),
    panels: createInitialPanelsState(),
    permissions: createInitialPermissionsState(),
    tasks: createInitialTasksState(),
    agents: createInitialAgentsState(),
    orchestration: createInitialOrchestrationState(),
    communication: createInitialCommunicationState(),
    providerHealth: createInitialProviderHealthState(),
    mcp: createInitialMcpState(),
    plugins: createInitialPluginsState(),
    daemon: createInitialDaemonState(),
    automation: createInitialAutomationState(),
    routes: createInitialRoutesState(),
    controlPlane: createInitialControlPlaneState(),
    deliveries: createInitialDeliveryState(),
    watchers: createInitialWatcherState(),
    surfaces: createInitialSurfaceState(),
    acp: createInitialAcpState(),
    integrations: createInitialIntegrationsState(),
    telemetry: createInitialTelemetryState(),
    git: createInitialGitState(),
    discovery: createInitialDiscoveryState(),
    intelligence: createInitialIntelligenceState(),
    uiPerf: createInitialUiPerfState(),
  };
}
