/**
 * Runtime UI data surface barrel.
 *
 * Exports enriched data providers and one-shot factory functions for
 * the model picker and provider health surfaces.
 *
 * These modules produce structured data for renderers — no UI rendering
 * logic lives here.
 */

// ── Model picker ──────────────────────────────────────────────────────────────
export type {
  CapabilityFlags,
  ProviderLatencyStats,
  ProviderHealthContext,
  ModelPickerEntry,
  ModelPickerGroup,
  ModelPickerData,
} from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/index';
export type { ProviderStatus as ModelPickerProviderStatus } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/index';
export { ModelPickerDataProvider, createModelPickerData } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/index';
export type { ModelPickerDataProviderOptions } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/index';

// ── Provider health ───────────────────────────────────────────────────────────
export type {
  HealthTimelinePoint,
  HealthTimeline,
  ProviderHealthEntry,
  FallbackChainNode,
  FallbackChainData,
  ProviderHealthData,
  CompositeHealthStatus,
} from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/index';
export type { ProviderStatus } from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/index';
export {
  ProviderHealthDataProvider,
  buildFallbackChainData,
  createProviderHealthData,
} from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/index';
