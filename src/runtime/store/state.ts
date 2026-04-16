/**
 * RuntimeState — the canonical top-level state shape for the goodvibes-tui
 * runtime store. All domain slices are defined here.
 *
 * Each domain includes revision, lastUpdatedAt, and source metadata fields.
 * These are defined per-domain in the domain files.
 */

import type { SessionDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/session';
import type { ModelDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
import type { ConversationDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/conversation';
import type { OverlayDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/overlays';
import type { PanelDomainState } from './domains/panels.ts';
import type { PermissionDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/permissions';
import type { TaskDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { AgentDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';
import type { OrchestrationDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/orchestration';
import type { CommunicationDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';
import type { ProviderHealthDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
import type { McpDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/mcp';
import type { PluginDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';
import type { DaemonDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/daemon';
import type { AutomationDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/automation';
import type { AcpDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import type { RoutesDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/routes';
import type { ControlPlaneDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';
import type { DeliveryDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/deliveries';
import type { WatcherDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';
import type { SurfaceDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surfaces';
import type { IntegrationDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/integrations';
import type { TelemetryDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/telemetry';
import type { GitDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/git';
import type { DiscoveryDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/discovery';
import type { IntelligenceDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/intelligence';
import type { UiPerfDomainState } from './domains/ui-perf.ts';
// UiPerfDomainState is structurally identical to SDK's SurfacePerfDomainState.
// Export as SurfacePerfDomainState alias for SDK compatibility.
export type { UiPerfDomainState };

import { createInitialSessionState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/session';
import { createInitialModelState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
import { createInitialConversationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/conversation';
import { createInitialOverlaysState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/overlays';
import { createInitialPanelsState } from './domains/panels.ts';
import { createInitialPermissionsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/permissions';
import { createInitialTasksState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import { createInitialAgentsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';
import { createInitialOrchestrationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/orchestration';
import { createInitialCommunicationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';
import { createInitialProviderHealthState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
import { createInitialMcpState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/mcp';
import { createInitialPluginsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';
import { createInitialDaemonState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/daemon';
import { createInitialAutomationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/automation';
import { createInitialAcpState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import { createInitialRoutesState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/routes';
import { createInitialControlPlaneState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';
import { createInitialDeliveryState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/deliveries';
import { createInitialWatcherState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';
import { createInitialSurfaceState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surfaces';
import { createInitialIntegrationsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/integrations';
import { createInitialTelemetryState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/telemetry';
import { createInitialGitState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/git';
import { createInitialDiscoveryState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/discovery';
import { createInitialIntelligenceState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/intelligence';
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
  /**
   * TUI panel state. Typed as Record<string,unknown> for SDK RuntimeState
   * compatibility. Use selectPanels() which casts to PanelDomainState.
   */
  panels: Record<string, unknown>;
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
  /** Surface/UI performance metrics. SDK-compatible field name. */
  surfacePerf: UiPerfDomainState;
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
    panels: createInitialPanelsState() as unknown as Record<string, unknown>,
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
    surfacePerf: createInitialUiPerfState(),
  };
}
