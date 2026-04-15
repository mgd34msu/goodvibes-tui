export type { UiObservabilityReadModelOptions } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-options';
export type {
  UiRemoteSnapshot,
  UiRemoteReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-remote';
export type {
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiHealthSnapshot,
  UiSystemObservabilityReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-system';
export type {
  UiSecuritySnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSecurityObservabilityReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-security';
export type {
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
  UiMaintenanceObservabilityReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-maintenance';

import type { RuntimeServices } from './services.ts';
import { createRemoteReadModels, type UiRemoteReadModels } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-remote';
import {
  createSystemObservabilityReadModels,
  type UiSystemObservabilityReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-system';
import {
  createSecurityObservabilityReadModels,
  type UiSecurityObservabilityReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-security';
import {
  createMaintenanceObservabilityReadModels,
  type UiMaintenanceObservabilityReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-maintenance';
import type { UiObservabilityReadModelOptions } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-options';

export interface UiObservabilityReadModels
  extends UiRemoteReadModels,
    UiSystemObservabilityReadModels,
    UiSecurityObservabilityReadModels,
    UiMaintenanceObservabilityReadModels {}

export function createObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: UiObservabilityReadModelOptions = {},
): UiObservabilityReadModels {
  return {
    ...createRemoteReadModels(runtimeServices),
    ...createSystemObservabilityReadModels(runtimeServices, options),
    ...createSecurityObservabilityReadModels(runtimeServices, options),
    ...createMaintenanceObservabilityReadModels(runtimeServices),
  };
}
