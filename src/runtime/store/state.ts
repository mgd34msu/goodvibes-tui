/**
 * RuntimeState, the canonical top-level state shape for the goodvibes-tui
 * runtime store. All domain slices are defined here.
 *
 * Each domain includes revision, lastUpdatedAt, and source metadata fields.
 * These are defined per-domain in the domain files.
 */

import type { SessionDomainState } from '@/runtime/index.ts';
import type { ModelDomainState } from '@/runtime/index.ts';
import type { ConversationDomainState } from '@/runtime/index.ts';
import type { OverlayDomainState } from '@/runtime/index.ts';
import type { PanelDomainState } from './domains/panels.ts';
import type { PermissionDomainState } from '@/runtime/index.ts';
import type { TaskDomainState } from '@/runtime/index.ts';
import type { AgentDomainState } from '@/runtime/index.ts';
import type { OrchestrationDomainState } from '@/runtime/index.ts';
import type { CommunicationDomainState } from '@/runtime/index.ts';
import type { ProviderHealthDomainState } from '@/runtime/index.ts';
import type { McpDomainState } from '@/runtime/index.ts';
import type { PluginDomainState } from '@/runtime/index.ts';
import type { DaemonDomainState } from '@/runtime/index.ts';
import type { AutomationDomainState } from '@/runtime/index.ts';
import type { AcpDomainState } from '@/runtime/index.ts';
import type { RoutesDomainState } from '@/runtime/index.ts';
import type { ControlPlaneDomainState } from '@/runtime/index.ts';
import type { DeliveryDomainState } from '@/runtime/index.ts';
import type { WatcherDomainState } from '@/runtime/index.ts';
import type { SurfaceDomainState } from '@/runtime/index.ts';
import type { IntegrationDomainState } from '@/runtime/index.ts';
import type { TelemetryDomainState } from '@/runtime/index.ts';
import type { GitDomainState } from '@/runtime/index.ts';
import type { DiscoveryDomainState } from '@/runtime/index.ts';
import type { IntelligenceDomainState } from '@/runtime/index.ts';
import type { UiPerfDomainState } from './domains/ui-perf.ts';
// UiPerfDomainState is structurally identical to SDK's SurfacePerfDomainState.
// Export as SurfacePerfDomainState alias for SDK compatibility.
export type { UiPerfDomainState };

import { createInitialSessionState } from '@/runtime/index.ts';
import { createInitialModelState } from '@/runtime/index.ts';
import { createInitialConversationState } from '@/runtime/index.ts';
import { createInitialOverlaysState } from '@/runtime/index.ts';
import { createInitialPanelsState } from './domains/panels.ts';
import { createInitialPermissionsState } from '@/runtime/index.ts';
import { createInitialTasksState } from '@/runtime/index.ts';
import { createInitialAgentsState } from '@/runtime/index.ts';
import { createInitialOrchestrationState } from '@/runtime/index.ts';
import { createInitialCommunicationState } from '@/runtime/index.ts';
import { createInitialProviderHealthState } from '@/runtime/index.ts';
import { createInitialMcpState } from '@/runtime/index.ts';
import { createInitialPluginsState } from '@/runtime/index.ts';
import { createInitialDaemonState } from '@/runtime/index.ts';
import { createInitialAutomationState } from '@/runtime/index.ts';
import { createInitialAcpState } from '@/runtime/index.ts';
import { createInitialRoutesState } from '@/runtime/index.ts';
import { createInitialControlPlaneState } from '@/runtime/index.ts';
import { createInitialDeliveryState } from '@/runtime/index.ts';
import { createInitialWatcherState } from '@/runtime/index.ts';
import { createInitialSurfaceState } from '@/runtime/index.ts';
import { createInitialIntegrationsState } from '@/runtime/index.ts';
import { createInitialTelemetryState } from '@/runtime/index.ts';
import { createInitialGitState } from '@/runtime/index.ts';
import { createInitialDiscoveryState } from '@/runtime/index.ts';
import { createInitialIntelligenceState } from '@/runtime/index.ts';
import { createInitialUiPerfState } from './domains/ui-perf.ts';

/**
 * RuntimeState, the complete state shape managed by the runtime store.
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
