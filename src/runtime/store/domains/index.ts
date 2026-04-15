/**
 * Barrel export for all runtime store domain types and initial state factories.
 */

export type {
  SessionRecoveryState,
  SessionStatus,
  SessionLineageEntry,
  SessionDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/session';
export { createInitialSessionState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/session';

export type {
  ReasoningEffort,
  ProviderTier,
  ModelTokenLimits,
  FallbackChainEntry,
  ModelDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
export { createInitialModelState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';

export type {
  TurnState,
  ToolExecutionState,
  ActiveToolCall,
  TurnUsage,
  StreamProgress,
  ConversationDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/conversation';
export { createInitialConversationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/conversation';

export type {
  OverlayId,
  OverlayInstance,
  OverlayDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/overlays';
export { createInitialOverlaysState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/overlays';

export type {
  PanelId,
  PanelPosition,
  PanelState,
  PanelDomainState,
} from './panels.ts';
export { createInitialPanelsState } from './panels.ts';

export type {
  PermissionMode,
  PermissionDecisionMachineState,
  PermissionDecisionOutcome,
  PermissionSourceLayer,
  PermissionDecisionReason,
  PermissionDecision,
  PermissionDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/permissions';
export { createInitialPermissionsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/permissions';

export type {
  TaskLifecycleState,
  TaskKind,
  TaskRetryPolicy,
  RuntimeTask,
  TaskDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
export { createInitialTasksState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';

export type {
  AgentLifecycleState,
  AgentRole,
  AgentWrfcRef,
  RuntimeAgent,
  AgentDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';
export { createInitialAgentsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';

export type {
  OrchestrationMode,
  OrchestrationNodeRole,
  OrchestrationNodeState,
  OrchestrationGraphState,
  OrchestrationNodeRecord,
  OrchestrationGraphRecord,
  OrchestrationDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/orchestration';
export { createInitialOrchestrationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/orchestration';

export type {
  RuntimeCommunicationRecord,
  CommunicationDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';
export { createInitialCommunicationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';

export type {
  ProviderStatus,
  CompositeHealthStatus,
  ProviderCallStats,
  ProviderCacheMetrics,
  ProviderHealthRecord,
  ProviderHealthDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
export { createInitialProviderHealthState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';

export type {
  McpServerLifecycleState,
  McpRegisteredTool,
  McpServerRecord,
  McpDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/mcp';
export { createInitialMcpState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/mcp';

export type {
  PluginLifecycleState,
  RuntimePlugin,
  PluginDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';
export { createInitialPluginsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';

export type {
  DaemonTransportState,
  DaemonProcessInfo,
  DaemonJob,
  DaemonDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/daemon';
export { createInitialDaemonState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/daemon';

export type {
  AutomationDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/automation';
export { createInitialAutomationState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/automation';

export type {
  RoutesDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/routes';
export { createInitialRoutesState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/routes';

export type {
  ControlPlaneClientKind,
  ControlPlaneTransportKind,
  ControlPlaneConnectionState,
  ControlPlaneClientRecord,
  ControlPlaneDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';
export { createInitialControlPlaneState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';

export type {
  DeliveryLifecycleState,
  DeliveryDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/deliveries';
export { createInitialDeliveryState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/deliveries';

export type {
  WatcherKind,
  WatcherState,
  WatcherSourceStatus,
  WatcherRecord,
  WatcherDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';
export { createInitialWatcherState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';

export type {
  SurfaceConnectionState,
  SurfaceRecord,
  SurfaceDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surfaces';
export { createInitialSurfaceState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surfaces';

export type {
  AcpTransportState,
  AcpConnection,
  AcpDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
export { createInitialAcpState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';

export type {
  IntegrationStatus,
  IntegrationCategory,
  IntegrationRecord,
  IntegrationDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/integrations';
export { createInitialIntegrationsState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/integrations';

export type {
  TelemetryEventRecord,
  SessionMetrics,
  TraceContext,
  TelemetryDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/telemetry';
export { createInitialTelemetryState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/telemetry';

export type {
  GitFileStatus,
  GitFileRecord,
  GitCommitSummary,
  GitBranchInfo,
  GitDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/git';
export { createInitialGitState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/git';

export type {
  IndexStatus,
  LanguageServerRecord,
  FileWatcherStatus,
  DiscoveryDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/discovery';
export { createInitialDiscoveryState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/discovery';

export type {
  IntelligenceFeatureStatus,
  LspDiagnostic,
  WorkspaceSymbol,
  IntelligenceHoverState,
  IntelligenceDomainState,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/intelligence';
export { createInitialIntelligenceState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/intelligence';

export type {
  RenderBudgetStatus,
  RenderCycleRecord,
  InputLatencySample,
  UiPerfDomainState,
} from './ui-perf.ts';
export { createInitialUiPerfState } from './ui-perf.ts';
