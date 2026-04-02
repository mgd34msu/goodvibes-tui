/**
 * Compatibility Contracts — EventEnvelope Migrations
 *
 * Migration steps for the RuntimeEventEnvelope persistence schema.
 * All steps are pure functions — they do not mutate their input.
 *
 * @module contracts/migrations/event-envelope
 */

import type { MigrationStep } from '../types.ts';
import { SCHEMA_VERSIONS } from '../version.ts';

/**
 * All registered EventEnvelope migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `agentId` becomes required in v1.1.0, a migration step would
 * backfill it with a sentinel value for older persisted envelopes.
 */
const EVENT_ENVELOPE_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Backfill missing agentId with null sentinel',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, agentId: d['agentId'] ?? null };
  //   },
  // },
];

/**
 * The current EventEnvelope schema version (re-exported for convenience).
 */
export const EVENT_ENVELOPE_VERSION = SCHEMA_VERSIONS.eventEnvelope;

/**
 * Returns all EventEnvelope migration steps.
 * Used by the contract registry during initialization.
 */
export function getEventEnvelopeMigrationSteps(): MigrationStep[] {
  return EVENT_ENVELOPE_STEPS;
}
