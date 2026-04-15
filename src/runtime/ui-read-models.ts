export type { UiReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-base';
export type {
  UiCoreReadModels,
  UiProvidersSnapshot,
  UiSessionSnapshot,
  UiAgentsSnapshot,
  UiTasksSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-core';
export type {
  UiOperationsReadModels,
  UiAutomationSnapshot,
  UiRoutesSnapshot,
  UiWatchersSnapshot,
  UiOrchestrationSnapshot,
  UiCommunicationSnapshot,
  UiControlPlaneSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-operations';
export type {
  UiObservabilityReadModels,
  UiRemoteSnapshot,
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiSecuritySnapshot,
  UiHealthSnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability';
export type { UiObservabilityReadModelOptions } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability-options';

import type { RuntimeServices } from './services.ts';
import { createCoreReadModels, type UiCoreReadModels } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-core';
import {
  createOperationsReadModels,
  type UiOperationsReadModels,
  type UiOperationsReadModelOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-operations';
import {
  createObservabilityReadModels,
  type UiObservabilityReadModels,
  type UiObservabilityReadModelOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-observability';

export type UiReadModelOptions = UiOperationsReadModelOptions & UiObservabilityReadModelOptions;

export type UiReadModels = UiCoreReadModels & UiOperationsReadModels & UiObservabilityReadModels;

export function createUiReadModels(
  runtimeServices: RuntimeServices,
  options: UiReadModelOptions = {},
): UiReadModels {
  return {
    ...createCoreReadModels(runtimeServices),
    ...createOperationsReadModels(runtimeServices, options),
    ...createObservabilityReadModels(runtimeServices, options),
  };
}
