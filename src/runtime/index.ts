/**
 * Runtime module barrel — re-exports all runtime subsystems.
 *
 * This is the primary entry point for consuming the runtime layer.
 * Import from '@/runtime' or '../runtime/index.ts' rather than
 * reaching into subdirectories directly.
 */

// Store
export { createRuntimeStore, createDomainDispatch } from './store/index.ts';
export type { RuntimeStore, DomainDispatch } from './store/index.ts';
export type { RuntimeState } from './store/state.ts';
export * from './store/selectors/index.ts';

// Events
export { RuntimeEventBus } from './events/index.ts';
export { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/event-envelope';
export type { EventEnvelope, EventEnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/event-envelope';
export type { RuntimeEventEnvelope, EnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './events/domain-map.ts';
export type { AnyRuntimeEvent, RuntimeEventDomain } from './events/domain-map.ts';
export { createRuntimeEventFeed, createRuntimeEventFeeds } from '@pellux/goodvibes-sdk/platform/runtime/event-feeds';
export type { RuntimeEventFeed, RuntimeEventFeeds } from '@pellux/goodvibes-sdk/platform/runtime/event-feeds';

// Emitters
export type { EmitterContext } from './emitters/index.ts';

// Health
export { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
export { CascadeEngine } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-engine';
export { CASCADE_RULES } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-rules';
export { createHealthSystem } from './health/index.ts';
export type {
  HealthStatus,
  HealthDomain as RuntimeHealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeRule,
  CascadeEffect,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from '@pellux/goodvibes-sdk/platform/runtime/health/types';

// Notifications
export { NotificationRouter, createNotificationRouter } from '@pellux/goodvibes-sdk/platform/runtime/notifications/index';
export type { Notification, NotificationLevel, NotificationTarget, DomainVerbosity, RoutingDecision } from '@pellux/goodvibes-sdk/platform/runtime/notifications/types';

// UI surfaces
export { createModelPickerData, ModelPickerDataProvider } from './ui/model-picker/index.ts';
export type { ModelPickerDataProviderOptions } from './ui/model-picker/index.ts';
export { createProviderHealthData, ProviderHealthDataProvider } from './ui/provider-health/index.ts';

// Retention
export {
  RetentionPolicy,
  SnapshotPruner,
  DEFAULT_RETENTION_CONFIG,
} from '@pellux/goodvibes-sdk/platform/runtime/retention/index';
export type {
  RetentionClass,
  RetentionClassConfig,
  RetentionConfig,
  CheckpointRecord,
  PruneOptions,
  PruneResult,
  PerClassPruneResult,
  Pruner,
  RetentionStats,
} from '@pellux/goodvibes-sdk/platform/runtime/retention/index';

// Bootstrap
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { shutdownRuntime } from './lifecycle.ts';
export { createUiRuntimeServices } from './ui-services.ts';
export type { UiRuntimeServices } from './ui-services.ts';
export {
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
} from './foundation-services.ts';
export type {
  DirectTransportServicesOptions,
  DirectTransportServices,
  OperatorClientServicesOptions,
  OperatorClientServices,
  OperatorClientReadModels,
} from './foundation-services.ts';
export { createRuntimeFoundationClients } from './foundation-clients.ts';
export type {
  RuntimeFoundationClients,
  RuntimeFoundationClientsOptions,
} from './foundation-clients.ts';
export { createOperatorClient } from './operator-client.ts';
export type { OperatorClient } from './operator-client.ts';
export { createPeerClient } from './peer-client.ts';
export type { PeerClient } from './peer-client.ts';
export { createRuntimeProviderApi } from './runtime-provider-api.ts';
export { createRuntimeKnowledgeApi } from './runtime-knowledge-api.ts';
export { createRuntimeHookApi } from './runtime-hook-api.ts';
export { createRuntimeMcpApi } from './runtime-mcp-api.ts';
export { createRuntimeOpsApi } from './runtime-ops-api.ts';
export type { OpsApi } from './ops-api.ts';
export { createDirectTransport, createDirectTransportFromServices } from './transports/direct.ts';
export { createRuntimeDirectTransport } from './transports/direct.ts';
export type { DirectTransport } from './transports/direct.ts';
export { createDirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
export type { DirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
export { createClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/client-transport';
export type { ClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/client-transport';
export { buildUrl, createTransportPaths, normalizeBaseUrl } from '@pellux/goodvibes-sdk/platform/runtime/transports/transport-paths';
export type { TransportPaths } from '@pellux/goodvibes-sdk/platform/runtime/transports/transport-paths';
export {
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/http-json-transport';
export type {
  HttpJsonRequestOptions,
  HttpJsonTransport,
  HttpJsonTransportOptions,
  JsonObject,
  JsonValue,
  ResolvedContractRequest,
  TransportJsonError,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/http-json-transport';
export {
  buildContractInput,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/contract-http-client';
export type {
  ContractInvokeOptions,
  ContractRouteDefinition,
  ContractRouteLike,
  ContractStreamOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/contract-http-client';
export { isAbortError, openServerSentEventStream } from '@pellux/goodvibes-sdk/platform/runtime/transports/sse-stream';
export type { ServerSentEventHandlers, ServerSentEventOptions } from '@pellux/goodvibes-sdk/platform/runtime/transports/sse-stream';
export { createOperatorRemoteClient } from '@pellux/goodvibes-sdk/platform/runtime/transports/operator-remote-client';
export type {
  OperatorRemoteClient,
  OperatorRemoteClientInvokeOptions,
  OperatorRemoteClientStreamOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/operator-remote-client';
export { createPeerRemoteClient } from '@pellux/goodvibes-sdk/platform/runtime/transports/peer-remote-client';
export type {
  PeerRemoteClient,
  PeerRemoteClientInvokeOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/peer-remote-client';
export {
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createRemoteUiRuntimeEvents,
  createWebSocketConnector,
} from './transports/remote-events.ts';
export type {
  DomainEventConnector,
  RemoteDomainEvents,
  RemoteRuntimeEvents,
  SerializedRuntimeEnvelope,
} from './transports/remote-events.ts';

// Network
export * from './network/index.ts';
