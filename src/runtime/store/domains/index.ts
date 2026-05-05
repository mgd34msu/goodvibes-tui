/**
 * Barrel export for all runtime store domain types and initial state factories.
 */

export type {
  SessionRecoveryState,
  SessionStatus,
  SessionLineageEntry,
  SessionDomainState,
} from '@/runtime/index.ts';
export { createInitialSessionState } from '@/runtime/index.ts';

export type {
  ReasoningEffort,
  ProviderTier,
  ModelTokenLimits,
  FallbackChainEntry,
  ModelDomainState,
} from '@/runtime/index.ts';
export { createInitialModelState } from '@/runtime/index.ts';

export type {
  TurnState,
  ToolExecutionState,
  ActiveToolCall,
  TurnUsage,
  StreamProgress,
  ConversationDomainState,
} from '@/runtime/index.ts';
export { createInitialConversationState } from '@/runtime/index.ts';

export type {
  OverlayId,
  OverlayInstance,
  OverlayDomainState,
} from '@/runtime/index.ts';
export { createInitialOverlaysState } from '@/runtime/index.ts';

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
} from '@/runtime/index.ts';
export { createInitialPermissionsState } from '@/runtime/index.ts';

export type {
  TaskLifecycleState,
  TaskKind,
  TaskRetryPolicy,
  RuntimeTask,
  TaskDomainState,
} from '@/runtime/index.ts';
export { createInitialTasksState } from '@/runtime/index.ts';

export type {
  AgentLifecycleState,
  AgentRole,
  AgentWrfcRef,
  RuntimeAgent,
  AgentDomainState,
} from '@/runtime/index.ts';
export { createInitialAgentsState } from '@/runtime/index.ts';

export type {
  OrchestrationMode,
  OrchestrationNodeRole,
  OrchestrationNodeState,
  OrchestrationGraphState,
  OrchestrationNodeRecord,
  OrchestrationGraphRecord,
  OrchestrationDomainState,
} from '@/runtime/index.ts';
export { createInitialOrchestrationState } from '@/runtime/index.ts';

export type {
  RuntimeCommunicationRecord,
  CommunicationDomainState,
} from '@/runtime/index.ts';
export { createInitialCommunicationState } from '@/runtime/index.ts';

export type {
  ProviderStatus,
  CompositeHealthStatus,
  ProviderCallStats,
  ProviderCacheMetrics,
  ProviderHealthRecord,
  ProviderHealthDomainState,
} from '@/runtime/index.ts';
export { createInitialProviderHealthState } from '@/runtime/index.ts';

export type {
  McpServerLifecycleState,
  McpRegisteredTool,
  McpServerRecord,
  McpDomainState,
} from '@/runtime/index.ts';
export { createInitialMcpState } from '@/runtime/index.ts';

export type {
  PluginLifecycleState,
  RuntimePlugin,
  PluginDomainState,
} from '@/runtime/index.ts';
export { createInitialPluginsState } from '@/runtime/index.ts';

export type {
  DaemonTransportState,
  DaemonProcessInfo,
  DaemonJob,
  DaemonDomainState,
} from '@/runtime/index.ts';
export { createInitialDaemonState } from '@/runtime/index.ts';

export type {
  AutomationDomainState,
} from '@/runtime/index.ts';
export { createInitialAutomationState } from '@/runtime/index.ts';

export type {
  RoutesDomainState,
} from '@/runtime/index.ts';
export { createInitialRoutesState } from '@/runtime/index.ts';

export type {
  ControlPlaneClientKind,
  ControlPlaneTransportKind,
  ControlPlaneConnectionState,
  ControlPlaneClientRecord,
  ControlPlaneDomainState,
} from '@/runtime/index.ts';
export { createInitialControlPlaneState } from '@/runtime/index.ts';

export type {
  DeliveryLifecycleState,
  DeliveryDomainState,
} from '@/runtime/index.ts';
export { createInitialDeliveryState } from '@/runtime/index.ts';

export type {
  WatcherKind,
  WatcherState,
  WatcherSourceStatus,
  WatcherRecord,
  WatcherDomainState,
} from '@/runtime/index.ts';
export { createInitialWatcherState } from '@/runtime/index.ts';

export type {
  SurfaceConnectionState,
  SurfaceRecord,
  SurfaceDomainState,
} from '@/runtime/index.ts';
export { createInitialSurfaceState } from '@/runtime/index.ts';

export type {
  AcpTransportState,
  AcpConnection,
  AcpDomainState,
} from '@/runtime/index.ts';
export { createInitialAcpState } from '@/runtime/index.ts';

export type {
  IntegrationStatus,
  IntegrationCategory,
  IntegrationRecord,
  IntegrationDomainState,
} from '@/runtime/index.ts';
export { createInitialIntegrationsState } from '@/runtime/index.ts';

export type {
  TelemetryEventRecord,
  SessionMetrics,
  TraceContext,
  TelemetryDomainState,
} from '@/runtime/index.ts';
export { createInitialTelemetryState } from '@/runtime/index.ts';

export type {
  GitFileStatus,
  GitFileRecord,
  GitCommitSummary,
  GitBranchInfo,
  GitDomainState,
} from '@/runtime/index.ts';
export { createInitialGitState } from '@/runtime/index.ts';

export type {
  IndexStatus,
  LanguageServerRecord,
  FileWatcherStatus,
  DiscoveryDomainState,
} from '@/runtime/index.ts';
export { createInitialDiscoveryState } from '@/runtime/index.ts';

export type {
  IntelligenceFeatureStatus,
  LspDiagnostic,
  WorkspaceSymbol,
  IntelligenceHoverState,
  IntelligenceDomainState,
} from '@/runtime/index.ts';
export { createInitialIntelligenceState } from '@/runtime/index.ts';

export type {
  RenderBudgetStatus,
  RenderCycleRecord,
  InputLatencySample,
  UiPerfDomainState,
} from './ui-perf.ts';
export { createInitialUiPerfState } from './ui-perf.ts';
