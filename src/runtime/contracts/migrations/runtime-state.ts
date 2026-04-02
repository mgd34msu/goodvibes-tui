/**
 * Compatibility Contracts — RuntimeState Migrations
 *
 * Migration steps for the top-level RuntimeState snapshot schema.
 * All steps are pure functions — they do not mutate their input.
 *
 * @module contracts/migrations/runtime-state
 */

import type { MigrationStep } from '../types.ts';
import { SCHEMA_VERSIONS } from '../version.ts';

/**
 * Placeholder step from v1.0.0 → v1.0.0 (identity, no structural change yet).
 *
 * When the schema is bumped to v1.1.0 or v2.0.0, add new steps here.
 * Example v1.0.0 → v1.1.0 would add a new optional field with a default.
 */

/**
 * All registered RuntimeState migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via `registerRuntimeStateMigrations`.
 */
const RUNTIME_STATE_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add optional uiSettings field with defaults',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, uiSettings: d['uiSettings'] ?? { theme: 'dark' } };
  //   },
  // },
];

/**
 * The current RuntimeState schema version (re-exported for convenience).
 */
export const RUNTIME_STATE_VERSION = SCHEMA_VERSIONS.runtimeState;

/**
 * Returns all RuntimeState migration steps.
 * Used by the contract registry during initialization.
 */
export function getRuntimeStateMigrationSteps(): MigrationStep[] {
  return RUNTIME_STATE_STEPS;
}
