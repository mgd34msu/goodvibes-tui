export type { UiObservabilityReadModelOptions } from './ui-read-models-observability-options.ts';
export type {
  UiRemoteSnapshot,
  UiRemoteReadModels,
} from './ui-read-models-observability-remote.ts';
export type {
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiHealthSnapshot,
  UiSystemObservabilityReadModels,
} from './ui-read-models-observability-system.ts';
export type {
  UiSecuritySnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSecurityObservabilityReadModels,
} from './ui-read-models-observability-security.ts';
export type {
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
  UiMaintenanceObservabilityReadModels,
} from './ui-read-models-observability-maintenance.ts';

import type { RuntimeServices } from './services.ts';
import { createRemoteReadModels, type UiRemoteReadModels } from './ui-read-models-observability-remote.ts';
import {
  createSystemObservabilityReadModels,
  type UiSystemObservabilityReadModels,
} from './ui-read-models-observability-system.ts';
import {
  createSecurityObservabilityReadModels,
  type UiSecurityObservabilityReadModels,
} from './ui-read-models-observability-security.ts';
import {
  createMaintenanceObservabilityReadModels,
  type UiMaintenanceObservabilityReadModels,
} from './ui-read-models-observability-maintenance.ts';
import type { UiObservabilityReadModelOptions } from './ui-read-models-observability-options.ts';

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
