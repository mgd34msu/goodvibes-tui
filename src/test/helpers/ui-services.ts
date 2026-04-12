import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { getTestRuntimeServices } from './runtime-services.ts';

export function createDefaultUiRuntimeServices(): UiRuntimeServices {
  return createUiRuntimeServices(getTestRuntimeServices());
}
