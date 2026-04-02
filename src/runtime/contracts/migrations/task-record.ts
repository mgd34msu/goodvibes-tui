/**
 * Compatibility Contracts — TaskRecord Migrations
 *
 * Migration steps for the RuntimeTask record schema used in task domain
 * persistence and serialization. All steps are pure functions.
 *
 * @module contracts/migrations/task-record
 */

import type { MigrationStep } from '../types.ts';
import { SCHEMA_VERSIONS } from '../version.ts';

/**
 * All registered TaskRecord migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `metadata` map is added to RuntimeTask in v1.1.0, a migration
 * step would backfill it as an empty object for older persisted records.
 */
const TASK_RECORD_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add metadata object to task records',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, metadata: d['metadata'] ?? {} };
  //   },
  // },
];

/**
 * The current TaskRecord schema version (re-exported for convenience).
 */
export const TASK_RECORD_VERSION = SCHEMA_VERSIONS.taskRecord;

/**
 * Returns all TaskRecord migration steps.
 * Used by the contract registry during initialization.
 */
export function getTaskRecordMigrationSteps(): MigrationStep[] {
  return TASK_RECORD_STEPS;
}
