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
export { createEventEnvelope } from './events/envelope.ts';
export type { RuntimeEventEnvelope, EnvelopeContext } from './events/envelope.ts';
export type { AnyRuntimeEvent, RuntimeEventDomain } from './events/domain-map.ts';

// Emitters
export type { EmitterContext } from './emitters/index.ts';

// Health
export { RuntimeHealthAggregator } from './health/aggregator.ts';
export { CascadeEngine } from './health/cascade-engine.ts';
export { CASCADE_RULES } from './health/cascade-rules.ts';
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
} from './health/types.ts';

// Notifications
export { NotificationRouter, createNotificationRouter } from './notifications/index.ts';
export type { Notification, NotificationLevel, NotificationTarget, DomainVerbosity, RoutingDecision } from './notifications/types.ts';

// UI surfaces
export { createModelPickerData, ModelPickerDataProvider } from './ui/model-picker/index.ts';
export type { ModelPickerDataProviderOptions } from './ui/model-picker/index.ts';
export { createProviderHealthData, ProviderHealthDataProvider } from './ui/provider-health/index.ts';

// Retention
export {
  RetentionPolicy,
  SnapshotPruner,
  DEFAULT_RETENTION_CONFIG,
} from './retention/index.ts';
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
} from './retention/index.ts';

// Bootstrap
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { shutdownRuntime } from './lifecycle.ts';

// Network
export * from './network/index.ts';
