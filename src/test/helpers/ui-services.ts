// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { getTestRuntimeServices } from './runtime-services.ts';

export function createDefaultUiRuntimeServices(): UiRuntimeServices {
  return createUiRuntimeServices(getTestRuntimeServices());
}
