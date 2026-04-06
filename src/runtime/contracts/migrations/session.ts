/**
 * Compatibility Contracts — Session Migrations
 *
 * Migration steps for the session persistence format (messages + meta).
 * All steps are pure functions — they do not mutate their input.
 *
 * @module contracts/migrations/session
 */

import type { MigrationStep } from '../types.ts';
import { SCHEMA_VERSIONS } from '../version.ts';

/**
 * All registered Session migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if session files gain a `tags` array in v1.1.0, a migration step
 * would backfill it as an empty array for existing sessions.
 */
const SESSION_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add empty tags array to session meta',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     const meta = d['meta'] as Record<string, unknown>;
  //     return { ...d, meta: { ...meta, tags: meta['tags'] ?? [] } };
  //   },
  // },
];

/**
 * The current Session schema version (re-exported for convenience).
 */
export const SESSION_VERSION = SCHEMA_VERSIONS.session;

/**
 * Returns all Session migration steps.
 * Used by the contract registry during initialization.
 */
export function getSessionMigrationSteps(): MigrationStep[] {
  return SESSION_STEPS;
}
