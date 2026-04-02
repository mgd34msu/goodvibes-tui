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
} from './model-picker/index.ts';
export type { ProviderStatus as ModelPickerProviderStatus } from './model-picker/index.ts';
export { ModelPickerDataProvider, createModelPickerData } from './model-picker/index.ts';
export type { ModelPickerDataProviderOptions } from './model-picker/index.ts';

// ── Provider health ───────────────────────────────────────────────────────────
export type {
  HealthTimelinePoint,
  HealthTimeline,
  ProviderHealthEntry,
  FallbackChainNode,
  FallbackChainData,
  ProviderHealthData,
  CompositeHealthStatus,
} from './provider-health/index.ts';
export type { ProviderStatus } from './provider-health/index.ts';
export {
  ProviderHealthDataProvider,
  buildFallbackChainData,
  createProviderHealthData,
} from './provider-health/index.ts';
